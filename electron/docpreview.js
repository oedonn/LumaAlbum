'use strict';

/**
 * 文档简单预览：文本直接读，docx/xlsx/pptx 从 OOXML 包里抽文字，PDF 交给内置 PDF 查看器。
 * 不依赖 Word/Office，也不安装额外解析库。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { sevenZipPath, listArchive } = require('./archive');

function runEntry(file, entry, timeout = 30000) {
  const exe = sevenZipPath();
  if (!exe) return Promise.reject(new Error('no-7za'));
  return new Promise((resolve, reject) => {
    execFile(exe, ['e', '-so', '-bd', '-bso0', '-bsp0', '-p-', file, entry],
      { windowsHide: true, maxBuffer: 40 * 1024 * 1024, timeout }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout || '');
      });
  });
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlText(xml) {
  return decodeEntities(String(xml || '')
    .replace(/<w:tab[^>]*\/>/gi, '\t')
    .replace(/<w:br[^>]*\/>/gi, '\n')
    .replace(/<\/w:p>/gi, '\n')
    .replace(/<\/a:p>/gi, '\n')
    .replace(/<\/row>/gi, '\n')
    .replace(/<\/c>/gi, '\t')
    .replace(/<[^>]+>/g, ''))
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function rtfText(src) {
  return String(src || '')
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\'[0-9a-f]{2}/gi, '')
    .replace(/\\[a-z]+(-?\d+)?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function previewDoc(file) {
  const ext = path.extname(String(file || '')).slice(1).toLowerCase();
  try {
    if (ext === 'pdf') return { ok: true, type: 'pdf' };
    if (ext === 'ofd') return { ok: true, type: 'none', text: 'OFD 文档暂不支持窗口内预览，请用默认应用打开。' };

    if (['txt', 'md', 'log', 'csv', 'json', 'xml', 'htm', 'html', 'srt', 'ass', 'ini', 'yml', 'yaml'].includes(ext)) {
      const raw = await fs.promises.readFile(file, 'utf8');
      const text = ext === 'htm' || ext === 'html' ? xmlText(raw) : raw;
      return { ok: true, type: 'text', text: text.slice(0, 200000) || '（空文件）' };
    }
    if (ext === 'rtf') {
      const raw = await fs.promises.readFile(file, 'utf8');
      return { ok: true, type: 'text', text: rtfText(raw).slice(0, 200000) || '（空文档）' };
    }

    if (ext === 'docx') {
      const xml = await runEntry(file, 'word/document.xml');
      return { ok: true, type: 'text', text: xmlText(xml).slice(0, 200000) || '（空文档）' };
    }
    if (ext === 'xlsx') {
      const entries = await listArchive(file);
      const names = [];
      const shared = entries.find((e) => e.name === 'xl/sharedStrings.xml');
      if (shared) {
        const xml = await runEntry(file, 'xl/sharedStrings.xml');
        const vals = Array.from(xml.matchAll(/<si[\s>][\s\S]*?<\/si>/gi)).map((m) => xmlText(m[0]));
        names.push(...vals);
      }
      if (!names.length) {
        const wb = entries.find((e) => e.name === 'xl/workbook.xml');
        if (wb) names.push(...Array.from(xmlText(await runEntry(file, 'xl/workbook.xml')).matchAll(/[^\n]+/g)).map((m) => m[0]));
      }
      return { ok: true, type: 'text', text: names.slice(0, 3000).join('\n').slice(0, 200000) || '表格内容较少，建议用默认应用查看。' };
    }
    if (ext === 'pptx') {
      const entries = await listArchive(file);
      const slides = entries
        .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
        .sort((a, b) => Number((a.name.match(/(\d+)\.xml/) || [])[1]) - Number((b.name.match(/(\d+)\.xml/) || [])[1]));
      const parts = [];
      for (const s of slides.slice(0, 80)) {
        const xml = await runEntry(file, s.name);
        const tx = xmlText(xml);
        if (tx) parts.push('第 ' + ((s.name.match(/(\d+)\.xml/) || [])[1] || '') + ' 页\n' + tx);
      }
      return { ok: true, type: 'text', text: parts.join('\n\n').slice(0, 200000) || '（空演示文稿）' };
    }

    return { ok: true, type: 'none', text: '该格式暂不支持窗口内预览，请点下面「用默认应用打开」。' };
  } catch (e) {
    return { ok: false, type: 'none', text: '预览失败：' + String((e && e.message) || e) };
  }
}

module.exports = { previewDoc };
