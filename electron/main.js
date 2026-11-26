'use strict';

/**
 * 智能相册 · 主进程
 * 负责：窗口、本地目录扫描、EXIF 读取、缩略图、虚拟分类数据、导出、系统交互
 */

const { execFile } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Menu, screen, protocol, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { walk, readMeta } = require('./scanner');
const { expandArchives, ARCHIVE_EXT } = require('./archive');
const { detectMotionPhoto } = require('./motion');
const { previewDoc } = require('./docpreview');

const APP_DIR = path.join(__dirname, '..');

// 数据目录：便携版写在 exe 同级的 data 目录，开发态写在项目内
const ROOT_DIR = process.env.PORTABLE_EXECUTABLE_DIR
  || (app.isPackaged ? path.dirname(process.execPath) : APP_DIR);
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache', 'thumbs');
const MOTION_CACHE = path.join(DATA_DIR, 'cache', 'motion');
const LIB_FILE = path.join(DATA_DIR, 'library.json');
const GEO_FILE = path.join(DATA_DIR, 'geo-cache.json');
const META_FILE = path.join(DATA_DIR, 'meta-cache.json');
const AI_FILE = path.join(DATA_DIR, 'ai-tags.json');
const PEOPLE_FILE = path.join(DATA_DIR, 'ai-people.json');

/** Chromium 可直接解码的图片格式，直接给 file:// 更快、更清晰 */
const DIRECT_IMAGE_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp', 'svg', 'ico', 'avif']);

let win = null;
let nightTheme = false;

const TITLEBAR_LIGHT = { color: '#FFFFFF', symbolColor: '#9B9BA1', height: 52 };
const TITLEBAR_DARK = { color: '#1F1F23', symbolColor: '#F2F2F5', height: 52 };

function applyTitleBarOverlay() {
  /* 窗口按钮已改为应用自绘；不再调用 Windows 原生覆盖层，避免夜间模式出现白块 */
}

/* ------------------------------ 本地媒体协议 ------------------------------ */
/**
 * 打包后页面来自 app.asar，Chromium 对 file:// 的 <video> 会做 URL 安全校验并直接拒绝
 * （表现为视频黑屏、实况只有封面），这里用自定义协议流式输出，支持 Range 拖动进度。
 */
protocol.registerSchemesAsPrivileged([{
  scheme: 'album-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}]);

const MEDIA_MIME = {
  /* Chromium 不认 video/quicktime，MOV 必须按 mp4 类型送出去才能解 */
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', '3gp': 'video/3gpp',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', ts: 'video/mp2t', m2ts: 'video/mp2t',
  mts: 'video/mp2t', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', f4v: 'video/x-f4v',
  rmvb: 'application/vnd.rn-realmedia-vbr', rm: 'application/vnd.rn-realmedia'
};

function mediaPathFromUrl(u) {
  try {
    const url = new URL(u);
    let p = decodeURIComponent(url.pathname || '');
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    if (process.platform === 'win32') p = p.replace(/\//g, '\\');
    return p;
  } catch {
    return '';
  }
}

function registerMediaProtocol() {
  protocol.handle('album-media', async (request) => {
    const file = mediaPathFromUrl(request.url);
    if (!file) return new Response('bad path', { status: 404 });
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) return new Response('not found', { status: 404 });
      const ext = path.extname(file).slice(1).toLowerCase();
      if (HEIF_EXT.has(ext)) {
        const conv = await heicToFile(file, 2200, 86);
        if (conv && conv.file) {
          const size = (await fs.promises.stat(conv.file)).size;
          return new Response(Readable.toWeb(fs.createReadStream(conv.file)), {
            status: 200,
            headers: {
              'Content-Type': 'image/jpeg',
              'Content-Length': String(size),
              'Cache-Control': 'max-age=86400'
            }
          });
        }
        return new Response('heic decode failed', { status: 415 });
      }
      const type = MEDIA_MIME[ext] || 'application/octet-stream';
      const total = stat.size;
      const range = request.headers.get('range');
      if (range) {
        const m = /bytes=(\d*)-(\d*)/i.exec(range);
        let start = m && m[1] ? Number(m[1]) : 0;
        let end = m && m[2] ? Number(m[2]) : total - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        end = Math.min(Number.isFinite(end) ? end : total - 1, total - 1);
        if (start > end) {
          return new Response('bad range', { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
        }
        const stream = fs.createReadStream(file, { start, end });
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            'Content-Type': type,
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(end - start + 1),
            'Cache-Control': 'no-cache'
          }
        });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file)), {
        status: 200,
        headers: {
          'Content-Type': type,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
          'Cache-Control': 'no-cache'
        }
      });
    } catch {
      return new Response('error', { status: 404 });
    }
  });
}

/* ---------------------- HEIC / HEIF 解码（独立线程 + 磁盘缓存） --------------------- */
/*
 * Chromium 自带解码器读不了 HEIF（iPhone/安卓的 .HEIC 照片），
 * 这类文件以前只能显示空白方块。这里在 worker 线程里用 libheif 的 wasm 版解码，
 * 转成 JPEG 落盘缓存，主进程与界面只读 JPEG。
 */
const HEIF_EXT = new Set(['heic', 'heif']);
const HEIC_CACHE = path.join(DATA_DIR, 'cache', 'heic');
const heicDims = new Map();      // 缓存文件 -> { w, h }
const heicInflight = new Map();  // 缓存文件 -> Promise
let heicWorker = null;
let heicSeq = 0;
const heicPending = new Map();

function ensureHeicWorker() {
  if (heicWorker) return heicWorker;
  try {
    const { Worker } = require('worker_threads');
    let file = path.join(__dirname, 'heic-worker.js');
    if (app.isPackaged) file = file.replace('app.asar', 'app.asar.unpacked');
    if (!fs.existsSync(file)) return null;
    const nm = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
      : path.join(__dirname, '..', 'node_modules');
    heicWorker = new Worker(file, { env: Object.assign({}, process.env, { ALBUM_NM: nm }) });
    heicWorker.on('message', (m) => {
      const done = heicPending.get(m.id);
      if (done) { heicPending.delete(m.id); done(m); }
    });
    heicWorker.on('error', () => { heicWorker = null; });
    heicWorker.on('exit', () => { heicWorker = null; heicPending.clear(); });
    if (heicWorker.unref) heicWorker.unref();
  } catch { heicWorker = null; }
  return heicWorker;
}

function downscaleRGBA(rgba, w, h, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  if (!(scale < 1)) return { data: rgba, width: w, height: h };
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8ClampedArray(nw * nh * 4);
  const xr = w / nw, yr = h / nh;
  for (let y = 0; y < nh; y++) {
    const row = Math.min(h - 1, Math.floor(y * yr)) * w;
    for (let x = 0; x < nw; x++) {
      const si = (row + Math.min(w - 1, Math.floor(x * xr))) * 4;
      const di = (y * nw + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}

/* worker 不可用时退回主线程解码（会略微占用主线程，但有缓存兜底） */
async function heicDecodeInline(src, out, maxSide, quality) {
  try {
    const libheif = require('libheif-js/wasm-bundle');
    const jpeg = require('jpeg-js');
    const buf = await fs.promises.readFile(src);
    const dec = new libheif.HeifDecoder();
    const imgs = dec.decode(buf);
    if (!imgs || !imgs.length) return { ok: false };
    const image = imgs[0];
    const w = image.get_width(), h = image.get_height();
    const raw = new Uint8ClampedArray(w * h * 4);
    const data = await new Promise((res, rej) => image.display({ data: raw, width: w, height: h }, (d) => (d ? res(d) : rej(new Error('display')))));
    const small = downscaleRGBA(data.data, data.width || w, data.height || h, maxSide);
    const enc = jpeg.encode({ data: Buffer.from(small.data), width: small.width, height: small.height }, quality);
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    await fs.promises.writeFile(out, enc.data);
    return { ok: true, w, h };
  } catch { return { ok: false }; }
}

async function runHeicJob(src, out, maxSide, quality) {
  const w = ensureHeicWorker();
  if (w) {
    const id = ++heicSeq;
    const res = await new Promise((resolve) => {
      heicPending.set(id, resolve);
      try { w.postMessage({ id, src, out, maxSide, quality }); } catch { heicPending.delete(id); resolve({ ok: false }); }
      setTimeout(() => {
        if (heicPending.has(id)) { heicPending.delete(id); resolve({ ok: false }); }
      }, 9000);
    });
    if (res && res.ok) return res;
  }
  return heicDecodeInline(src, out, maxSide, quality);
}

/* 把 HEIC 转成 JPEG 缓存文件，返回 { file, w, h } */
async function heicToFile(src, maxSide, quality) {
  let st;
  try { st = await fs.promises.stat(src); } catch { return null; }
  const m = Math.round(maxSide || 1600);
  const key = hashKey('heic|' + src + '|' + st.size + '|' + Math.round(st.mtimeMs) + '|' + m);
  const out = path.join(HEIC_CACHE, key + '.jpg');
  if (fs.existsSync(out)) {
    const d = heicDims.get(out);
    return { file: out, w: d ? d.w : 0, h: d ? d.h : 0 };
  }
  if (heicInflight.has(out)) return heicInflight.get(out);
  const job = (async () => {
    try {
      const r = await runHeicJob(src, out, m, quality || 84);
      if (r && r.ok) {
        heicDims.set(out, { w: r.w, h: r.h });
        return { file: out, w: r.w, h: r.h };
      }
      return null;
    } finally {
      heicInflight.delete(out);
    }
  })();
  heicInflight.set(out, job);
  return job;
}

// 部分虚拟机 / 远程桌面下 GPU 合成会导致窗口白屏，禁用硬件加速更稳
try { app.disableHardwareAcceleration(); } catch { /* ignore */ }

/* ------------------------------ 元数据磁盘缓存 ----------------------------- */
/**
 * 一万多张图每次打开都重新解析 EXIF 会卡住好几秒，
 * 这里按「路径|大小|修改时间」缓存拍摄时间与 GPS，没改动的文件直接复用。
 */
let metaCache = null;
let metaCacheDirty = false;
let metaSaveTimer = null;

function metaKeyOf(p, size, mtime) {
  return p + '|' + (size || 0) + '|' + Math.round(mtime || 0);
}

function getMetaCache() {
  if (!metaCache) metaCache = readJson(META_FILE, null) || {};
  return metaCache;
}

function saveMetaCacheSoon() {
  if (!metaCacheDirty) return;
  clearTimeout(metaSaveTimer);
  metaSaveTimer = setTimeout(() => {
    try {
      const c = getMetaCache();
      const keys = Object.keys(c);
      // 防止无限增长：超过 20 万条时丢掉最早的 4 万条
      if (keys.length > 200000) {
        for (let i = 0; i < 40000; i++) delete c[keys[i]];
      }
      writeJson(META_FILE, c);
      metaCacheDirty = false;
    } catch { /* ignore */ }
  }, 1500);
}

/* ---------------------------------- 基础 ---------------------------------- */

function ensureDirs() {
  for (const dir of [DATA_DIR, CACHE_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
}

function fileUrl(p) {
  try { return pathToFileURL(p).href; } catch { return ''; }
}

function hashKey(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex');
}

function createWindow() {
  const disp = screen.getPrimaryDisplay();
  const scale = Number(disp.scaleFactor) || 1;
  const wa = disp.workAreaSize;
  /* workAreaSize 在高 DPI 下可能是物理像素，换成 DIP 再决定窗口大小，避免窗口超出屏幕 */
  const waW = Math.round(wa.width / scale);
  const waH = Math.round(wa.height / scale);
  const W = Math.max(900, Math.min(1360, waW - 32));
  const H = Math.max(600, Math.min(880, waH - 32));

  win = new BrowserWindow({
    width: W,
    height: H,
    minWidth: Math.min(1040, W),
    minHeight: Math.min(620, H),
    show: false,
    backgroundColor: '#ffffff',
    title: 'Luma · 智能相册',
    titleBarStyle: 'hidden',
    /* 窗口按钮改为应用自绘，避免 Windows 原生按钮在夜间模式变成刺眼的大白块 */
    frame: false,
    hasShadow: true,
    titleBarOverlay: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      plugins: true,
      spellcheck: false
    }
  });

  win.loadFile(path.join(APP_DIR, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  /* Windows 实时缩放时强制窗口底色为白，减少拖边框时出现的黑色残影 */
  const paintWhite = () => { try { if (win && !win.isDestroyed()) win.setBackgroundColor('#FFFFFF'); } catch { /* ignore */ } };
  try { if (win.setBackgroundMaterial) win.setBackgroundMaterial('none'); } catch { /* ignore */ }
  win.on('will-resize', paintWhite);
  win.on('resize', paintWhite);
  win.on('resized', paintWhite);
  win.on('maximize', paintWhite);
  win.on('unmaximize', paintWhite);
  win.on('restore', paintWhite);
  const sendWinState = () => {
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.send('album:winState', { maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
      }
    } catch { /* ignore */ }
  };
  win.on('maximize', sendWinState);
  win.on('unmaximize', sendWinState);
  win.on('enter-full-screen', sendWinState);
  win.on('leave-full-screen', sendWinState);
  setTimeout(paintWhite, 0);
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => { if (win && !win.isVisible()) win.show(); }, 200);
  });


  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error('[did-fail-load]', code, desc, url);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    console.error('[render-process-gone]', JSON.stringify(details));
  });
  win.webContents.on('preload-error', (e, p, err) => {
    console.error('[preload-error]', p, err && err.message);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* --------------------------------- 数据文件 -------------------------------- */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------------------------------- 地理 ---------------------------------- */

let geoCache = {};
function loadGeo() {
  geoCache = readJson(GEO_FILE, {});
}
let geoTimer = null;
function saveGeoSoon() {
  clearTimeout(geoTimer);
  geoTimer = setTimeout(() => {
    try { writeJson(GEO_FILE, geoCache); } catch { /* ignore */ }
  }, 1500);
}

/** 反向地理编码（离线时静默降级为经纬度） */
async function resolvePlace(lat, lon) {
  const key = `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
  if (geoCache[key]) return geoCache[key];
  try {
    const url = 'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude='
      + encodeURIComponent(lat) + '&longitude=' + encodeURIComponent(lon) + '&localityLanguage=zh';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SmartAlbum/1.0 (local desktop app)' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return null;
    const j = await res.json();
    const parts = [j.principalSubdivision, j.city, j.locality]
      .map((s) => (s ? String(s).trim() : ''))
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    if (!parts.length) return null;
    const place = parts.join(' · ');
    geoCache[key] = place;
    saveGeoSoon();
    return place;
  } catch {
    return null;
  }
}

/* ---------------------------------- 扫描 ---------------------------------- */

async function mapLimit(list, limit, fn, onProgress) {
  let cursor = 0;
  let done = 0;
  const runners = [];
  const run = async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      try { await fn(list[idx], idx); } catch { /* ignore */ }
      done += 1;
      if (onProgress && (done % 25 === 0 || done === list.length)) onProgress(done, list.length);
    }
  };
  for (let i = 0; i < Math.min(limit, list.length); i++) runners.push(run());
  await Promise.all(runners);
}

/**
 * 扫描目录：图片 / 视频 / 苹果实况（同名 .MOV 配对）
 * opts: { audio, doc } —— 设置里勾选后才收录音频与文档
 */
async function scanFolder(root, sender, opts) {
  const files = [];
  const archives = [];
  await walk(root, (f) => files.push(f), null, (a) => archives.push(a), opts);

  /* 和之前的浏览方式一致：目录里的压缩包直接展开，包内素材按「压缩包所在的目录」
     参与后面的实况配对、缩略图、地图和分类；压缩包本身不再单独占一张卡片。
     直接打开压缩包时 scanOpts.noArchiveExpand=true，避免把已经解开的包再展开一遍。 */
  if (!(opts && opts.noArchiveExpand) && archives.length) {
    try {
      const media = await expandArchives(archives, ARC_CACHE, (done, total) => {
        if (sender && !sender.isDestroyed()) sender.send('scan:progress', { done, total, unpack: true });
      }, { audio: !!(opts && opts.audio), doc: !!(opts && opts.doc) });
      for (const f of media) {
        let arcDir = '';
        try {
          const rel = path.relative(root, path.dirname(f.arc || '')).replace(/\\/g, '/');
          if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !/^[a-zA-Z]:/.test(rel)) arcDir = rel;
        } catch { arcDir = ''; }
        files.push({ ...f, arcDir });
      }
    } catch { /* 某个包解不开时跳过，不让整目录扫描失败 */ }
  }

  const items = [];
  const liveVideos = new Map();   // base -> video file
  const MOTION_EXT = new Set(['mov', 'mp4', 'm4v', '3gp']);
  const COVER_EXT = new Set(['heic', 'heif', 'jpg', 'jpeg', 'jfif', 'png', 'webp']);
  for (const f of files) {
    if (!MOTION_EXT.has(f.ext)) continue;
    const base = path.join(path.dirname(f.path), path.basename(f.path, path.extname(f.path)).toLowerCase());
    const prev = liveVideos.get(base);
    /* 同一 base 既有 .MOV 又有 .MP4 时优先 mov（真·实况更常见） */
    if (!prev || (prev.ext !== 'mov' && f.ext === 'mov')) liveVideos.set(base, f);
  }

  const usedVideos = new Set();
  const imageByBase = new Map();
  for (const f of files) {
    if (!['image'].includes(f.kind)) continue;
    const base = path.join(path.dirname(f.path), path.basename(f.path, path.extname(f.path)).toLowerCase());
    const prev = imageByBase.get(base);
    // 同名的 HEIC/JPG 同时存在时，优先用 JPG（解码更快）作为封面
    if (!prev || (prev.ext === 'heic' && f.ext !== 'heic')) imageByBase.set(base, f);
  }

  for (const f of files) {
    if (f.kind === 'audio' || f.kind === 'doc') {
      items.push({
        id: hashKey(f.path), path: f.path, name: path.basename(f.path),
        ext: f.ext, kind: f.kind, size: f.size, mtime: f.mtime, btime: f.btime,
        arc: f.arc || null, arcEntry: f.arcEntry || null,
        arcDir: typeof f.arcDir === 'string' ? f.arcDir : null
      });
      continue;
    }
    if (f.kind === 'video') {
      // 若存在同名静态图，则已在下面作为实况处理
      const base = path.join(path.dirname(f.path), path.basename(f.path, path.extname(f.path)).toLowerCase());
      if (usedVideos.has(f.path)) continue;
      if (liveVideos.get(base) === f && imageByBase.has(base)) continue;
      items.push({
        id: hashKey(f.path), path: f.path, name: path.basename(f.path),
        ext: f.ext, kind: 'video', size: f.size, mtime: f.mtime, btime: f.btime,
        arc: f.arc || null, arcEntry: f.arcEntry || null,
        arcDir: typeof f.arcDir === 'string' ? f.arcDir : null
      });
      continue;
    }

    const base = path.join(path.dirname(f.path), path.basename(f.path, path.extname(f.path)).toLowerCase());
    if (imageByBase.get(base) !== f) continue; // 同 base 的非封面图片，跳过（保留封面即可）

    const video = liveVideos.get(base);
    /* 只有封面是图片格式、且动态片段不是纯视频素材时才算实况，避免误配 */
    const isLive = !!(video && COVER_EXT.has(f.ext));
    if (isLive) usedVideos.add(video.path);
    items.push({
      id: hashKey(f.path), path: f.path, name: path.basename(f.path),
      ext: f.ext, kind: isLive ? 'live' : 'image', size: f.size, mtime: f.mtime, btime: f.btime,
      arc: f.arc || null, arcEntry: f.arcEntry || null,
      videoPath: isLive ? video.path : null,
      videoName: isLive ? path.basename(video.path) : null,
      videoSize: isLive ? video.size : 0,
      arcDir: typeof f.arcDir === 'string' ? f.arcDir : null
    });
  }

  /* 安卓实况照片（Motion Photo）：JPEG 尾部内嵌 MP4，抽出来并复用现有实况链路。
     只扫 JPEG，且最多 4 个并发，避免大量照片时把磁盘读满。 */
  try {
    const stills = items.filter((it) => it.kind === 'image'
      && ['jpg', 'jpeg', 'jfif'].includes(String(it.ext || '').toLowerCase()));
    await mapLimit(stills, 4, async (it) => {
      const found = await detectMotionPhoto(it.path, MOTION_CACHE, it.mtime);
      if (!found || !found.videoPath) return;
      it.kind = 'live';
      it.androidLive = true;
      it.liveAndroid = true;
      it.videoPath = found.videoPath;
      it.videoName = 'MotionPhoto · ' + path.basename(it.path);
      it.videoSize = 0;
      it.liveNeedTc = false;
    });
  } catch { /* 单张失败不影响扫描 */ }

  // 读取拍摄时间与 GPS 坐标（时间用于自动分类，坐标用于足迹地图）
  const mc = getMetaCache();
  let cacheHit = 0;
  await mapLimit(items, 8, async (it) => {
    const key = metaKeyOf(it.path, it.size, it.mtime);
    const hit = mc[key];
    if (hit) {
      cacheHit += 1;
      if (hit.t) { it.shotAt = hit.t; it.shotSource = hit.s || ''; }
      if (hit.g) it.gps = { lat: hit.g[0], lon: hit.g[1] };
      return;
    }
    const meta = (it.kind === 'audio' || it.kind === 'doc')
      ? {}
      : await readMeta(it.path, it.ext, it.kind === 'video' ? 'video' : 'image');
    mc[key] = {
      t: meta.shotAt || 0,
      s: meta.shotSource || '',
      g: meta.gps ? [meta.gps.lat, meta.gps.lon] : 0
    };
    metaCacheDirty = true;
    if (meta.shotAt) { it.shotAt = meta.shotAt; it.shotSource = meta.shotSource; }
    if (meta.gps) it.gps = meta.gps;
  }, (done, total) => {
    if (sender && !sender.isDestroyed()) sender.send('scan:progress', { done, total, cached: cacheHit });
  });
  saveMetaCacheSoon();


  /* ── 单张实况的“包目录”：一个目录里只有一对同名图片+视频时，
        不要把整个目录当作一个文件夹显示，而是把它当成父目录下的一条实况 ── */
  try {
    const dirFiles = new Map();
    for (const f of files) {
      const d = path.dirname(f.path);
      dirFiles.set(d, (dirFiles.get(d) || 0) + 1);
    }
    const relOf = (p) => {
      const rel = path.relative(root, p);
      if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('..')) return '';
      return rel.replace(/\\/g, '/');
    };
    for (const it of items) {
      if (it.kind !== 'live') continue;
      /* 安卓实况是一张 JPEG 自己内嵌视频，不是「图片+视频」的文件夹，不能做成文件夹卡片 */
      if (it.androidLive) continue;
      const d = path.dirname(it.path);
      if (d === root) continue;
      if ((dirFiles.get(d) || 0) > 2) continue;
      const rel = relOf(d);
      if (!rel) continue;
      const cut = rel.lastIndexOf('/');
      it.dirKey = cut < 0 ? '' : rel.slice(0, cut);
      it.packDir = rel;
    }
  } catch { /* 忽略 */ }

  /* ── 探测视频编码与旋转（决定是否要转码；实况的 .MOV 常见 90° 旋转，Chromium 不认） ── */
  try {
    const vids = items.filter((i) => i.kind === 'video' || (i.kind === 'live' && i.videoPath));
    if (vids.length && vids.length <= 90) {
      await mapLimit(vids, 4, async (it) => {
        if (it.kind === 'live') {
          const info = await probeVideoInfo(it.videoPath);
          it.liveCodec = info.codec;
          it.liveRot = info.rot;
          it.liveNeedTc = needsTranscode(info);
        } else {
          const info = await probeVideoInfo(it.path);
          it.codec = info.codec;
          it.rot = info.rot;
          it.needTc = needsTranscode(info);
        }
      });
    }
  } catch { /* 探测失败就按需转码 */ }

  const order = (a, b) => (b.shotAt || b.mtime) - (a.shotAt || a.mtime);
  items.sort(order);

  return {
    root,
    items,
    counts: {
      total: items.length,
      image: items.filter((i) => i.kind === 'image').length,
      video: items.filter((i) => i.kind === 'video').length,
      live: items.filter((i) => i.kind === 'live').length,
      audio: items.filter((i) => i.kind === 'audio').length,
      doc: items.filter((i) => i.kind === 'doc').length,
      archive: items.filter((i) => i.kind === 'archive').length
    }
  };
}

/* --------------------------------- 缩略图 --------------------------------- */

const thumbMemo = new Map(); // path|mtime -> url
const thumbMiss = new Set(); // 生成失败的文件，避免滚动时反复重试

async function shellThumb(src, key) {
  const cacheFile = path.join(CACHE_DIR, hashKey(key) + '.jpg');
  if (fs.existsSync(cacheFile)) return fileUrl(cacheFile);
  if (thumbMiss.has(key)) return null;
  try {
    const img = await nativeImage.createThumbnailFromPath(src, { width: 512, height: 512 });
    if (img && !img.isEmpty()) {
      const buf = img.toJPEG(86);
      if (buf && buf.length) {
        fs.writeFileSync(cacheFile, buf);
        return fileUrl(cacheFile);
      }
    }
  } catch { /* 系统不支持该编码 */ }
  thumbMiss.add(key);
  return null;
}

/* 视频卡片封面：用随包 ffmpeg 抽一帧，避免系统缩略图给出黑块 */
async function videoFrame(src, key) {
  const cacheFile = path.join(CACHE_DIR, 'vf-' + hashKey(key) + '.jpg');
  if (fs.existsSync(cacheFile)) return fileUrl(cacheFile);
  if (thumbMiss.has('vf:' + key)) return null;
  const ff = ffmpegPath();
  if (!ff) { thumbMiss.add('vf:' + key); return null; }
  try {
    await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    const ok = await new Promise((resolve) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.5', '-i', src,
        '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '4', cacheFile];
      let finished = false;
      const done = (v) => { if (!finished) { finished = true; clearTimeout(timer); resolve(v); } };
      const ps = require('child_process').spawn(ff, args, { windowsHide: true });
      const timer = setTimeout(() => { try { ps.kill(); } catch { /* ignore */ } done(false); }, 20000);
      ps.on('error', () => done(false));
      ps.on('close', (code) => done(code === 0));
    });
    if (ok && fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 1024) return fileUrl(cacheFile);
  } catch { /* ignore */ }
  thumbMiss.add('vf:' + key);
  return null;
}

async function thumbFor(item) {
  const src = item.path;
  const ext = (item.ext || '').toLowerCase();
  const memoKey = `${src}|${item.mtime || 0}`;
  if (thumbMemo.has(memoKey)) return thumbMemo.get(memoKey);

  /* HEIC / HEIF：系统缩略图接口解不出来，直接转 JPEG */
  if (HEIF_EXT.has(ext)) {
    const conv = await heicToFile(src, 640, 82);
    if (conv && conv.file) {
      const url = fileUrl(conv.file);
      thumbMemo.set(memoKey, url);
      return url;
    }
    /* 封面转不出来时，实况退回视频首帧 */
    if (item.kind === 'live' && item.videoPath) {
      const vurl = await shellThumb(item.videoPath, 'vid:' + item.videoPath + '|' + (item.mtime || 0));
      thumbMemo.set(memoKey, vurl || null);
      return vurl || null;
    }
    thumbMemo.set(memoKey, null);
    return null;
  }

  /* 视频：抽首帧做封面（系统缩略图对 HEVC/大文件常常给黑块） */
  if (item.kind === 'video') {
    const vf = await videoFrame(src, 'vfd:' + memoKey);
    if (vf) { thumbMemo.set(memoKey, vf); return vf; }
  }

  // 可直接解码且体积不大的图：直接给原图（最清晰、最快）
  if (DIRECT_IMAGE_EXT.has(ext) && ext !== 'gif' && (item.size || 0) < 900 * 1024) {
    const url = fileUrl(src);
    thumbMemo.set(memoKey, url);
    return url;
  }

  // 大图、HEIC / TIFF / RAW / 视频 / GIF：先走 512px 缓存，避免几十兆原图拖慢滚动
  let url = await shellThumb(src, 'still:' + memoKey);
  // 实况的封面若解不出来，回退到实况视频的首帧
  if (!url && item.kind === 'live' && item.videoPath) {
    url = await shellThumb(item.videoPath, 'vid:' + item.videoPath + '|' + (item.mtime || 0));
  }
  thumbMemo.set(memoKey, url || null);
  return url || null;
}

/* --------------------- 视频兜底转码（Chromium 解不了的编码） -------------------- */
/*
 * Chromium 只带 H.264 / VP9 / AV1 的软解，iPhone 实况的 HEVC .MOV、
 * 部分安卓 HEVC 片段会被判为「no supported streams」，表现就是实况不动。
 * 这里用随包附带的 ffmpeg 在后台转成 H.264 MP4 后缓存，界面再重新加载。
 */
const VIDEO_CACHE = path.join(DATA_DIR, 'cache', 'video');
const ARC_CACHE = path.join(DATA_DIR, 'cache', 'archive');
const transcodeJobs = new Map();

function ffmpegPath() {
  const cands = [
    path.join(process.resourcesPath || '', 'ffmpeg.exe'),
    path.join(process.resourcesPath || '', 'ffmpeg', 'ffmpeg.exe'),
    path.join(__dirname, '..', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')
  ];
  for (const p of cands) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/* 探测视频编码与旋转角度：ffmpeg -i 的 stderr 里同时有这两项，几乎零成本 */
const probeCache = new Map();
const OK_CODEC = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);

function needsTranscode(info) {
  if (!info) return false;
  if (info.rot) return true;
  if (!info.codec) return true;
  return !OK_CODEC.has(info.codec);
}

async function probeVideoInfo(file) {
  if (!file) return { codec: null, rot: 0 };
  let st;
  try { st = await fs.promises.stat(file); } catch { return { codec: null, rot: 0 }; }
  const key = file + '|' + st.size + '|' + Math.round(st.mtimeMs);
  if (probeCache.has(key)) return probeCache.get(key);
  const out = { codec: null, rot: 0, w: 0, h: 0 };
  const ff = ffmpegPath();
  if (ff) {
    await new Promise((resolve) => {
      let text = '';
      let finished = false;
      let timer = null;
      const done = () => { if (!finished) { finished = true; if (timer) clearTimeout(timer); resolve(); } };
      try {
        const ps = require('child_process').spawn(ff, ['-hide_banner', '-i', file], { windowsHide: true });
        ps.stderr.on('data', (b) => { text += b.toString(); });
        ps.on('error', done);
        ps.on('close', done);
        timer = setTimeout(() => { try { ps.kill(); } catch { /* ignore */ } done(); }, 9000);
      } catch { done(); }
      setTimeout(() => {
        const vm = text.match(/Video:\s*([a-zA-Z0-9_]+)/);
        if (vm) out.codec = vm[1].toLowerCase();
        const rm = text.match(/rotate\s*:\s*(-?\d+)/);
        if (rm) out.rot = ((Number(rm[1]) % 360) + 360) % 360;
        const dm = text.match(/(\d{2,5})x(\d{2,5})/);
        if (dm) { out.w = Number(dm[1]); out.h = Number(dm[2]); }
      }, 0);
    });
  }
  probeCache.set(key, out);
  return out;
}

/* 扫描完就把需要转码的视频提前转好，打开时不再黑屏等解码 */
const tcQueue = [];
const tcSeen = new Set();
let tcRunning = false;
function preTranscode(items) {
  for (const it of items || []) {
    const src = it.kind === 'live' ? (it.liveNeedTc ? it.videoPath : null)
      : (it.kind === 'video' && it.needTc ? it.path : null);
    if (!src) continue;
    if (tcSeen.has(src)) continue;
    tcSeen.add(src);
    tcQueue.push(src);
  }
  if (tcQueue.length > 16) tcQueue.length = 16;
  pumpTranscode();
}
async function pumpTranscode() {
  if (tcRunning) return;
  tcRunning = true;
  try {
    while (tcQueue.length) {
      const src = tcQueue.shift();
      try { await prepareVideo(src, it.kind === 'live' ? it.path : null); } catch { /* ignore */ }
    }
  } finally { tcRunning = false; }
}

/* 实况：有些导出包里「照片是自拍镜像、视频却没有镜像」，直接播放就会左右反转。
   这里把视频首帧与封面（已按 EXIF 摆正）缩成小图比对，镜像更接近时才加 hflip。 */
const mirrorProbe = new Map();
async function framesMirror(video, cover, ff) {
  const key = video + '|' + cover;
  if (mirrorProbe.has(key)) return mirrorProbe.get(key);
  const W = 24;
  const H = 30;
  const a = path.join(VIDEO_CACHE, hashKey('mf|' + key) + '.a.raw');
  const b = path.join(VIDEO_CACHE, hashKey('mf|' + key) + '.b.raw');
  const run = (args) => new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let ps;
    try { ps = require('child_process').spawn(ff, args, { windowsHide: true }); }
    catch { return resolve(false); }
    const timer = setTimeout(() => { try { ps.kill(); } catch { /* ignore */ } fin(false); }, 12000);
    ps.on('error', () => fin(false));
    ps.on('close', (code) => fin(code === 0));
  });
  let out = false;
  try {
    await fs.promises.mkdir(VIDEO_CACHE, { recursive: true });
    const ok1 = await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.05', '-i', video,
      '-vf', 'scale=' + W + ':' + H + ',format=gray', '-frames:v', '1', '-f', 'rawvideo', a]);
    const ok2 = await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', cover,
      '-vf', 'scale=' + W + ':' + H + ',format=gray', '-frames:v', '1', '-f', 'rawvideo', b]);
    if (ok1 && ok2) {
      const da = await fs.promises.readFile(a);
      const db = await fs.promises.readFile(b);
      if (da.length === W * H && db.length === W * H) {
        let same = 0, mir = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = y * W + x;
            same += Math.abs(da[i] - db[i]);
            mir += Math.abs(da[i] - db[y * W + (W - 1 - x)]);
          }
        }
        out = mir < same * 0.96;
      }
    }
  } catch { out = false; }
  try { fs.unlinkSync(a); } catch { /* ignore */ }
  try { fs.unlinkSync(b); } catch { /* ignore */ }
  mirrorProbe.set(key, out);
  return out;
}

async function prepareVideo(file, cover) {
  let st;
  try { st = await fs.promises.stat(file); } catch { return null; }
  if (!st.isFile() || st.size > 400 * 1024 * 1024) return null;
  const key = hashKey('tc|' + file + '|' + st.size + '|' + Math.round(st.mtimeMs) + '|' + (cover || ''));
  const out = path.join(VIDEO_CACHE, key + '.mp4');
  if (fs.existsSync(out)) return out;
  if (transcodeJobs.has(out)) return transcodeJobs.get(out);
  const ff = ffmpegPath();
  if (!ff) return null;
  const job = (async () => {
    const tmp = out + '.part.mp4';
    try {
      await fs.promises.mkdir(VIDEO_CACHE, { recursive: true });
      const ff = ffmpegPath();
      let flip = false;
      if (cover && ff) { try { flip = await framesMirror(file, cover, ff); } catch { flip = false; } }
      const okDone = await new Promise((resolve) => {
        const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p',
          '-vf', (flip ? 'hflip,' : '') + 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp];
        let finished = false;
        const done = (v) => { if (!finished) { finished = true; clearTimeout(timer); resolve(v); } };
        const ps = require('child_process').spawn(ff, args, { windowsHide: true });
        const timer = setTimeout(() => { try { ps.kill(); } catch { /* ignore */ } done(false); }, 180000);
        ps.on('error', () => done(false));
        ps.on('close', (code) => done(code === 0));
      });
      if (!okDone) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } return null; }
      const size = (await fs.promises.stat(tmp)).size;
      if (size < 2048) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } return null; }
      await fs.promises.rename(tmp, out);
      return out;
    } catch {
      return null;
    } finally {
      transcodeJobs.delete(out);
    }
  })();
  transcodeJobs.set(out, job);
  return job;
}

/* --------------------------------- IPC 注册 -------------------------------- */

/* -------------------------- 相似素材：感知哈希 dHash -------------------------- */
/* 9×8 灰度做横向比较得到 64 位哈希：比像素级比对抗缩放/重编码，几百张也只要一两秒 */
function dhashFromImage(img) {
  if (!img || img.isEmpty()) return null;
  try {
    const sm = img.resize({ width: 9, height: 8, quality: 'good' });
    const buf = sm.toBitmap();        // BGRA
    const lum = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 9; x++) {
        const i = (y * 9 + x) * 4;
        lum.push((buf[i] * 299 + buf[i + 1] * 587 + buf[i + 2] * 114) / 1000);
      }
    }
    let hex = '';
    for (let y = 0; y < 8; y++) {
      let nib = 0;
      let q = null;
      for (let x = 0; x < 8; x++) {
        const a = lum[y * 9 + x];
        const b = lum[y * 9 + x + 1];
        const bit = a > b ? 1 : 0;
        q = q == null ? BigInt(bit) : (q << 1n) | BigInt(bit);
      }
      hex += (q == null ? 0 : Number(q)).toString(16).padStart(2, '0');
    }
    return hex;
  } catch { return null; }
}

async function hashOfItem(item) {
  const ext = String(item.ext || '').toLowerCase();
  try {
    if (item.kind === 'video' || item.kind === 'live') {
      const src = item.kind === 'live' ? (item.videoPath || item.path) : item.path;
      const url = await videoFrame(src, 'vfd:' + src + '|' + (item.mtime || 0));
      if (!url) return null;
      const file = mediaFileFromUrl(url);
      if (!file) return null;
      const img = nativeImage.createFromPath(file);
      const sz = img.getSize();
      return { hash: dhashFromImage(img), w: sz.width, h: sz.height };
    }
    if (HEIF_EXT.has(ext)) {
      const conv = await heicToFile(item.path, 640, 82);
      if (!conv || !conv.file) return null;
      const img = nativeImage.createFromPath(conv.file);
      const sz = img.getSize();
      return { hash: dhashFromImage(img), w: conv.w || sz.width, h: conv.h || sz.height };
    }
    let img = nativeImage.createFromPath(item.path);
    if (!img || img.isEmpty()) img = await nativeImage.createThumbnailFromPath(item.path, { width: 320, height: 320 });
    if (!img || img.isEmpty()) return null;
    const sz = img.getSize();
    return { hash: dhashFromImage(img), w: sz.width, h: sz.height };
  } catch { return null; }
}

function mediaFileFromUrl(u) {
  try {
    const s2 = String(u || '');
    if (s2.startsWith('file://')) {
      let p = decodeURIComponent(new URL(s2).pathname || '');
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return p.replace(/\//g, path.sep);
    }
    return s2;
  } catch { return ''; }
}

/* -------------------------- 文件移动（拖到历史记录） -------------------------- */
function uniqueTarget(dest, name) {
  let target = path.join(dest, name);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let i = 1;
  while (fs.existsSync(target)) { target = path.join(dest, base + ' (' + i + ')' + ext); i += 1; }
  return target;
}

async function moveFiles(paths, dest) {
  const moved = [];
  for (const src of paths) {
    try {
      const st = await fs.promises.stat(src);
      if (!st.isFile()) continue;
      const target = uniqueTarget(dest, path.basename(src));
      if (target.toLowerCase() === src.toLowerCase()) continue;
      try {
        await fs.promises.rename(src, target);
      } catch {
        await fs.promises.copyFile(src, target);
        await fs.promises.unlink(src);
      }
      moved.push({ from: src, to: target });
    } catch { /* 单个失败不影响其他 */ }
  }
  return moved;
}

/* 实况所在的“包目录”整体移动：目录就是这张实况，不能只搬里面的图片/视频 */
function uniqueDirTarget(dest, name) {
  let target = path.join(dest, name || '实况');
  if (!fs.existsSync(target)) return target;
  const base = name || '实况';
  let i = 1;
  while (fs.existsSync(target)) { target = path.join(dest, base + ' (' + i + ')'); i += 1; }
  return target;
}
async function copyDir(src, dst) {
  await fs.promises.mkdir(dst, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) await copyDir(from, to);
    else if (ent.isFile()) await fs.promises.copyFile(from, to);
  }
}
async function movePackDirs(packs, dest) {
  const moved = [];
  for (const pk of packs) {
    try {
      const root = pk && pk.root ? String(pk.root) : '';
      const rel = pk && pk.dir ? String(pk.dir) : '';
      if (!root || !rel) continue;
      const src = path.resolve(root, rel);
      if (!fs.existsSync(src)) continue;
      const st = await fs.promises.stat(src);
      if (!st.isDirectory()) continue;
      const target = uniqueDirTarget(dest, path.basename(src));
      try {
        await fs.promises.rename(src, target);
      } catch {
        await copyDir(src, target);
        await fs.promises.rm(src, { recursive: true, force: true });
      }
      moved.push({ from: src, to: target, pack: true });
    } catch { /* 单个包失败不影响其它 */ }
  }
  return moved;
}

function registerIpc() {
  ipcMain.handle('album:pickFolder', async (e, start) => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要整理的文件夹',
      buttonLabel: '打开此文件夹',
      defaultPath: String(start || '') || undefined,
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  /* Windows 的文件选择框不能同时选文件和文件夹，所以压缩包走单独的入口 */
  ipcMain.handle('album:pickArchive', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要扫描的压缩包',
      buttonLabel: '扫描压缩包',
      properties: ['openFile'],
      filters: [
        { name: '压缩包', extensions: ['zip', '7z', 'rar', 'cbz', 'cbr', 'cab', 'iso', 'tar', 'gz', 'tgz', 'bz2', 'xz'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });


/* 判断路径自身或任一父目录是否带 Windows 隐藏属性，用于历史/收藏/素材路径列表过滤 */
function windowsHiddenPaths(paths) {
  const list = (Array.isArray(paths) ? paths : []).map((p) => String(p || '').trim()).filter(Boolean);
  if (process.platform !== 'win32' || !list.length) return Promise.resolve([]);
  const script = "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $items = ($env:LUM_PATHS -split \"`n\"); foreach($p in $items){ $walk=$p; while($walk){ if($walk -match '^[A-Za-z]:' -and $walk.Length -le 3){break}; $it=Get-Item -LiteralPath $walk -Force; if($it -and (($it.Attributes -band [IO.FileAttributes]::Hidden) -ne 0)){ $p; break }; $parent=Split-Path -Parent $walk; if(!$parent -or $parent -eq $walk){break}; $walk=$parent } }";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script], {
      encoding: 'utf8', timeout: 6000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      env: Object.assign({}, process.env, { LUM_PATHS: list.join('\n') })
    }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout || '').replace(/^\uFEFF/, '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
    });
  });
}

  /* 统一来源选择器：列出目录里的子文件夹和压缩包，让一个入口就能选两种来源 */
  
/* Windows 隐藏属性识别：Node 的 fs.stat 不暴露 st_file_attributes，用一次 PowerShell 查询目录内隐藏项 */
const HIDDEN_ATTR_CACHE = new Map();
const HIDDEN_ALWAYS = new Set(['$recycle.bin','system volume information','$windows.~bt','recovery','config.msi','msocache','appdata','application data','local settings','cookies','nethood','printhood','recent','sendto','templates','my documents','start menu','「开始」菜单']);
function windowsHiddenNames(dir) {
  if (process.platform !== 'win32') return Promise.resolve(new Set());
  const key = String(dir || '').toLowerCase();
  const hit = HIDDEN_ATTR_CACHE.get(key);
  if (hit && Date.now() - hit.at < 8000) return Promise.resolve(hit.set);
  const script = "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-ChildItem -LiteralPath $env:LUM_DIR -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::Hidden) -ne 0 } | ForEach-Object { $_.Name }";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script], {
      encoding: 'utf8', timeout: 4000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      env: Object.assign({}, process.env, { LUM_DIR: String(dir || '') })
    }, (err, stdout) => {
      const set = new Set();
      if (!err && stdout) {
        String(stdout).replace(/^\uFEFF/, '').split(/\r?\n/).forEach((n) => { if (n) set.add(n); });
      }
      HIDDEN_ATTR_CACHE.set(key, { set, at: Date.now() });
      resolve(set);
    });
  });
}

ipcMain.handle('album:hiddenPaths', async (e, paths) => {
  try { return await windowsHiddenPaths(paths); } catch { return []; }
});

ipcMain.handle('album:listDir', async (e, dir, opts) => {
    try {
      let target = typeof dir === 'string' && dir.trim() ? dir.trim() : app.getPath('home');
      try {
        const st = fs.statSync(target);
        if (!st.isDirectory()) target = path.dirname(target);
      } catch {
        return { error: '这个路径不存在或无法访问' };
      }
      const showHidden = !!(opts && opts.showHidden);
      let hidden = new Set();
      if (!showHidden) { try { hidden = await windowsHiddenNames(target); } catch { hidden = new Set(); } }
      const entries = await fs.promises.readdir(target, { withFileTypes: true });
      const dirs = [];
      const archives = [];
      for (const ent of entries) {
        if (!ent.name) continue;
        if (!showHidden && (ent.name.startsWith('.') || hidden.has(ent.name) || HIDDEN_ALWAYS.has(ent.name.toLowerCase()))) continue;
        const full = path.join(target, ent.name);
        if (ent.isDirectory()) {
          dirs.push({ name: ent.name, path: full });
          continue;
        }
        const ext = path.extname(ent.name).slice(1).toLowerCase();
        if (!ARCHIVE_EXT.has(ext)) continue;
        try {
          const st = await fs.promises.stat(full);
          archives.push({ name: ent.name, path: full, size: st.size, mtime: st.mtimeMs });
        } catch { /* 跳过读不到的项 */ }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
      archives.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
      const parent = path.dirname(target);
      return {
        path: target,
        parent: parent && parent !== target ? parent : '',
        dirs,
        archives
      };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('album:scan', async (e, root, opts) => {
    if (!root || typeof root !== 'string') return { error: '路径无效' };
    const scanOpts = { audio: !!(opts && opts.audio), doc: !!(opts && opts.doc) };
    let archiveRoot = '';
    /* 直接打开一个压缩包：先解到缓存，再按缓存目录扫描，界面里显示的是压缩包本身 */
    let scanBase = root;
    let displayRoot = root;
    try {
      const st = fs.statSync(root);
      if (!st.isDirectory()) {
        const ext = path.extname(root).slice(1).toLowerCase();
        if (!ARCHIVE_EXT.has(ext)) return { error: '请选择文件夹，或 zip / 7z / rar 压缩包' };
        const media = await expandArchives([{ path: root, ext, size: st.size, mtime: st.mtimeMs }], ARC_CACHE,
          (d, t) => { if (e.sender && !e.sender.isDestroyed()) e.sender.send('scan:progress', { done: d, total: t, unpack: true }); },
          { audio: true, doc: true });
        if (!media.length) return { error: '这个压缩包里没有可识别的图片、视频、音频或文档' };
        const rel0 = path.relative(ARC_CACHE, media[0].path).split(path.sep)[0];
        scanBase = path.join(ARC_CACHE, rel0);
        displayRoot = root;
        archiveRoot = root;
        /* 包内已经解过的小 zip 不再展开第二遍；直接打开压缩包时音视频、文档都要能看见 */
        scanOpts.audio = true;
        scanOpts.doc = true;
        scanOpts.noArchiveExpand = true;
      }
    } catch {
      return { error: '路径不存在或已被移动' };
    }
    try {
      const res = await scanFolder(scanBase, e.sender, scanOpts);
      if (archiveRoot && res && res.items) {
        for (const it of res.items) {
          try {
            const rel = path.relative(scanBase, it.path).replace(/\\/g, '/');
            it.arc = archiveRoot;
            it.arcEntry = rel.replace(/^__nested\/[0-9a-f]{12,18}\//, '');
            it.arcDir = '';
            it.dirKey = '';
            it.packDir = '';
          } catch { /* ignore */ }
        }
      }
      res.root = displayRoot;
      res.opts = scanOpts;
      preTranscode(res.items);
      return res;
    } catch (err) {
      return { error: err && err.message ? err.message : '扫描失败' };
    }
  });

  ipcMain.handle('album:thumb', async (e, item) => ({ url: await thumbFor(item) }));

  /* 编码不被支持的视频/实况片段：转成 H.264 MP4 后再给界面 */
  ipcMain.handle('album:prepareVideo', async (e, item) => {
    if (!item || (!item.path && !item.videoPath)) return { error: 'no-item' };
    const src = item.videoPath || item.path;
    try {
      const out = await prepareVideo(src, item.kind === 'live' ? item.path : null);
      return out ? { path: out } : { error: 'transcode-failed' };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  });

  /* 原画质预览图：HEIC 转大尺寸高质量 JPEG，其它直接返回原文件 */
  ipcMain.handle('album:prepareImage', async (e, item) => {
    const src = String((item && item.path) || '');
    const ext = String((item && item.ext) || path.extname(src)).replace(/^\./, '').toLowerCase();
    if (!src) return { error: 'no-item' };
    try {
      if (HEIF_EXT.has(ext)) {
        const conv = await heicToFile(src, 6000, 95);
        if (conv && conv.file) return { path: conv.file };
        return { error: 'heic-failed' };
      }
      return { path: src };
    } catch (err) { return { error: String((err && err.message) || err) }; }
  });

  ipcMain.handle('album:meta', async (e, item) => {
    const p = item.path;
    let stat;
    try { stat = await fs.promises.stat(p); } catch { return { error: '文件不存在' }; }

    const meta = await readMeta(p, (item.ext || '').toLowerCase(), item.kind === 'video' ? 'video' : 'image');
    const out = {
      path: p,
      name: path.basename(p),
      ext: (item.ext || '').toUpperCase(),
      size: stat.size,
      ctime: stat.birthtimeMs || stat.ctimeMs,
      mtime: stat.mtimeMs,
      shotAt: meta.shotAt || null,
      pixel: meta.pixel || null,
      camera: meta.camera || null,
      lens: meta.lens || null,
      exposure: meta.exposure || null,
      duration: meta.duration || null,
      fps: meta.fps || null,
      kind: item.kind,
      videoPath: item.videoPath || null,
      videoSize: item.videoSize || 0,
      arc: item.arc || null,
      arcEntry: item.arcEntry || null
    };

    // 缺失分辨率时的兜底（静态图）
    if (!out.pixel && item.kind !== 'video') {
      const extL = (item.ext || '').toLowerCase();
      if (HEIF_EXT.has(extL)) {
        const conv = await heicToFile(p, 2200, 86);
        if (conv && conv.w) out.pixel = { w: conv.w, h: conv.h };
      } else {
        try {
          const img = nativeImage.createFromPath(p);
          if (img && !img.isEmpty()) {
            const s = img.getSize();
            if (s.width && s.height) out.pixel = { w: s.width, h: s.height };
          }
        } catch { /* ignore */ }
      }
    }

    // 实况：附带视频信息
    if (item.kind === 'live' && item.videoPath) {
      const vm = await readMeta(item.videoPath, 'mov', 'video');
      out.live = {
        path: item.videoPath,
        name: path.basename(item.videoPath),
        size: item.videoSize || 0,
        duration: vm.duration || null,
        fps: vm.fps || null,
        pixel: vm.pixel || null
      };
      try {
        const vs = await fs.promises.stat(item.videoPath);
        out.live.mtime = vs.mtimeMs;
      } catch { /* ignore */ }
    }

    if (meta.gps) {
      out.gps = meta.gps;
      const place = await resolvePlace(meta.gps.lat, meta.gps.lon);
      out.place = place || null;
      out.coord = `${meta.gps.lat.toFixed(5)}, ${meta.gps.lon.toFixed(5)}`;
    }

    return out;
  });

  /* AI 识别用的取样图：统一缩到 320px 的 JPEG dataURL */
  ipcMain.handle('album:sample', async (e, item) => {
    if (!item || !item.path) return { error: 'no-item' };
    const p = item.path;
    const ext = (item.ext || '').toLowerCase();
    try {
      if (HEIF_EXT.has(ext)) {
        const conv = await heicToFile(p, 480, 80);
        if (conv && conv.file) {
          const b = await fs.promises.readFile(conv.file);
          return { dataUrl: 'data:image/jpeg;base64,' + b.toString('base64'), w: conv.w, h: conv.h };
        }
        return { error: 'heic-failed' };
      }
      let img = null;
      if (DIRECT_IMAGE_EXT.has(ext) && ext !== 'gif') {
        img = nativeImage.createFromPath(p);
      }
      if (!img || img.isEmpty()) {
        img = await nativeImage.createThumbnailFromPath(p, { width: 384, height: 384 });
      }
      if (!img || img.isEmpty()) return { error: 'no-preview' };
      const s = img.getSize();
      const scale = Math.min(1, 320 / Math.max(s.width || 1, s.height || 1));
      const w = Math.max(1, Math.round((s.width || 1) * scale));
      const h = Math.max(1, Math.round((s.height || 1) * scale));
      const rz = img.resize({ width: w, height: h, quality: 'good' });
      const jpg = rz.toJPEG(82);
      if (!jpg || !jpg.length) return { error: 'no-encode' };
      return { dataUrl: 'data:image/jpeg;base64,' + jpg.toString('base64'), w, h };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('album:aiGet', () => fixStoredDeep(readJson(AI_FILE, {})));
  ipcMain.handle('album:aiSet', (e, patch) => {
    if (!patch || typeof patch !== 'object') return { ok: false };
    try {
      const cur = readJson(AI_FILE, {}) || {};
      for (const k of Object.keys(patch)) cur[k] = patch[k];
      writeJson(AI_FILE, cur);
      return { ok: true, total: Object.keys(cur).length };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle('album:aiClear', () => {
    try { writeJson(AI_FILE, {}); return { ok: true }; } catch { return { ok: false }; }
  });

  /* 项目文件夹搬家后，旧数据里缓存的绝对路径需要迁到当前 data 目录 */
  const CACHE_SEG = /\\data\\cache\\((?:thumbs\\)*)(archive|video|heic|thumbs)\\(.*)$/i;
  function fixStoredPath(v) {
    if (typeof v !== 'string') return v;
    const m = v.match(CACHE_SEG);
    if (!m) return v;
    return path.join(DATA_DIR, 'cache', m[2], m[3]);
  }
  function fixStoredDeep(o) {
    if (typeof o === 'string') return fixStoredPath(o);
    if (Array.isArray(o)) return o.map(fixStoredDeep);
    if (o && typeof o === 'object') {
      const out = {};
      for (const k of Object.keys(o)) out[fixStoredPath(k)] = fixStoredDeep(o[k]);
      return out;
    }
    return o;
  }

  ipcMain.handle('album:library:get', () => fixStoredDeep(readJson(LIB_FILE, null)));
  ipcMain.handle('album:library:set', (e, data) => {
    try { writeJson(LIB_FILE, data); return { ok: true }; } catch (err) { return { ok: false, error: String(err && err.message) }; }
  });

  ipcMain.handle('album:exists', (e, paths) => {
    if (!Array.isArray(paths)) return [];
    return paths.map((p) => {
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    });
  });

  ipcMain.handle('album:reveal', (e, p) => {
    try { shell.showItemInFolder(p); return true; } catch { return false; }
  });

  ipcMain.handle('album:openExternal', async (e, p) => {
    try { await shell.openPath(p); return true; } catch { return false; }
  });

  ipcMain.handle('album:openFolder', async (e, p) => {
    try { await shell.openPath(p); return true; } catch { return false; }
  });

  ipcMain.handle('album:openUrl', async (e, url) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return false;
    try { await shell.openExternal(u); return true; } catch { return false; }
  });

  ipcMain.handle('album:place', async (e, gps) => {
    if (!gps || typeof gps.lat !== 'number' || typeof gps.lon !== 'number') return null;
    return await resolvePlace(gps.lat, gps.lon);
  });
  ipcMain.handle('album:geocode', async (e, q) => {
    const text = String(q || '').trim();
    if (!text) return [];
    const clean = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const uniq = (arr) => {
      const seen = new Set(), out = [];
      for (const x of arr) {
        if (!x || !Number.isFinite(x.lat) || !Number.isFinite(x.lon)) continue;
        const k = x.lat.toFixed(3) + ',' + x.lon.toFixed(3);
        if (seen.has(k)) continue;
        seen.add(k);
        x.name = clean(x.name) || text;
        out.push(x);
        if (out.length >= 8) break;
      }
      return out;
    };
    const fetchJson = async (url, ms = 6000) => {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'SmartAlbum/1.0 (local desktop app)', 'Accept-Language': 'zh-CN' },
        signal: AbortSignal.timeout(ms)
      });
      if (!res.ok) return null;
      return res.json();
    };
    const fromPhoton = async () => {
      try {
        const j = await fetchJson('https://photon.komoot.io/api/?limit=8&q=' + encodeURIComponent(text));
        const fs2 = Array.isArray(j?.features) ? j.features : [];
        return fs2.map((f) => {
          const p = f?.properties || {};
          const c = f?.geometry?.coordinates || [];
          const parts = [p.name, p.street, p.district, p.city, p.county, p.state, p.country]
            .map(clean).filter(Boolean);
          return { name: parts.join(' · '), lat: Number(c[1]), lon: Number(c[0]) };
        });
      } catch { return []; }
    };
    const fromOpenMeteo = async () => {
      try {
        const j = await fetchJson('https://geocoding-api.open-meteo.com/v1/search?count=8&language=zh&format=json&name='
          + encodeURIComponent(text));
        const rs = Array.isArray(j?.results) ? j.results : [];
        return rs.map((x) => ({
          name: [x.name, x.admin2, x.admin1, x.country].map(clean).filter(Boolean).join(' · '),
          lat: Number(x.latitude), lon: Number(x.longitude)
        }));
      } catch { return []; }
    };
    const fromNominatim = async () => {
      try {
        const j = await fetchJson('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=zh-CN&q='
          + encodeURIComponent(text), 5500);
        const arr = Array.isArray(j) ? j : [];
        return arr.map((x) => ({ name: x.display_name || x.name || text, lat: Number(x.lat), lon: Number(x.lon) }));
      } catch { return []; }
    };
    const both = await Promise.all([fromPhoton(), fromOpenMeteo()]);
    const first = uniq(both[0].concat(both[1]));
    if (first.length) return first;
    return uniq(await fromNominatim());
  });

  ipcMain.handle('album:export', async (e, items) => {
    if (!Array.isArray(items) || !items.length) return { ok: false, error: '没有选中素材' };
    const r = await dialog.showOpenDialog(win, {
      title: '导出到文件夹',
      buttonLabel: '导出到此处',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const dest = r.filePaths[0];
    let count = 0;
    for (const it of items) {
      const srcs = [it.path, it.videoPath].filter(Boolean);
      for (const src of srcs) {
        try {
          const target = path.join(dest, path.basename(src));
          let final = target;
          if (fs.existsSync(final)) {
            const base = path.basename(src, path.extname(src));
            const ext = path.extname(src);
            let i = 1;
            while (fs.existsSync(final)) { final = path.join(dest, `${base} (${i})${ext}`); i += 1; }
          }
          fs.copyFileSync(src, final);
          count += 1;
        } catch { /* 单个文件失败不影响整体 */ }
      }
    }
    return { ok: true, count, dest };
  });

  /* 相似素材分析：一次最多算 400 张，避免大目录卡住 */
  ipcMain.handle('album:hash', async (e, items) => {
    const list = (Array.isArray(items) ? items : []).slice(0, 400);
    const out = [];
    for (const it of list) {
      if (!it || !it.path) continue;
      const h = await hashOfItem(it);
      if (h && h.hash) {
        out.push({
          path: it.path, kind: it.kind, ext: it.ext, size: it.size || 0,
          mtime: it.mtime || 0, hash: h.hash, w: h.w || 0, h: h.h || 0
        });
      }
    }
    return out;
  });

  /* 拖到历史记录 = 把文件移动到那个目录 */
  ipcMain.handle('album:move', async (e, payload) => {
    const paths = (payload && Array.isArray(payload.paths)) ? payload.paths : [];
    const packs = (payload && Array.isArray(payload.packs)) ? payload.packs : [];
    const dest = payload && payload.dest;
    if ((!paths.length && !packs.length) || !dest) return { ok: false, error: 'no-target' };
    try {
      const st = await fs.promises.stat(dest);
      if (!st.isDirectory()) return { ok: false, error: '目标不是文件夹' };
    } catch { return { ok: false, error: '目标已失效' }; }
    /* 先把实况包目录整体搬走，再搬散文件，避免包里的文件被重复搬 */
    const movedPacks = await movePackDirs(packs, dest);
    const packFiles = [];
    for (const m of movedPacks) packFiles.push(String(m.from || '').toLowerCase());
    const filtered = paths.filter((p) => !packFiles.some((d) => p.toLowerCase().startsWith(d + path.sep)));
    const moved = await moveFiles(filtered, dest);
    const all = movedPacks.concat(moved);
    return { ok: all.length > 0, moved: all, count: all.length, packs: movedPacks.length };
  });

  /* ───────── 回收站：删除进回收站，可还原 ───────── */
  const BIN_DIR = path.join(DATA_DIR, 'recycle');
  const BIN_FILE = path.join(DATA_DIR, 'recycle.json');
  function readBin() {
    try { return JSON.parse(fs.readFileSync(BIN_FILE, 'utf8')) || []; } catch { return []; }
  }
  function writeBin(list) { writeJson(BIN_FILE, list); }
  function uniqName(dir, name) {
    let out = path.join(dir, name);
    if (!fs.existsSync(out)) return out;
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    for (let i = 1; i < 200; i++) {
      out = path.join(dir, base + ' (' + i + ')' + ext);
      if (!fs.existsSync(out)) return out;
    }
    return path.join(dir, Date.now() + '-' + name);
  }
  ipcMain.handle('album:delete', async (e, payload) => {
    const isArr = Array.isArray(payload);
    const paths = isArr ? payload.filter(Boolean) : ((payload && Array.isArray(payload.paths)) ? payload.paths.filter(Boolean) : []);
    const groupsIn = (!isArr && payload && Array.isArray(payload.groups)) ? payload.groups : [];
    if (!paths.length && !groupsIn.length) return { ok: false, error: 'no-paths' };
    try { fs.mkdirSync(BIN_DIR, { recursive: true }); } catch { /* ignore */ }
    const bin = readBin();
    const done = [];
    const groups = [];
    if (groupsIn.length) {
      for (const g of groupsIn) { if (g && Array.isArray(g.files) && g.files.length) groups.push(g); }
    } else {
      /* 旧调用：按文件逐个组成独立组 */
      for (const p of paths) groups.push({ files: [p], gid: '', gname: path.basename(p) });
    }
    for (const g of groups) {
      const gid = g.gid || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
      const gname = g.gname || path.basename(g.files[0] || '素材');
      const files = g.files.filter(Boolean);
      /* 只有“单张实况包目录”才允许整目录删除；目录里还有别的素材时不扩大删除范围 */
      let dirToRemove = '';
      try {
        if (g.dir && g.root) {
          const d = path.resolve(String(g.root), String(g.dir));
          if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
            const inside = fs.readdirSync(d, { withFileTypes: true });
            if (inside.length <= 2) dirToRemove = d;
          }
        }
      } catch { /* ignore */ }
      let movedAny = false;
      for (const src of files) {
        try {
          const st = await fs.promises.stat(src);
          if (!st.isFile()) continue;
          const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          const dest = path.join(BIN_DIR, id + '__' + path.basename(src));
          await fs.promises.copyFile(src, dest);
          const sz = (await fs.promises.stat(dest)).size;
          await fs.promises.unlink(src);
          bin.push({ id, gid, gname, kind: g.kind || '', name: path.basename(src), orig: src, bin: dest, size: sz, time: Date.now() });
          done.push(src);
          movedAny = true;
        } catch { /* 单个失败不影响其它 */ }
      }
      if (movedAny && dirToRemove) {
        try { await fs.promises.rm(dirToRemove, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
    writeBin(bin);
    return { ok: done.length > 0, count: done.length, items: done };
  });
  ipcMain.handle('album:recycleList', () => {
    const bin = readBin().filter((b) => fs.existsSync(b.bin));
    writeBin(bin);
    return bin;
  });
  ipcMain.handle('album:recycleRestore', async (e, ids) => {
    const want = new Set(Array.isArray(ids) ? ids : []);
    const bin = readBin();
    const left = [];
    let n = 0;
    for (const b of bin) {
      if (!want.has(b.id)) { left.push(b); continue; }
      try {
        await fs.promises.mkdir(path.dirname(b.orig), { recursive: true });
        await fs.promises.rename(b.bin, uniqName(path.dirname(b.orig), path.basename(b.orig)));
        n += 1;
      } catch {
        try {
          await fs.promises.copyFile(b.bin, uniqName(path.dirname(b.orig), path.basename(b.orig)));
          await fs.promises.unlink(b.bin);
          n += 1;
        } catch { left.push(b); }
      }
    }
    writeBin(left);
    return { ok: n > 0, count: n };
  });
  ipcMain.handle('album:recycleClear', () => {
    const bin = readBin();
    for (const b of bin) { try { fs.unlinkSync(b.bin); } catch { /* ignore */ } }
    writeBin([]);
    try { fs.rmdirSync(BIN_DIR); } catch { /* ignore */ }
    return { ok: true, count: bin.length };
  });

  /* 文档简单预览：文本 / docx / xlsx / pptx / PDF */
  ipcMain.handle('album:previewDoc', async (e, p) => previewDoc(p));

  /* 文本文档预览 */
  ipcMain.handle('album:text', async (e, p) => {
    const ext = path.extname(String(p || '')).slice(1).toLowerCase();
    const OK = new Set(['txt', 'md', 'log', 'csv', 'json', 'xml', 'htm', 'html', 'srt', 'ass', 'ini', 'yml', 'yaml']);
    if (!OK.has(ext)) return { error: '该格式请用默认应用打开' };
    try {
      const st = await fs.promises.stat(p);
      if (st.size > 700 * 1024) return { error: '文件超过 700KB，请用默认应用打开' };
      const buf = await fs.promises.readFile(p);
      const text = buf.toString('utf8').replace(/^\uFEFF/, '');
      return { text, size: st.size };
    } catch (err) { return { error: String((err && err.message) || err) }; }
  });

  /* 人物备注（人脸分组的名字） */
  ipcMain.handle('album:peopleGet', () => fixStoredDeep(readJson(PEOPLE_FILE, {})));
  ipcMain.handle('album:peopleSet', (e, data) => {
    try { writeJson(PEOPLE_FILE, data || {}); return { ok: true }; } catch { return { ok: false }; }
  });

  ipcMain.handle('album:cacheClear', () => {
    let n = 0;
    for (const dir of [CACHE_DIR, HEIC_CACHE, VIDEO_CACHE, ARC_CACHE, MOTION_CACHE]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          try { fs.unlinkSync(path.join(dir, f)); n += 1; } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    thumbMemo.clear();
    heicDims.clear();
    return { ok: true, removed: n };
  });

  ipcMain.handle('album:cacheSize', () => {
    let bytes = 0;
    try {
      for (const f of fs.readdirSync(CACHE_DIR)) {
        try { bytes += fs.statSync(path.join(CACHE_DIR, f)).size; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return bytes;
  });

  /* 全屏（隐藏系统标题栏按钮） */
  ipcMain.handle('album:fullscreen', (e, flag) => {
    try { if (win && !win.isDestroyed()) win.setFullScreen(!!flag); } catch { /* ignore */ }
    /* 自绘按钮不需要系统标题栏覆盖层 */
    return { ok: true, full: !!(win && !win.isDestroyed() && win.isFullScreen()) };
  });

  /* 夜间模式：Windows 标题栏右上角的窗口按钮也要一起变深，避免白块 */
  ipcMain.handle('album:titlebarTheme', (e, night) => {
    nightTheme = !!night;
    try { applyTitleBarOverlay(); } catch { /* ignore */ }
    return { ok: true, night: nightTheme };
  });

  /* 自绘标题栏的最小化 / 最大化 / 关闭 */
  ipcMain.on('album:winMinimize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.minimize();
  });
  ipcMain.handle('album:winToggleMaximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return { maximized: false };
    if (w.isFullScreen()) w.setFullScreen(false);
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return { maximized: w.isMaximized() };
  });
  ipcMain.on('album:winClose', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.close();
  });
  ipcMain.handle('album:winState', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return { maximized: false, fullscreen: false };
    return { maximized: w.isMaximized(), fullscreen: w.isFullScreen() };
  });

  /* 系统剪贴板里的文件（Windows 使用 FileNameW / CF_HDROP 口径），用于右键粘贴 */
  ipcMain.handle('album:clipboardFiles', () => {
    try {
      const buf = clipboard.readBuffer('FileNameW');
      if (!buf || !buf.length) return [];
      const txt = buf.toString('utf16le');
      return txt.split('\u0000').map((x) => x.trim()).filter((x) => x && fs.existsSync(x));
    } catch { return []; }
  });
  ipcMain.handle('album:clipboardSetFiles', (e, paths) => {
    try {
      const list = (Array.isArray(paths) ? paths : []).filter((p) => p && fs.existsSync(p));
      if (!list.length) return { ok: false };
      clipboard.writeBuffer('FileNameW', Buffer.from(list.join('\u0000') + '\u0000', 'utf16le'));
      return { ok: true, count: list.length };
    } catch { return { ok: false }; }
  });

  /* 重命名真实文件（实况同时改同名 .mov） */
  ipcMain.handle('album:renameFile', async (e, oldPath, newName) => {
    const src = String(oldPath || '');
    const nm = String(newName || '').trim();
    if (!src || !nm) return { ok: false, error: 'bad args' };
    if (/[\\/:*?"<>|]/.test(nm)) return { ok: false, error: '名称不能包含 \\ / : * ? " < > |' };
    const dir = path.dirname(src);
    let name = nm;
    if (!path.extname(name)) name += path.extname(src);
    const dst = path.join(dir, name);
    if (dst.toLowerCase() === src.toLowerCase()) return { ok: true, path: src };
    if (fs.existsSync(dst)) return { ok: false, error: '同名文件已存在' };
    try {
      await fs.promises.rename(src, dst);
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
    /* 实况：同名 mov 一起改 */
    try {
      const ext = path.extname(src).toLowerCase();
      if (['.jpg', '.jpeg', '.heic', '.png'].includes(ext)) {
        const mv = src.slice(0, src.length - path.extname(src).length) + '.mov';
        if (fs.existsSync(mv)) {
          const mvDst = dst.slice(0, dst.length - path.extname(dst).length) + '.mov';
          if (!fs.existsSync(mvDst)) await fs.promises.rename(mv, mvDst);
        }
      }
    } catch { /* ignore */ }
    return { ok: true, path: dst };
  });

  /* 复制文件到目标目录 */
  ipcMain.handle('album:copyFiles', async (e, pathsIn, dest) => {
    const list = Array.isArray(pathsIn) ? pathsIn : [];
    const dir = String(dest || '');
    if (!list.length || !dir) return { ok: false, error: 'bad args' };
    let n = 0;
    for (const src of list) {
      try {
        if (!fs.existsSync(src)) continue;
        await fs.promises.mkdir(dir, { recursive: true });
        const target = uniqName(dir, path.basename(src));
        await fs.promises.copyFile(src, target);
        n += 1;
      } catch { /* ignore */ }
    }
    return { ok: n > 0, count: n };
  });


  /* 把时间 / 地点 / 备注写回本地：时间同步文件时间，地点与备注写同名 XMP 侧车 */
  ipcMain.handle('album:updateInfo', async (e, payload) => {
    const p = payload && payload.path;
    if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
    let dateMs = 0;
    if (payload.date) {
      const d = new Date(payload.date);
      if (!Number.isNaN(d.getTime())) {
        dateMs = d.getTime();
        try { await fs.promises.utimes(p, d, d); } catch { /* 时间写入失败不阻断地点 */ }
      }
    }
    const sidecar = p + '.xmp';
    const hasLat = Number.isFinite(Number(payload.lat)) && Number.isFinite(Number(payload.lon));
    const has = !!(payload.date || payload.place || payload.note || hasLat);
    try {
      if (!has) {
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
        return { ok: true, sidecar: '', mtime: dateMs || null };
      }
      const iso = payload.date || '';
      const xmp = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
        + '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        + '<rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" '
        + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/" '
        + 'xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#">\n'
        + (iso ? '<photoshop:DateCreated>' + esc(iso) + '</photoshop:DateCreated>\n' : '')
        + (payload.place ? '<Iptc4xmpCore:Location>' + esc(payload.place) + '</Iptc4xmpCore:Location>\n' : '')
        + (payload.note ? '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">' + esc(payload.note) + '</rdf:li></rdf:Alt></dc:description>\n' : '')
        + (hasLat ? '<geo:lat>' + Number(payload.lat).toFixed(7) + '</geo:lat><geo:long>' + Number(payload.lon).toFixed(7) + '</geo:long>\n' : '')
        + '</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>';
      await fs.promises.writeFile(sidecar, xmp, 'utf8');
      return { ok: true, sidecar, mtime: dateMs || null };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), mtime: dateMs || null };
    }
  });

  ipcMain.handle('album:appInfo', () => ({
    version: app.getVersion(),
    dataDir: DATA_DIR,
    cacheDir: CACHE_DIR
  }));
}

/* ---------------------------------- 生命周期 -------------------------------- */

app.whenReady().then(() => {
  ensureDirs();
  registerMediaProtocol();
  loadGeo();
  registerIpc();
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

