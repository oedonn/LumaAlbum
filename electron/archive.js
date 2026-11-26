'use strict';

/**
 * 压缩包支持：用随包的 7-Zip 独立命令行（7za.exe，LGPL/开源）读取 zip / 7z / rar / cbz / cbr。
 * 一刻相册、iPhone 备份等导出的「实况」常常是一层 zip，里面才是 IMG_xxx.jpeg + IMG_xxx.mov，
 * 不解开就会被当成非素材直接跳过（表现为「实况 0」）。
 *
 * 做法：把压缩包里的图片/视频解到缓存目录，交给后续流程当作普通文件处理，
 * 因此实况配对、缩略图、HEIC 解码、视频转码、地图、AI 识别全部照常工作。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ARCHIVE_EXT = new Set(['zip', '7z', 'rar', 'cbz', 'cbr', 'cab', 'iso', 'tar', 'gz', 'tgz', 'bz2', 'xz']);

const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff',
  'heic', 'heif', 'avif', 'jxl', 'ico'
]);
const VIDEO_EXT = new Set([
  'mp4', 'mov', 'm4v', 'avi', 'flv', 'mkv', 'wmv', 'webm', '3gp', 'mts', 'm2ts', 'mpg', 'mpeg', 'ts'
]);
const AUDIO_EXT = new Set([
  'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma',
  'ape', 'aif', 'aiff', 'amr', 'wv', 'mid', 'midi'
]);
const DOC_EXT = new Set([
  'txt', 'md', 'log', 'csv', 'json', 'xml', 'htm', 'html', 'rtf', 'srt', 'ass',
  'doc', 'docx', 'wps', 'ppt', 'pptx', 'dps', 'xls', 'xlsx', 'et', 'pdf', 'epub', 'ofd'
]);
const MEDIA_EXT = new Set([...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT, ...DOC_EXT]);

function kindOf(ext) {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (DOC_EXT.has(ext)) return 'doc';
  return '';
}

const MAX_ARCHIVE_BYTES = 1500 * 1024 * 1024;   // 单个压缩包解压后超过这个量就不再展开
const MAX_ARCHIVES = 400;                        // 单次扫描最多展开这么多个包
const NEST_DEPTH = 2;                            // zip 里套 zip（一刻相册就是两层）
const CACHE_LIMIT = 3 * 1024 * 1024 * 1024;      // 解压缓存上限 3GB，超了删最旧的

function hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

function sevenZipPath() {
  const exe = process.platform === 'win32' ? '7za.exe' : '7za';
  const cands = [
    path.join(process.resourcesPath || '', exe),
    path.join(process.resourcesPath || '', '7za', exe),
    path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', exe),
    path.join(__dirname, '..', '..', '7zip-bin', 'win', 'x64', exe)
  ];
  for (const p of cands) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

function run(args, timeout = 300000) {
  const exe = sevenZipPath();
  if (!exe) return Promise.reject(new Error('no-7za'));
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout || '');
    });
  });
}

/** 列出压缩包条目：{ name, size, isDir } */
async function listArchive(file) {
  const out = await run(['l', '-slt', '-bd', '-bso0', '-bsp0', '-p-', file], 120000);
  const entries = [];
  let cur = null;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (cur && cur.name) entries.push(cur);
      cur = null;
      continue;
    }
    const i = line.indexOf(' = ');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 3);
    if (!cur) cur = {};
    if (key === 'Path') cur.name = val;
    else if (key === 'Size') cur.size = Number(val) || 0;
    else if (key === 'Attributes') cur.attrs = val;
    else if (key === 'Folder') cur.isDir = val === '+';
  }
  if (cur && cur.name) entries.push(cur);
  return entries.filter((e) => e.name && !e.name.endsWith('/') && !e.name.endsWith('\\'))
    .map((e) => ({
      name: e.name.replace(/\\/g, '/'),
      size: e.size || 0,
      isDir: !!(e.attrs && /\bD\b/.test(e.attrs)) || e.isDir === true
    }));
}

function extOf(p) {
  return path.extname(p).slice(1).toLowerCase();
}

async function extractTo(file, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  await run(['x', '-y', '-bd', '-bso0', '-bsp0', '-p-', '-o' + dest, file], 300000);
}

async function walkFiles(dir, base = '', out = []) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (rel.startsWith('__nested')) continue;
      await walkFiles(full, rel, out);
      continue;
    }
    let st;
    try { st = await fs.promises.stat(full); } catch { continue; }
    out.push({ path: full, rel, size: st.size, mtime: st.mtimeMs, btime: st.birthtimeMs });
  }
  return out;
}

/** 解一个包到缓存目录，并把里面套的小包也解开（最多 NEST_DEPTH 层） */
async function expandOne(file, cacheRoot, depth = 0, onTick) {
  const dir = path.join(cacheRoot, hash(file.path + '|' + file.size + '|' + Math.round(file.mtime || 0)));
  const done = path.join(dir, '.ok');
  if (fs.existsSync(done)) return dir;

  // 先看清单：太大就别解，避免把磁盘塞满
  let list = [];
  try { list = await listArchive(file.path); } catch { return null; }
  if (!list.length) return null;
  const mediaEntries = list.filter((e) => MEDIA_EXT.has(extOf(e.name)));
  if (!mediaEntries.length) return null;
  const totalMedia = mediaEntries.reduce((n, e) => n + (e.size || 0), 0);
  if (totalMedia > MAX_ARCHIVE_BYTES) return null;

  const tmp = dir + '.tmp-' + Math.random().toString(36).slice(2, 8);
  try {
    await extractTo(file.path, tmp);
    // 嵌套压缩包
    if (depth + 1 < NEST_DEPTH) {
      const inner = [];
      const all = await walkFiles(tmp);
      for (const f of all) {
        if (ARCHIVE_EXT.has(extOf(f.path)) && !f.rel.startsWith('__nested')) inner.push(f);
      }
      for (const f of inner.slice(0, MAX_ARCHIVES)) {
        const sub = path.join(tmp, '__nested', hash(f.path));
        try {
          await extractTo(f.path, sub);
          if (onTick) onTick();
        } catch { /* 单个小包失败跳过 */ }
      }
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    fs.writeFileSync(done, '1');
    return dir;
  } catch {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }
}

/** 清理缓存：超过总量上限就按最旧优先删 */
async function pruneCache(cacheRoot, limit = CACHE_LIMIT) {
  let dirs;
  try { dirs = await fs.promises.readdir(cacheRoot); } catch { return; }
  const stat = [];
  let total = 0;
  for (const d of dirs) {
    const p = path.join(cacheRoot, d);
    try {
      const s = await fs.promises.stat(p);
      if (!s.isDirectory()) continue;
      stat.push({ p, at: s.mtimeMs });
      total += await dirSize(p);
    } catch { /* ignore */ }
  }
  if (total <= limit) return;
  stat.sort((a, b) => a.at - b.at);
  for (const d of stat) {
    if (total <= limit) break;
    try {
      total -= await dirSize(d.p);
      await fs.promises.rm(d.p, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

async function dirSize(dir) {
  let n = 0;
  let list = [];
  try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) n += await dirSize(p);
      else n += (await fs.promises.stat(p)).size;
    } catch { /* ignore */ }
  }
  return n;
}

/**
 * 把一批压缩包展开，返回其中的媒体文件记录（带 arc / arcEntry 标记）
 */
async function expandArchives(archives, cacheRoot, onProgress, opts) {
  const allowAudio = !opts || opts.audio !== false;
  const allowDoc = !opts || opts.doc !== false;
  const out = [];
  const picked = archives.filter((a) => ARCHIVE_EXT.has(a.ext)).slice(0, MAX_ARCHIVES);
  let i = 0;
  for (const arc of picked) {
    i += 1;
    if (onProgress) onProgress(i, picked.length);
    const dir = await expandOne(arc, cacheRoot, 0);
    if (!dir) continue;
    const files = await walkFiles(dir);
    for (const f of files) {
      const ext = extOf(f.path);
      const kind = kindOf(ext);
      if (!kind) continue;
      if (kind === 'audio' && !allowAudio) continue;
      if (kind === 'doc' && !allowDoc) continue;
      out.push({
        path: f.path,
        ext,
        kind,
        size: f.size,
        mtime: f.mtime,
        btime: f.btime,
        arc: arc.path,
        arcEntry: f.rel
      });
    }
  }
  pruneCache(cacheRoot).catch(() => { /* ignore */ });
  return out;
}

module.exports = { ARCHIVE_EXT, expandArchives, listArchive, sevenZipPath, pruneCache };
