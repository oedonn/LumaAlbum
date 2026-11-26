'use strict';

/**
 * 安卓实况照片（Motion Photo）适配。
 *
 * 安卓/三星/谷歌相机的「动态照片」通常还是一张 JPEG：真正的视频以 MP4 形式
 * 追加在 JPEG 结尾，前面用 XMP 里的 MicroVideoOffset / MotionPhoto 标记。
 * 浏览器和普通图片查看器只认 JPEG 本体，所以这里把尾部视频抽到缓存目录，
 * 再交给现有实况播放链路使用。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const JPEG_EXT = new Set(['jpg', 'jpeg', 'jfif']);
const MAX_HEADER_SCAN = 768 * 1024;
const MAX_TAIL_SCAN = 80 * 1024 * 1024;

function hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 18);
}

function readRange(fd, start, length) {
  const buf = Buffer.alloc(Math.max(0, length));
  return fd.read(buf, 0, buf.length, start).then((r) => buf.subarray(0, r.bytesRead));
}

function findFtyp(buf, from) {
  for (let i = from || 0; i <= buf.length - 8; i += 1) {
    if (buf.toString('latin1', i, i + 4) === 'ftyp') return i - 4;
  }
  return -1;
}

async function extractTail(src, start, out) {
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  const tmp = out + '.part';
  try {
    await pipeline(fs.createReadStream(src, { start }), fs.createWriteStream(tmp));
    const st = await fs.promises.stat(tmp);
    if (!st.size || st.size < 64 * 1024) throw new Error('too-small');
    const fd = await fs.promises.open(tmp, 'r');
    const head = await readRange(fd, 0, 24);
    await fd.close();
    const ftyp = findFtyp(head, 0);
    if (ftyp < 0) throw new Error('not-mp4');
    await fs.promises.rename(tmp, out);
    return out;
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
    return null;
  }
}

/**
 * @param {string} file 原始 JPEG 路径
 * @param {string} cacheDir 缓存根目录
 * @param {number} mtime 文件修改时间（参与缓存 key）
 * @returns {Promise<{videoPath:string, offset:number}|null>}
 */
async function detectMotionPhoto(file, cacheDir, mtime) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!JPEG_EXT.has(ext)) return null;
  let st;
  try { st = await fs.promises.stat(file); } catch { return null; }
  if (st.size < 128 * 1024) return null;

  let head;
  let tail;
  const fd = await fs.promises.open(file, 'r');
  try {
    head = await readRange(fd, 0, Math.min(MAX_HEADER_SCAN, st.size));
    const tailLen = Math.min(256 * 1024, st.size);
    tail = await readRange(fd, st.size - tailLen, tailLen);
  } finally {
    await fd.close();
  }

  const headText = head.toString('latin1');
  const tailText = tail.toString('latin1');

  /* 标记与偏移：GCamera:MicroVideoOffset / Camera:MicroVideoOffset / MotionPhoto */
  const offMatch = (headText + tailText).match(/(?:GCamera:|Camera:)?MicroVideoOffset\s*=\s*["']?(\d{4,})/i)
    || (headText + tailText).match(/MicroVideoOffset\s*[:=]\s*["']?(\d{4,})/i);
  let offset = offMatch ? Number(offMatch[1]) : 0;
  let start = 0;

  if (offset > 0 && offset < st.size) {
    start = st.size - offset;
    /* 有偏移时先校验，偏移算法偶尔有 1~8 字节误差 */
    if (start < 0 || start > st.size - 16) start = 0;
  }

  const hasMotionFlag = /MotionPhoto|MicroVideo|Camera:MicroVideo/i.test(headText)
    || /MotionPhoto|MicroVideo|Camera:MicroVideo/i.test(tailText);
  if (!start && !hasMotionFlag) return null;

  if (!start) {
    /* 没有可靠偏移：在尾部找 MP4 的 ftyp，要求视频头前 4 字节是合法 box size */
    const probeLen = Math.min(MAX_TAIL_SCAN, st.size);
    const fd2 = await fs.promises.open(file, 'r');
    try { tail = await readRange(fd2, st.size - probeLen, probeLen); } finally { await fd2.close(); }
    const pos = findFtyp(tail, 0);
    if (pos < 0) return null;
    const boxSize = tail.readUInt32BE(pos);
    if (boxSize < 8 || boxSize > 4096) return null;
    start = st.size - tail.length + pos;
  }

  /* 从 start 往前/后校正到真正的 ftyp 位置 */
  {
    const probeLen = Math.min(64, st.size - start);
    const probeFd = await fs.promises.open(file, 'r');
    let probe;
    try { probe = await readRange(probeFd, start, probeLen); } finally { await probeFd.close(); }
    if (findFtyp(probe, 0) < 0) {
      /* 安卓 10 之前常见 offset 以视频结尾为基准，多算/少算几字节；向后找 16 字节 */
      for (let i = 1; i <= 16; i += 1) {
        const p2 = Buffer.alloc(Math.min(20, st.size - start - i));
        const f2 = await fs.promises.open(file, 'r');
        try {
          const b2 = await f2.read(p2, 0, p2.length, start + i);
          if (findFtyp(p2.subarray(0, b2.bytesRead), 0) >= 0) { start += i; break; }
        } finally { await f2.close(); }
      }
    }
  }

  if (start < 0 || start >= st.size - 64 * 1024) return null;

  const out = path.join(cacheDir, 'motion', hash(file + '|' + st.size + '|' + (mtime || 0) + '|' + start) + '.mp4');
  try {
    const old = await fs.promises.stat(out);
    if (old.size > 64 * 1024) return { videoPath: out, offset: start };
  } catch { /* no cache */ }

  const ok = await extractTail(file, start, out);
  if (!ok) return null;
  return { videoPath: out, offset: start };
}

module.exports = { detectMotionPhoto };
