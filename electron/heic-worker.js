'use strict';
/*
 * HEIC/HEIF 解码工作线程
 * Chromium 自带解码器不支持 HEIF（iPhone 的 .HEIC 照片），
 * 所以在独立线程里用 libheif 的 wasm 版解码，再编码成 JPEG 落盘，
 * 主进程/界面只读 JPEG，完全避开主线程卡顿。
 */
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const Module = require('module');

function nmRoot() {
  if (process.env.ALBUM_NM && fs.existsSync(process.env.ALBUM_NM)) return process.env.ALBUM_NM;
  for (const p of [
    path.join(__dirname, '..', 'node_modules'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules'),
    path.join(process.resourcesPath || '', 'node_modules')
  ]) {
    if (p && fs.existsSync(path.join(p, 'libheif-js'))) return p;
  }
  return path.join(__dirname, '..', 'node_modules');
}

const NM = nmRoot();
const { createRequire } = require('module');

/* 用 node_modules 里的 package.json 作解析基准，保证 dev / asar 解包后都能找到资源 */
let libheif = null;
let jpeg = null;
try {
  const req = createRequire(path.join(NM, 'libheif-js', 'package.json'));
  libheif = req('libheif-js/wasm-bundle');
  jpeg = req('jpeg-js');
} catch (e) {
  libheif = require(path.join(NM, 'libheif-js'));
  jpeg = require(path.join(NM, 'jpeg-js'));
}
if (!libheif || typeof libheif.HeifDecoder !== 'function') throw new Error('libheif load failed');

function downscale(rgba, w, h, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  if (scale >= 1) return { data: rgba, width: w, height: h };
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8ClampedArray(nw * nh * 4);
  const xr = w / nw, yr = h / nh;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y * yr));
    const row = sy * w;
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x * xr));
      const si = (row + sx) * 4, di = (y * nw + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}

parentPort.on('message', async (msg) => {
  const { id, src, out, maxSide, quality } = msg;
  try {
    const buf = fs.readFileSync(src);
    const dec = new libheif.HeifDecoder();
    const imgs = dec.decode(buf);
    if (!imgs || !imgs.length) throw new Error('no-image');
    const image = imgs[0];
    const w = image.get_width();
    const h = image.get_height();
    const raw = new Uint8ClampedArray(w * h * 4);
    const data = await new Promise((res, rej) => {
      image.display({ data: raw, width: w, height: h }, (d) => (d ? res(d) : rej(new Error('display-failed'))));
    });
    const small = downscale(data.data, data.width || w, data.height || h, maxSide || 1600);
    const enc = jpeg.encode({ data: Buffer.from(small.data), width: small.width, height: small.height }, quality || 84);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, enc.data);
    parentPort.postMessage({ id, ok: true, w, h, out });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});
