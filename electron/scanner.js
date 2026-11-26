'use strict';

const path = require('path');
const fs = require('fs');
const exifr = require('exifr');

const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff',
  'heic', 'heif', 'avif', 'jxl', 'svg', 'ico', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'rw2', 'orf', 'pef', 'srw', 'erf', 'mrw', '3fr'
]);

const VIDEO_EXT = new Set([
  'mp4', 'mov', 'm4v', 'avi', 'flv', 'f4v', 'mkv', 'wmv', 'webm',
  '3gp', 'mts', 'm2ts', 'mpg', 'mpeg', 'ts', 'rmvb', 'rm'
]);

const IMAGE_EXTS = IMAGE_EXT;

/** 音频：设置里勾选后才会被收录 */
const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'ape', 'aif', 'aiff', 'amr', 'wv', 'mid', 'midi']);

/** 文档：设置里勾选后才会被收录（txt 之外的格式交给默认应用打开） */
const DOC_EXT = new Set(['txt', 'md', 'log', 'csv', 'json', 'xml', 'htm', 'html', 'rtf', 'srt', 'ass',
  'doc', 'docx', 'wps', 'ppt', 'pptx', 'dps', 'xls', 'xlsx', 'et', 'pdf', 'epub', 'ofd']);

/** 压缩包：可以被展开成素材（zip 里套实况 zips 的情况很常见） */
const ARCHIVE_EXT = new Set(['zip', '7z', 'rar', 'cbz', 'cbr', 'cab', 'iso', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
const VIDEO_EXTS = VIDEO_EXT;

/** 系统级、明显不该扫描的目录 */
const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'windows', 'windows.old',
  'node_modules', '.git', 'appdata', '$windows.~bt', 'recovery'
]);

/** 缩略图可由 Chromium 直接解码的格式（HEIC 等需要系统缩略图） */
const WEB_IMAGE_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp', 'svg', 'ico', 'avif']);

function extOf(p) {
  return path.extname(p).slice(1).toLowerCase();
}

function kindOf(ext, opts) {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (opts && opts.audio && AUDIO_EXT.has(ext)) return 'audio';
  if (opts && opts.doc && DOC_EXT.has(ext)) return 'doc';
  return null;
}

/* ---------------- 目录遍历 ---------------- */

async function walk(root, onFile, onTick, onArchive, opts) {
  const stack = [{ dir: root, depth: 0 }];
  let seen = 0;

  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= 14) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (entry.name.startsWith('.') && !(opts && opts.showHidden)) continue;
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.') && !(opts && opts.showHidden)) continue;

      const ext = extOf(full);
      const kind = kindOf(ext, opts);
      if (!kind) {
        if (onArchive && ARCHIVE_EXT.has(ext)) {
          try {
            const st = await fs.promises.stat(full);
            if (st.size > 0) onArchive({ path: full, ext, size: st.size, mtime: st.mtimeMs, btime: st.birthtimeMs });
          } catch { /* ignore */ }
        }
        continue;
      }

      let stat;
      try {
        stat = await fs.promises.stat(full);
      } catch {
        continue;
      }
      if (stat.size === 0) continue;

      onFile({ path: full, ext, kind, size: stat.size, mtime: stat.mtimeMs, btime: stat.birthtimeMs });
      seen += 1;
      if (seen % 40 === 0 && onTick) onTick(seen);
    }
  }
}

/* ---------------- EXIF 解析 ---------------- */

const IMAGE_PICK = [
  'DateTimeOriginal', 'CreateDate', 'ModifyDate', 'GPSLatitude', 'GPSLongitude',
  'GPSAltitude', 'Make', 'Model', 'LensModel', 'ExposureTime', 'FNumber', 'ISO',
  'FocalLength', 'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight',
  'Orientation', 'Software', 'latitude', 'longitude'
];

const VIDEO_PICK = [
  'CreateDate', 'MediaCreateDate', 'TrackCreateDate', 'ModifyDate', 'Duration',
  'GPSCoordinates', 'GPSLatitude', 'GPSLongitude', 'Make', 'Model',
  'ImageWidth', 'ImageHeight', 'latitude', 'longitude',
  'VideoFrameRate', 'FrameRate', 'AvgFrameRate', 'CompressorName', 'VideoCodec'
];

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[:/-](\d{2})[:/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const d = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6])
    );
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v) && typeof v[0] === 'number') return v[0];
  return null;
}

/**
 * 读取单个文件的元信息。返回部分字段，失败时返回 {}。
 */
async function readMeta(filePath, ext, kind) {
  const out = {};
  const isVideo = kind === 'video';

  // 视频体量大，exifr 需要读取 atom 结构，超过 80MB 时直接跳过（改用文件时间）
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return out;
  }
  if (isVideo && stat.size > 80 * 1024 * 1024) return out;
  if (!isVideo && stat.size > 240 * 1024 * 1024) return out;

  try {
    const data = await exifr.parse(filePath, {
      pick: isVideo ? VIDEO_PICK : IMAGE_PICK,
      translateValues: true,
      reviveValues: true,
      silentErrors: true,
      iptc: false, xmp: false, icc: false, jfif: false, ihdr: false
    });
    if (!data) return out;

    const shot = toDate(data.DateTimeOriginal) || toDate(data.CreateDate) || null;
    if (shot) {
      out.shotAt = shot;
      out.shotSource = 'exif';
    }

    let lat = num(data.latitude);
    let lon = num(data.longitude);
    if (lat === null || lon === null) {
      const g = data.GPSCoordinates;
      if (g && typeof g === 'object' && !Array.isArray(g)) {
        lat = num(g.latitude);
        lon = num(g.longitude);
      } else if (typeof g === 'string') {
        const parts = g.split(',').map(Number);
        if (parts.length >= 2 && Number.isFinite(parts[0])) {
          lat = parts[0]; lon = parts[1];
        }
      }
    }
    if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0)) {
      out.gps = { lat, lon, alt: num(data.GPSAltitude) };
    }

    const w = num(data.ExifImageWidth) || num(data.ImageWidth);
    const h = num(data.ExifImageHeight) || num(data.ImageHeight);
    if (w && h) out.pixel = { w, h };

    if (data.Make || data.Model) {
      out.camera = [data.Make ? String(data.Make).trim() : '', data.Model ? String(data.Model).trim() : '']
        .filter(Boolean).join(' ').replace(/\s+/g, ' ');
    }
    if (data.LensModel) out.lens = String(data.LensModel).trim();
    if (data.Software) out.software = String(data.Software).trim();
    const iso = num(data.ISO);
    const f = num(data.FNumber);
    const exp = num(data.ExposureTime);
    const focal = num(data.FocalLength);
    if (iso || f || exp || focal) {
      out.exposure = {
        iso: iso || null,
        f: f || null,
        shutter: exp ? (exp >= 1 ? `${exp}s` : `1/${Math.round(1 / exp)}s`) : null,
        focal: focal ? Math.round(focal) : null
      };
    }
    if (isVideo) {
      const dur = num(data.Duration);
      if (dur) out.duration = dur;
      const fps = num(data.VideoFrameRate) || num(data.FrameRate) || num(data.AvgFrameRate);
      if (fps && fps > 0 && fps < 300) out.fps = Math.round(fps * 100) / 100;
    }
  } catch {
    /* 无 EXIF 或格式不支持 */
  }
  return out;
}

module.exports = { walk, readMeta, kindOf, extOf, IMAGE_EXT, VIDEO_EXT, AUDIO_EXT, DOC_EXT, WEB_IMAGE_EXT, SKIP_DIRS, ARCHIVE_EXT };
