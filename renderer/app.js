'use strict';

(() => {
  const api = window.album;

  /* ───────────────────────── 基础工具 ───────────────────────── */

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const IMG_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff',
    'heic', 'heif', 'avif', 'jxl', 'svg', 'ico', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'rw2', 'orf', 'pef', 'srw', 'erf', 'mrw', '3fr']);
  const VID_EXT = new Set(['mp4', 'mov', 'm4v', 'avi', 'flv', 'f4v', 'mkv', 'wmv', 'webm',
    '3gp', 'mts', 'm2ts', 'mpg', 'mpeg', 'ts', 'rmvb', 'rm']);
  const DIRECT_IMG = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp', 'svg', 'ico', 'avif']);
  /* 音频与文档：默认不显示，在设置里勾选后才参与扫描 */
  const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'ape', 'aif', 'aiff', 'amr', 'wv', 'mid', 'midi']);
  const DOC_EXT = new Set(['txt', 'md', 'log', 'csv', 'json', 'xml', 'htm', 'html', 'rtf', 'doc', 'docx', 'wps',
    'ppt', 'pptx', 'dps', 'xls', 'xlsx', 'et', 'pdf', 'epub', 'ofd', 'srt', 'ass']);
  const ARC_EXT = new Set(['zip', '7z', 'rar', 'cbz', 'cbr', 'cab', 'iso', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
  const TEXT_DOC = new Set(['txt', 'md', 'log', 'csv', 'json', 'xml', 'htm', 'html', 'srt', 'ass']);
  /* HEIC/HEIF 浏览器解不了，主进程会先转成 JPEG 再由自定义协议送出 */
  const HEIC_EXT = new Set(['heic', 'heif']);
  function isHeic(ext) { return HEIC_EXT.has(String(ext || '').toLowerCase()); }
  function imgUrl(it) { return isHeic(it && it.ext) ? mediaUrl(it.path) : fileUrl(it.path); }
  function canDirect(it) { return !!it && !it.virtual && (DIRECT_IMG.has(it.ext) || isHeic(it.ext)); }

  const PAGE = 240;

  const S = {
    root: null,
    items: [],
    byPath: new Map(),
    filtered: [],
    counts: { total: 0, image: 0, video: 0, live: 0 },
    filter: 'all',
    query: '',
    mode: 'all',
    payload: null,
    selected: new Set(),
    active: null,
    batch: false,
    rendered: 0,
    scanning: false,
    viewerOpen: false,
    dir: '',
    flat: false,
    dirTiles: [],
    viewerIdx: 0,
    openYears: new Set(),
    openMonths: new Set(),
    openHist: new Set(),
    invalid: new Map(),
    insToken: 0,
    viewerList: null,
    masonryCount: 0,
    aiPeople: {},
    aiFaces: {},
    binMode: false,
    binItems: [],
    binByPath: new Map(),
    viewerScreen: false,
    slideshow: false,
    slideshowPaused: false,
    slideTimer: 0,
    editToken: 0,
    sheetToken: 0,
    hiddenPaths: new Set()
  };

  const lib = {
    version: 1,
    history: [],
    favorites: [],
    categories: [],
    settings: {
      cell: 168, audio: false, doc: false, night: false, skipMoveConfirm: false,
      showHidden: false, visible: {}, sideOrder: null,
      autoAI: true, aiScreenshot: true, aiDoc: true, aiRaw: true,
      livePlay: true, videoAutoplay: true, slideSec: 4
    },
    dupGroups: [],
    hidden: [],
    manualHidden: [],
    searchHistory: [],
    edits: {}
  };

  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { api.librarySet(lib); }, 350);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fileUrl(p) {
    let u = String(p).replace(/\\/g, '/');
    if (!u.startsWith('/')) u = '/' + u;
    return 'file://' + encodeURI(u).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }
  /* 视频与实况走自定义协议：打包后 file:// 的 <video> 会被 Chromium 直接拒绝 */
  function mediaUrl(p) {
    let u = String(p).replace(/\\/g, '/');
    if (!u.startsWith('/')) u = '/' + u;
    return 'album-media://media' + encodeURI(u).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }

  /* 导出后的文件名常是 IMG_0205.JPG.jpeg 这种双后缀，显示时去掉多余的一层 */
  function niceName(name) {
    const s = String(name || '');
    const m = s.match(/^(.+\.(?:jpg|jpeg|png|heic|heif|mov|mp4))\.(?:jpg|jpeg|png|mov|mp4)$/i);
    return m ? m[1] : s;
  }
  function extOf(p) {
    const m = String(p).match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  }

  function baseName(p) {
    const parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || String(p);
  }

  function dirOf(p) {
    const text = String(p || '').replace(/[\\/]+$/, '');
    const i = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
    return i > 2 ? text.slice(0, i) : '';
  }

  function sizeLabel(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024 * 1024) return (v / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
    if (v >= 1024) return Math.round(v / 1024) + ' KB';
    return v + ' B';
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function fmtDur(sec) {
    if (!sec || !Number.isFinite(sec)) return '—';
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
  }

  function dtOf(it) {
    const e = it && lib && lib.edits ? lib.edits[it.path] : null;
    if (e && e.date) {
      const ed = new Date(e.date);
      if (!Number.isNaN(ed.getTime())) return ed;
    }
    const t = it.shotAt || it.mtime || it.btime;
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function rawDateOf(it) {
    const e = editOf(it);
    if (e && e.original && e.original.date) {
      const od = new Date(e.original.date);
      if (!Number.isNaN(od.getTime())) return od;
    }
    const t = (it && (it.shotAt || it.mtime || it.btime)) || 0;
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function editOf(it) { return (it && lib.edits && lib.edits[it.path]) || null; }
  function effPlace(it) {
    const e = editOf(it);
    return (e && e.place) || it.place || '';
  }
  function lookupItem(p) {
    return S.binByPath.get(p) || S.byPath.get(p) || itemForPath(p);
  }

  function fmtDate(d) { return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; }
  function fmtDateShort(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function fmtTime(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  function fmtFull(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '—';
    return `${fmtDateShort(d)} ${fmtTime(d)}`;
  }

  const KIND_LABEL = { image: '图片', video: '视频', live: '实况', audio: '音频', doc: '文档', archive: '压缩包' };

  /* ───────────────────────── 图标 ───────────────────────── */

  const svg = (paths, w = 14) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    folder: svg('<path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.6l1.5 1.8h5.5A2.2 2.2 0 0 1 18.5 9v6.4A2.2 2.2 0 0 1 16.3 17.6H5.2A2.2 2.2 0 0 1 3 15.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>'),
    archive: svg('<rect x="3.8" y="5" width="16.4" height="14" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9.3 5v5.6h5.4V5M9.3 13.6h5.4M12 16.2v.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
    clock: svg('<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12 8v4.4l3 1.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'),
    pin: svg('<path d="M9.3 4.6h5.4l-.6 3.8 2.2 2.8H7.7l2.2-2.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M12 11.4v7.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>', 13),
    pinFill: svg('<path d="M9.3 4.6h5.4l-.6 3.8 2.2 2.8H7.7l2.2-2.8z" fill="currentColor" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M12 11.4v7.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>', 13),
    star: svg('<path d="M12 4.2l2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2-3.8-3.6 5.2-.7z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>', 13),
    starFill: svg('<path d="M12 4.2l2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2-3.8-3.6 5.2-.7z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>', 13),
    x: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>', 11),
    plus: svg('<path d="M12 6v12M6 12h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>', 11),
    chevron: svg('<path d="M9 6.5l6 5.5-6 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>', 11),
    pencil: svg('<path d="M15.5 5.5l3 3-9 9-3.6.6.6-3.6 9-9z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>', 12),
    trash: svg('<path d="M5.5 7h13M9.5 7V5.5h5V7M7 7l.8 10.5h8.4L17 7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>', 12),
    image: svg('<rect x="4" y="5.5" width="16" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M5.5 16.5l4.5-4 3 2.6 2.2-2 3.3 3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'),
    video: svg('<rect x="3.5" y="6" width="12.5" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M16 10.2l4.2-2.2v8l-4.2-2.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'),
    live: svg('<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.6 5.6a9 9 0 1 0 0 12.8M18.4 5.6a9 9 0 0 0-3-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
    check: svg('<path d="M5.5 12.5l4 4 9-9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>', 10),
    play: svg('<path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor"/>', 9),
    grid: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/>', 13),
    chevL: svg('<path d="M14.5 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>', 15),
    chevR: svg('<path d="M9.5 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>', 15),
    close: svg('<path d="M7 7l10 10M17 7l-10 10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>', 13),
    locate: svg('<circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12 3v2.4M12 18.6v2.4M3 12h2.4M18.6 12h2.4" stroke="currentColor" stroke-width="1.4"/>', 12),
    expand: svg('<path d="M8.5 4.5H4.5v4M15.5 4.5h4v4M8.5 19.5H4.5v-4M15.5 19.5h4v-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M9 15L4.8 19.2M15 9l4.2-4.2M9 9L4.8 4.8M15 15l4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>', 15),
    collapse: svg('<path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M8.8 8.8L4.5 4.5M15.2 8.8l4.3-4.3M8.8 15.2L4.5 19.5M15.2 15.2l4.3 4.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>', 15),
    pause: svg('<path d="M9 6v12M15 6v12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>', 13),
    playMini: svg('<path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor"/>', 12),
    person: svg('<circle cx="12" cy="9.2" r="3.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.8 19.2c.5-3.1 3.1-4.9 6.2-4.9s5.7 1.8 6.2 4.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>', 13),
    spark: svg('<path d="M12 4.2l1.7 4.9 4.9 1.7-4.9 1.7L12 17.4l-1.7-4.9L5.4 10.8l4.9-1.7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>', 13),
    music: svg('<path d="M9 17.2V7.4l8-1.7v9.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="6.8" cy="17.2" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="14.8" cy="14.9" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/>', 13),
    doc: svg('<path d="M7 4.5h6.2l3.8 3.8v11.2H7z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M13 4.5v4h4M9.4 12h5.2M9.4 15h5.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>', 13),
    folderOpen: svg('<path d="M3.5 8.5V7a2 2 0 0 1 2-2h3.4l1.4 1.7h5.2a2 2 0 0 1 2 2v.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 9.5h17l-1.8 6.4a1.6 1.6 0 0 1-1.5 1.1H6.2a1.6 1.6 0 0 1-1.5-1.1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>', 12)
  };

  /* ───────────────────────── 元素引用 ───────────────────────── */

  const grid = $('#grid');
  const sentinel = $('#sentinel');
  const stageBody = $('#stageBody');
  const emptyBox = $('#empty');
  const loadingBox = $('#loading');
  const loadingText = $('#loadingText');
  const crumb = $('#crumb');
  const countText = $('#countText');
  const sidebar = $('#sideScroll');
  const inspector = $('#inspector');
  const batchbar = $('#batchbar');
  const viewer = $('#viewer');
  const modalRoot = $('#modalRoot');
  const toastEl = $('#toast');
  const searchInput = $('#searchInput');
  const zoom = $('#zoom');
  const dropHint = $('#dropHint');

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
      setTimeout(() => { toastEl.hidden = true; }, 250);
    }, 2200);
  }

  /* ───────────────────────── 数据加载 ───────────────────────── */

  function loadLibrary(data) {
    if (!data || typeof data !== 'object') return;
    lib.history = Array.isArray(data.history) ? data.history.filter((h) => h && h.path) : [];
    lib.favorites = Array.isArray(data.favorites) ? data.favorites.filter(Boolean) : [];
    lib.categories = Array.isArray(data.categories) ? data.categories.map((c) => ({
      id: c.id || 'c' + Math.random().toString(36).slice(2, 8),
      name: c.name || '未命名',
      items: Array.isArray(c.items) ? c.items.filter(Boolean) : [],
      at: c.at || Date.now()
    })) : [];
    lib.settings = Object.assign({
      cell: 168, audio: false, doc: false, night: false, skipMoveConfirm: false,
      showHidden: false, visible: {}, sideOrder: null,
      autoAI: true, aiScreenshot: true, aiDoc: true, aiRaw: true,
      livePlay: true, videoAutoplay: true, slideSec: 4
    }, data.settings || {});
  dedupeHistory();
    lib.dupGroups = Array.isArray(data.dupGroups) ? data.dupGroups : [];
    lib.hidden = Array.isArray(data.hidden) ? data.hidden : [];
    lib.manualHidden = Array.isArray(data.manualHidden) ? data.manualHidden.filter(Boolean) : [];
    lib.searchHistory = Array.isArray(data.searchHistory) ? data.searchHistory.filter(Boolean).slice(0, 14) : [];
    lib.edits = data.edits && typeof data.edits === 'object' ? data.edits : {};
    lib.lastPath = typeof data.lastPath === 'string' ? data.lastPath : '';
  }

  function applyCell(size) {
    const v = Math.max(100, Math.min(280, Number(size) || 168));
    lib.settings.cell = v;
    document.documentElement.style.setProperty('--cell', v + 'px');
    zoom.value = String(v);
  }

  /* ───────────────────────── 统一来源选择器（文件夹或压缩包） ───────────────────────── */

  function openSourcePicker() {
    const startRaw = String(lib.lastPath || S.root || '').trim();
    const start = pathAllowed(startRaw) ? startRaw : '';
    const pathKey = (v) => String(v || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
    /* 当前看的是文件夹：直接列它里面的子文件夹和压缩包，压缩包和未压缩文件夹同时可选。
       当前看的是压缩包：退到它所在目录，并把该压缩包预先选中，方便看同级的其他来源。
       想换到任意其他目录时，点路径栏里的「选择文件夹」走系统对话框，不必反复点上一级。 */
    const startIsArchive = ARC_EXT.has(extOf(start));
    const startParent = dirOf(start);
    const pickStart = startIsArchive && startParent ? startParent : start;
    const preselect = startIsArchive ? start : '';
    const state = { path: '', parent: '', rows: [], sel: null, req: 0, loading: true, preselect };
    const folderIco = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4l1.6 1.8h7.4A2.5 2.5 0 0 1 21 8.3v9.2A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    const archiveIco = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v11A2.5 2.5 0 0 1 17.5 21h-11A2.5 2.5 0 0 1 4 18.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9.5 5v6.2h5V5M9.5 14h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

    openModal(`
      <div class="source-picker">
        <div class="sp-head">
          <div>
            <h3>打开文件夹或压缩包</h3>
            <div class="sub">文件夹和压缩包都直接列在这里，点选后一个按钮打开。</div>
          </div>
          <button class="sp-close" data-sp="close" title="关闭">×</button>
        </div>
        <div class="sp-nav">
          <button class="sp-up" data-sp="up" title="上一级">↑</button>
          <input class="sp-path" id="spPath" spellcheck="false" placeholder="输入路径后回车" />
          <button class="sp-browse" data-sp="browse" title="打开系统对话框，直接选择任意文件夹">选择文件夹</button>
          <button class="sp-go" data-sp="go">转到</button>
        </div>
        <div class="sp-list" id="spList"><div class="sp-loading">正在读取…</div></div>
        <div class="sp-foot">
          <span class="sp-select" id="spSelect">可直接打开当前文件夹</span>
          <button class="btn-ghost" data-sp="cancel">取消</button>
          <button class="btn-primary" id="spOpen" data-sp="open">打开当前文件夹</button>
        </div>
      </div>`, (m) => {
      m.classList.add('source-modal');
      const list = m.querySelector('#spList');
      const pathIn = m.querySelector('#spPath');
      const selText = m.querySelector('#spSelect');
      const openBtn = m.querySelector('#spOpen');

      const paint = () => {
        const sel = state.sel;
        if (sel) {
          selText.textContent = (sel.type === 'archive' ? '压缩包：' : '文件夹：') + sel.name;
          openBtn.textContent = sel.type === 'archive' ? '打开这个压缩包' : '打开这个文件夹';
        } else {
          selText.textContent = state.path ? '当前：' + state.path : '正在读取…';
          openBtn.textContent = '打开当前文件夹';
        }
        if (!state.loading && document.activeElement !== pathIn) pathIn.value = state.path || '';
        if (state.loading) {
          list.innerHTML = '<div class="sp-loading">正在读取…</div>';
          return;
        }
        if (!state.rows.length) {
          list.innerHTML = '<div class="sp-empty">这里没有子文件夹或压缩包<br><span style="opacity:.7">可以换一个目录看看</span></div>';
          return;
        }
        list.innerHTML = state.rows.map((r, i) => `
          <div class="sp-row${sel && sel.path === r.path ? ' on' : ''}" data-sp-row="${i}" title="${escapeHtml(r.path)}">
            <span class="sp-ico${r.type === 'archive' ? ' archive' : ''}">${r.type === 'archive' ? archiveIco : folderIco}</span>
            <span class="sp-main"><span class="sp-name">${escapeHtml(r.name)}<span class="sp-kind">${r.type === 'archive' ? '压缩包' : '文件夹'}</span></span><span class="sp-path-sub">${escapeHtml(r.path)}</span></span>
            ${r.type === 'archive' ? `<span class="sp-size">${fmtSize(r.size)}</span>` : ''}
          </div>`).join('');
      };

      const load = async (p) => {
        const token = ++state.req;
        state.loading = true;
        state.sel = null;
        paint();
        let r;
        try { r = await api.listDir(p, { showHidden: !!lib.settings.showHidden }); } catch (e) { r = { error: String((e && e.message) || e) }; }
        if (token !== state.req) return;
        state.loading = false;
        if (!r || r.error) {
          selText.textContent = (r && r.error) || '无法打开这个目录';
          list.innerHTML = '<div class="sp-empty">' + escapeHtml((r && r.error) || '无法打开这个目录') + '</div>';
          openBtn.disabled = true;
          return;
        }
        openBtn.disabled = false;
        state.path = r.path || p;
        state.parent = r.parent || '';
        state.rows = [
          ...(r.dirs || []).map((x) => ({ ...x, type: 'dir' })),
          ...(r.archives || []).map((x) => ({ ...x, type: 'archive' }))
        ];
        const current = state.preselect
          ? state.rows.find((x) => pathKey(x.path) === pathKey(state.preselect))
          : null;
        state.sel = current || null;
        state.preselect = '';
        paint();
      };

      const openSource = (p) => {
        if (!p) return;
        closeModal();
        openFolder(p);
      };

      const openSelected = () => {
        if (state.sel) openSource(state.sel.path);
        else if (state.path) openSource(state.path);
      };

      const go = () => {
        const v = String(pathIn.value || '').trim();
        if (!v) return;
        const ext = extOf(v);
        if (ARC_EXT.has(ext)) openSource(v);
        else load(v);
      };

      list.addEventListener('click', (e) => {
        const row = e.target.closest('[data-sp-row]');
        if (!row) return;
        const i = Number(row.dataset.spRow);
        if (!Number.isFinite(i) || !state.rows[i]) return;
        state.sel = state.rows[i];
        list.querySelectorAll('.sp-row').forEach((x) => x.classList.toggle('on', x === row));
        paint();
      });
      list.addEventListener('dblclick', (e) => {
        const row = e.target.closest('[data-sp-row]');
        if (!row) return;
        const i = Number(row.dataset.spRow);
        const item = state.rows[i];
        if (!item) return;
        if (item.type === 'dir') load(item.path);
        else openSource(item.path);
      });
      pathIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); go(); }
      });
      m.addEventListener('click', (e) => {
        const b = e.target.closest('[data-sp]');
        if (!b) return;
        const act = b.dataset.sp;
        if (act === 'close' || act === 'cancel') closeModal();
        else if (act === 'up') { if (state.parent) load(state.parent); }
        else if (act === 'browse') {
          api.pickFolder(state.path).then((picked) => {
            if (picked) openSource(picked);
          }).catch(() => { /* ignore */ });
        }
        else if (act === 'go') go();
        else if (act === 'open') openSelected();
      });
      m.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
      });
      load(pickStart);
    });
  }

  /* ───────────────────────── 目录打开 / 扫描 ───────────────────────── */

  async function openFolder(p) {
    if (!p) return;
    if (S.scanning) return;
    aiView.hidden = true; S.dupOnly = false;
    S.binMode = false;
    S.binItems = [];
    S.binByPath.clear();
    S.scanning = true;
    loadingBox.hidden = false;
    loadingText.textContent = '正在扫描…';
    emptyBox.hidden = true;

    const stopProg = api.onScanProgress((e) => {
      if (!e || !e.total) return;
      const pct = Math.round((e.done / e.total) * 100);
      loadingText.textContent = e.unpack
        ? `正在解压压缩包 · ${e.done.toLocaleString()} / ${e.total.toLocaleString()}（${pct}%）`
        : `正在读取拍摄信息 · ${e.done.toLocaleString()} / ${e.total.toLocaleString()}（${pct}%）`;
    });
    const res = await api.scan(p, {
      audio: !!lib.settings.audio,
      doc: !!lib.settings.doc,
      showHidden: !!lib.settings.showHidden
    });
    if (stopProg) stopProg();
    S.scanning = false;

    if (!res || res.error) {
      loadingBox.hidden = true;
      toast((res && res.error) || '无法打开此文件夹或压缩包');
      markInvalid(p, true);
      return;
    }
    loadingBox.hidden = true;

    S.root = res.root;
    S.items = res.items || [];
    S.counts = res.counts || { total: S.items.length, image: 0, video: 0, live: 0 };
    S.byPath = new Map(S.items.map((it) => [it.path, it]));
    S.filter = 'all';
    S.query = '';
    searchInput.value = '';
    S.mode = 'all';
    S.payload = null;
    S.selected.clear();
    S.active = null;
    S.openYears.clear();
    S.openMonths.clear();
    S.dir = '';
    S.flat = false;

    pushHistory(res.root);
    buildDirTree();
    recordHistoryDirs(res.root);
    refreshHiddenPaths().then(renderSidebar);
    syncFilterButtons();
    markInvalid(res.root, false);

    $$('#segFilter button').forEach((b) => b.classList.toggle('on', b.dataset.filter === 'all'));
    pathChipSet(res.root, true);

    renderAll();
    showInspector(null);

    /* 每次扫描后自动后台识别（含相似素材） */
    if (lib.settings.autoAI !== false && S.items.length && S.items.length <= 1500) {
      setTimeout(() => { if (!aiState.running) runAI(true); }, 900);
    }
  }

  /* 把本次扫描到的目录树记进历史条目，左侧就能像自动分类那样展开子目录 */
  function recordHistoryDirs(root) {
    const h = lib.history.find((x) => String(x.path).toLowerCase() === String(root).toLowerCase());
    if (!h) return;
    const list = [];
    for (const [rel, node] of dirTree) {
      if (!rel) continue;
      list.push({ rel, n: node.total });
    }
    list.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hans-CN'));
    h.dirs = list.slice(0, 500);
    h.dirsAt = Date.now();
    persist();
  }

  function syncFilterButtons() {
    $$('#segFilter button[data-filter="audio"]').forEach((b) => { b.hidden = !lib.settings.audio; });
    $$('#segFilter button[data-filter="doc"]').forEach((b) => { b.hidden = !lib.settings.doc; });
    if (!lib.settings.audio && S.filter === 'audio') S.filter = 'all';
    if (!lib.settings.doc && S.filter === 'doc') S.filter = 'all';
  }

  function isUnder(child, parent) {
    const c = String(child || '').toLowerCase().replace(/\\+/g, '\\');
    const q = String(parent || '').toLowerCase().replace(/\\+/g, '\\').replace(/\\$/, '');
    return !!q && c.length > q.length && c.indexOf(q + '\\') === 0;
  }

  /* 路径里的隐藏项：点号开头，以及常见 Windows 隐藏系统目录；关闭「显示隐藏文件」时从本地路径列表里剔除 */
  const HIDDEN_PATH_SEGMENTS = new Set(['appdata','application data','local settings','cookies','nethood','printhood','recent','sendto','templates','my documents','start menu','「开始」菜单','system volume information','$recycle.bin','$windows.~bt','recovery','config.msi','msocache']);
  function hiddenPathKey(p) {
    return String(p || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
  }
  function pathAllowed(p) {
    if (lib.settings && lib.settings.showHidden) return true;
    if (S.hiddenPaths && S.hiddenPaths.has(hiddenPathKey(p))) return false;
    const segs = String(p || '').split(/[\\/]+/).filter(Boolean);
    return !segs.some((seg) => seg.startsWith('.') || HIDDEN_PATH_SEGMENTS.has(seg.toLowerCase()));
  }
  async function refreshHiddenPaths() {
    const paths = Array.from(new Set([...(lib.history || []).map((h) => h && h.path), ...(lib.favorites || []), lib.lastPath].filter(Boolean)));
    if (!paths.length) { S.hiddenPaths = new Set(); return; }
    try {
      const hidden = await api.hiddenPaths(paths);
      S.hiddenPaths = new Set((hidden || []).map(hiddenPathKey));
    } catch { S.hiddenPaths = new Set(); }
  }

  function dedupeHistory() {
    const keep = [];
    lib.history.forEach((h) => {
      if (keep.some((k) => isUnder(h.path, k.path))) return;
      keep.push(h);
    });
    /* 反过来：如果新条目是已有条目的父目录，就吞掉子条目 */
    const out = [];
    keep.forEach((h) => {
      if (!out.some((k) => isUnder(k.path, h.path))) out.push(h);
      else {
        for (let i = out.length - 1; i >= 0; i--) if (isUnder(out[i].path, h.path)) out.splice(i, 1);
        out.push(h);
      }
    });
    if (out.length !== lib.history.length) lib.history = out;
  }

  function pushHistory(p) {
    /* 点击已有条目不再改变顺序；新路径追加到末尾，位置由「置顶 / 拖拽」自己决定。
       打开的是某个历史目录的子目录时，只更新父条目，避免出现重复的同一层级。 */
    lib.lastPath = p;
    const idx = lib.history.findIndex((h) => h.path.toLowerCase() === p.toLowerCase());
    if (idx >= 0) {
      lib.history[idx].at = Date.now();
      persist();
      return;
    }
    const parent = lib.history.find((h) => isUnder(p, h.path) || isUnder(h.path, p));
    if (parent) {
      if (isUnder(p, parent.path)) {
        parent.at = Date.now();
        persist();
        return;
      }
      parent.path = p;
      parent.at = Date.now();
      persist();
      return;
    }
    lib.history.push({ path: p, at: Date.now(), pinned: false });
    dedupeHistory();
    if (lib.history.length > 24) lib.history = lib.history.slice(lib.history.length - 24);
    persist();
  }

  function markInvalid(p, bad) {
    S.invalid.set(p.toLowerCase(), bad);
    renderSidebar();
  }

  async function refreshValidity() {
    const paths = lib.history.map((h) => h.path).concat(lib.favorites);
    if (!paths.length) return;
    const res = await api.exists(paths);
    paths.forEach((p, i) => S.invalid.set(p.toLowerCase(), !res[i]));
    renderSidebar();
  }

  function pathChipSet(p, ok) {
    const chip = $('#pathChip');
    const txt = $('#pathText');
    const dot = $('#pathDot');
    if (!p) {
      txt.textContent = '未选择文件夹';
      chip.title = '尚未选择文件夹';
      dot.className = 'dot';
      return;
    }
    txt.textContent = p;
    chip.title = p;
    dot.className = 'dot ' + (ok ? 'live' : 'dead');
  }

  /* ───────────────────────── 过滤与分组 ───────────────────────── */

  function itemForPath(p) {
    const found = S.byPath.get(p);
    if (found) return found;
    const ext = extOf(p);
    const kind = VID_EXT.has(ext) ? 'video'
      : AUDIO_EXT.has(ext) ? 'audio'
        : DOC_EXT.has(ext) ? 'doc' : 'image';
    return {
      id: 'v:' + p, path: p, name: baseName(p), ext, kind,
      size: 0, mtime: 0, virtual: true
    };
  }

  /* ───────────────── 目录浏览：按子文件夹分开显示 ───────────────── */

  let dirTree = new Map();  // rel -> { rel, name, direct: [it], total, cover }
  let dirKids = new Map();  // rel -> [rel]

  function normSlashes(p) { return String(p || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/'); }

  /* 相对打开文件夹的目录：'家人/自己' 或 ''（根目录） */
  function relDirOf(p) {
    const root = normSlashes(S.root).replace(/\/+$/, '');
    if (!root) return '';
    const path = normSlashes(p);
    const low = path.toLowerCase();
    const rootLow = root.toLowerCase();
    if (!low.startsWith(rootLow + '/')) return '';
    const rest = path.slice(root.length + 1);
    const i = rest.lastIndexOf('/');
    return i < 0 ? '' : rest.slice(0, i);
  }

  /* 素材属于哪一层目录：压缩包里的素材用解包前它所在的目录 */
  function dirKeyOf(it) {
    if (it && typeof it.dirKey === 'string') return it.dirKey;
    if (it && typeof it.arcDir === 'string') return it.arcDir;
    return relDirOf(it ? it.path : '');
  }

  function parentRel(rel) {
    if (!rel) return null;
    const i = rel.lastIndexOf('/');
    return i < 0 ? '' : rel.slice(0, i);
  }

  function buildDirTree() {
    dirTree = new Map();
    dirKids = new Map();
    const rootName = baseName(S.root || '') || '全部素材';
    dirTree.set('', { rel: '', name: rootName, direct: [], total: 0, cover: null });
    for (const it of S.items) {
      const rel = dirKeyOf(it);
      let acc = '';
      for (const seg of (rel ? rel.split('/') : [])) {
        acc = acc ? acc + '/' + seg : seg;
        if (!dirTree.has(acc)) dirTree.set(acc, { rel: acc, name: seg, direct: [], total: 0, cover: null });
      }
      dirTree.get(rel).direct.push(it);
    }
    for (const rel of Array.from(dirTree.keys())) {
      const par = parentRel(rel);
      if (par === null) continue;
      if (!dirKids.has(par)) dirKids.set(par, []);
      dirKids.get(par).push(rel);
    }
    for (const kids of dirKids.values()) kids.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    /* 总数与封面向上累计：封面优先用照片，其次实况，最后视频 */
    const rank = (x) => (x && x.kind === 'image' ? 0
      : x && x.kind === 'live' ? 1
        : x && x.kind === 'video' ? 2
          : x && x.kind === 'archive' ? 9 : 3);
    for (const it of S.items) {
      let cur = dirKeyOf(it);
      while (cur !== null) {
        const node = dirTree.get(cur);
        if (node) {
          node.total += 1;
          if (!node.cover || rank(it) < rank(node.cover)) node.cover = it;
        }
        cur = parentRel(cur);
      }
    }
  }

  /* 目录模式：仅「全部」标签、不搜索、未切到合并显示时生效 */
  function isDirMode() {
    return !S.binMode && !S.flat && S.mode === 'all' && S.filter === 'all' && !S.query.trim();
  }

  function dirTilesOf(rel) {
    const kids = dirKids.get(rel) || [];
    const out = [];
    for (const r of kids) {
      const n = dirTree.get(r);
      if (!n) continue;
      out.push({
        kind: 'dir',
        rel: n.rel,
        name: n.name,
        path: normSlashes(S.root) + '/' + n.rel,
        total: n.total,
        own: n.direct.length,
        cover: n.cover
      });
    }
    return out;
  }

  function enterDir(rel) {
    const target = String(rel || '');
    if (!dirTree.has(target)) return;
    S.dir = target;
    S.selected.clear();
    S.active = null;
    showInspector(null);
    renderList(true);
  }

  /* ───────────── 排序：日期 / 大小 / 地点 / 类型 / 名称 ───────────── */
  const SORT_OPTS = [
    { k: 'date',  n: '日期',     d: 'desc', asc: '旧→新', desc: '新→旧' },
    { k: 'size',  n: '文件大小', d: 'desc', asc: '小→大', desc: '大→小' },
    { k: 'place', n: '拍摄地点', d: 'asc',  asc: '有地点优先', desc: '无地点优先' },
    { k: 'kind',  n: '类型',     d: 'asc',  asc: '图片优先', desc: '音频·文档优先' },
    { k: 'name',  n: '文件名',   d: 'asc',  asc: 'A→Z', desc: 'Z→A' }
  ];
  function sortState() {
    const st = (lib.settings && lib.settings.sort) || {};
    const k = SORT_OPTS.some((o) => o.k === st.k) ? st.k : 'date';
    return { k, dir: st.dir === 'asc' || st.dir === 'desc' ? st.dir : (SORT_OPTS.find((o) => o.k === k) || SORT_OPTS[0]).d };
  }
  function sortCustom() {
    const st = (lib.settings && lib.settings.sort) || {};
    return !!st.custom && SORT_OPTS.some((o) => o.k === st.k);
  }
  const KIND_RANK = { image: 0, live: 1, video: 2, audio: 3, doc: 4 };
  function applySort(list) {
    const st = sortState();
    const mul = st.dir === 'asc' ? 1 : -1;
    const tOf = (it) => { const d = dtOf(it); return d ? d.getTime() : 0; };
    const copy = list.slice();
    copy.sort((x, y) => {
      let r = 0;
      if (st.k === 'date') {
        r = tOf(x) - tOf(y);
      } else if (st.k === 'size') {
        r = (x.size || 0) - (y.size || 0);
        if (!r) r = tOf(x) - tOf(y);
      } else if (st.k === 'kind') {
        r = (KIND_RANK[x.kind] ?? 9) - (KIND_RANK[y.kind] ?? 9);
        if (!r) r = tOf(x) - tOf(y);
      } else if (st.k === 'name') {
        const nx = typeof niceName === 'function' ? niceName(x.name || '') : String(x.name || '');
        const ny = typeof niceName === 'function' ? niceName(y.name || '') : String(y.name || '');
        r = nx.localeCompare(ny, 'zh-Hans-CN', { numeric: true });
        if (!r) r = tOf(x) - tOf(y);
      } else if (st.k === 'place') {
        const gx = x.gps, gy = y.gps;
        if (!!gx !== !!gy) r = gx ? -1 : 1;
        else if (gx && gy) {
          const px = x.place || '', py = y.place || '';
          r = px && py ? px.localeCompare(py, 'zh-Hans-CN') : 0;
          if (!r) r = (gx.lat - gy.lat) || (gx.lon - gy.lon);
        } else r = tOf(x) - tOf(y);
      }
      return r * mul;
    });
    return copy;
  }

  /* 手动隐藏：缓存里同名文件重新解压后路径会变，按文件名兜底匹配 */
  const CACHE_ARC_RE = /\\data\\cache\\archive\\/i;
  function hiddenBase(p) { return String(baseName(String(p || '')) || '').toLowerCase(); }
  function hiddenHas(set, it) {
    if (!it || !it.path) return false;
    if (set.has(it.path)) return true;
    if (!CACHE_ARC_RE.test(it.path)) return false;
    const nm = String(it.name || '').toLowerCase();
    for (const p of set) if (CACHE_ARC_RE.test(p) && hiddenBase(p) === nm) return true;
    return false;
  }
  function hiddenEntryMatches(p, target) {
    if (p === target) return true;
    if (!CACHE_ARC_RE.test(p) || !CACHE_ARC_RE.test(target)) return false;
    return hiddenBase(p) === hiddenBase(target);
  }
  function computeFiltered() {
    let list = S.binMode ? S.binItems : S.items;
    if (S.binMode) { S.dirTiles = []; return applySort(list); }

    /* 目录模式：只显示当前这一层目录里的文件，子目录单独成卡片 */
    if (isDirMode()) {
      list = list.filter((it) => dirKeyOf(it) === S.dir);
    }
    S.dirTiles = isDirMode() ? dirTilesOf(S.dir) : [];

    if (S.mode === 'date') {
      const { y, m, d } = S.payload || {};
      list = list.filter((it) => {
        const dt = dtOf(it);
        if (!dt) return false;
        if (dt.getFullYear() !== y) return false;
        if (m && dt.getMonth() + 1 !== m) return false;
        if (d && dt.getDate() !== d) return false;
        return true;
      });
    } else if (S.mode === 'unknown') {
      list = list.filter((it) => !dtOf(it));
    } else if (S.mode === 'place') {
      const g = S.payload || {};
      /* 地图在最大缩放时会把同一地点的照片拆成多个点；点开任意一张应看到该地点整组，
         而不是被 0.0016° 的旧半径筛成一张。优先按点开时收集的整组路径过滤。 */
      if (g.paths && g.paths.length) {
        const set = new Set(g.paths);
        list = list.filter((it) => set.has(it.path));
      } else {
        list = list.filter((it) => it.gps && Math.abs(it.gps.lat - g.lat) < 0.0025 && Math.abs(it.gps.lon - g.lon) < 0.0025);
      }
    } else if (S.mode === 'type') {
      list = list.filter((it) => it.kind === S.payload);
    } else if (S.mode === 'dupe') {
      const g = (lib.dupGroups || []).find((x) => x.id === S.payload);
      list = g ? g.items.map(itemForPath) : [];
    } else if (S.mode === 'cat') {
      const cat = lib.categories.find((c) => c.id === S.payload);
      if (cat) {
        const seen = new Set();
        list = cat.items.map(itemForPath).filter((it) => {
          if (seen.has(it.path)) return false;
          seen.add(it.path);
          return true;
        });
      } else {
        list = [];
      }
    }

    if (S.mode === 'ai') {
      const { k, v } = S.payload || {};
      list = list.filter((it) => {
        const t = aiState.tags[it.path];
        if (!t) return false;
        if (k === 'people') {
          const p = t.p || 0;
          return v === '2' ? p >= 2 : String(p) === v;
        }
        if (k === 'scene') return t.s === v;
        if (k === 'type') return inferTypes(it, t).includes(v);
        if (k === 'face') return t.fid === v;
        return false;
      });
    }

    if (S.mode === 'hidden') {
      const mh = new Set(lib.manualHidden || []);
      list = S.items.filter((it) => hiddenHas(mh, it));
    } else {
      /* 相似分析里「已合并」的素材默认不占版面，可在智能识别页恢复 */
      if (lib.hidden.length && S.mode !== 'dupe') {
        const hid = new Set(lib.hidden);
        list = list.filter((it) => !hid.has(it.path));
      }
      const mh = new Set(lib.manualHidden || []);
      if (mh.size) list = list.filter((it) => !hiddenHas(mh, it));
    }

    if (S.filter !== 'all') list = list.filter((it) => it.kind === S.filter);

    const q = S.query.trim().toLowerCase();
    if (q) list = list.filter((it) => searchHit(it, q));

    return applySort(list);
  }

  /* 搜索同时匹配文件名、智能识别标签与人物备注 */
  function searchHit(it, q) {
    if (it.name.toLowerCase().includes(q)) return true;
    if (niceName(it.name).toLowerCase().includes(q)) return true;
    const ed = lib.edits[it.path];
    if (ed && ((ed.place && ed.place.toLowerCase().includes(q)) || (ed.note && ed.note.toLowerCase().includes(q)))) return true;
    const note = (lib.notes || {})[it.path];
    if (note && String(note).toLowerCase().includes(q)) return true;
    const t = aiState.tags[it.path];
    if (!t) return false;
    if (t.s && t.s.toLowerCase().includes(q)) return true;
    if (q === '人物' || q === '人像') return (t.p || 0) >= 1;
    if (q === '合影' || q === '多人') return (t.p || 0) >= 2;
    if (q === '无人像' || q === '风景') return (t.p || 0) === 0;
    const name = t.fid && S.aiPeople[t.fid] ? String(S.aiPeople[t.fid]) : '';
    return !!(name && name.toLowerCase().includes(q));
  }

  function buildDateTree() {
    const years = new Map();
    let unknown = 0;
    for (const it of S.items) {
      const dt = dtOf(it);
      if (!dt) { unknown += 1; continue; }
      const y = dt.getFullYear();
      const m = dt.getMonth() + 1;
      const d = dt.getDate();
      if (!years.has(y)) years.set(y, { y, count: 0, months: new Map() });
      const Y = years.get(y);
      Y.count += 1;
      if (!Y.months.has(m)) Y.months.set(m, { m, count: 0, days: new Map() });
      const M = Y.months.get(m);
      M.count += 1;
      M.days.set(d, (M.days.get(d) || 0) + 1);
    }
    const out = Array.from(years.values()).sort((a, b) => b.y - a.y);
    out.forEach((Y) => {
      Y.monthList = Array.from(Y.months.values()).sort((a, b) => b.m - a.m);
    });
    return { years: out, unknown };
  }

  /* ───────────────────────── 左侧导航渲染 ───────────────────────── */

  function rowHtml(opts) {
    const {
      kind = '', path = '', cat = '', y = '', m = '', d = '', label = '',
      icon = '', count = '', active = false, invalid = false, actions = '', caret = '', pinned = false, sub = ''
    } = opts;
    return `<div class="row ${active ? 'on' : ''} ${invalid ? 'invalid' : ''} ${pinned ? 'pinned' : ''} ${kind === 'hist' ? 'hist-item' : ''}" data-row="${kind}"
       data-path="${escapeHtml(path)}" data-cat="${escapeHtml(cat)}"
       data-y="${y}" data-m="${m}" data-d="${d}" title="${escapeHtml(path || label)}">
      ${caret}${icon ? `<span class="row-ico">${icon}</span>` : ''}
      ${sub ? `<span class="row-text"><span class="row-label">${escapeHtml(label)}</span><span class="row-sub">${escapeHtml(sub)}</span></span>` : `<span class="row-label">${escapeHtml(label)}</span>`}
      ${count !== '' ? `<span class="row-count">${count}</span>` : ''}
      ${actions}
    </div>`;
  }

  let binCount = 0;
  async function refreshBin(forceRender) {
    try {
      const list = await api.recycleList();
      binCount = new Set((list || []).map((x) => x.gid || ('one:' + x.id))).size;
    } catch { binCount = 0; }
    if (forceRender) renderSidebar();
  }

  function kindFromExt(ext) {
    if (VID_EXT.has(ext)) return 'video';
    if (AUDIO_EXT.has(ext)) return 'audio';
    if (DOC_EXT.has(ext)) return 'doc';
    if (HEIC_EXT.has(ext) || IMG_EXT.has(ext)) return 'image';
    return 'image';
  }

  async function openBin() {
    aiView.hidden = true; S.dupOnly = false;
    const list = await api.recycleList();
    const groupMap = new Map();
    (list || []).forEach((b) => {
      const gid = b.gid || ('one:' + b.id);
      if (!groupMap.has(gid)) groupMap.set(gid, []);
      groupMap.get(gid).push(b);
    });
    binCount = groupMap.size;
    S.binMode = true;
    S.binItems = Array.from(groupMap.entries()).map(([gid, recs]) => {
      const primary = recs.find((b) => kindFromExt(extOf(b.name || b.bin)) !== 'video') || recs[0];
      const video = recs.find((b) => kindFromExt(extOf(b.name || b.bin)) === 'video') || null;
      const ext = extOf(primary.name || primary.bin);
      const isLive = recs.length > 1 && !!video;
      const name = primary.gname || primary.name;
      const size = recs.reduce((n, b) => n + (b.size || 0), 0);
      return {
        id: 'bin:' + gid, binId: primary.id, binIds: recs.map((b) => b.id),
        path: primary.bin, videoPath: video ? video.bin : null,
        name, ext, kind: isLive ? 'live' : kindFromExt(ext), size,
        mtime: primary.time || 0, btime: primary.time || 0,
        origPath: primary.orig || '', virtual: true, isBin: true, gid
      };
    });
    S.binByPath = new Map(S.binItems.map((it) => [it.path, it]));
    S.mode = 'bin';
    S.payload = null;
    S.dir = '';
    S.flat = true;
    S.filter = 'all';
    S.query = '';
    searchInput.value = '';
    S.selected.clear();
    S.active = null;
    S.batch = false;
    $('#btnSelect').textContent = '选择';
    closeAI();
    mapView.hidden = true;
    showInspector(null);
    renderSidebar();
    renderList(true);
    renderBatchBar();
  }

  function closeBin() {
    S.binMode = false;
    S.binItems = [];
    S.binByPath.clear();
    S.mode = 'all';
    S.payload = null;
    S.filter = 'all';
    S.selected.clear();
    S.active = null;
    showInspector(null);
    renderSidebar();
    renderList(true);
    renderBatchBar();
  }

  function renderSidebar() {
    const parts = [];
    const tree = buildDateTree();
    const favs = (lib.favorites || []).filter((p) => pathAllowed(p));
    const hist = (lib.history || []).filter((h) => h && h.path && pathAllowed(h.path));

    /* 收藏 */
    parts.push('<div class="side-section" data-sec="fav">');
    parts.push(`<div class="side-title"><span>收藏路径</span></div>`);
    if (!favs.length) {
    } else {
      for (const p of favs) {
        const bad = S.invalid.get(p.toLowerCase());
        parts.push(rowHtml({
          kind: 'fav', path: p, label: baseName(p), icon: ICON.folder,
          active: S.root && S.root.toLowerCase() === p.toLowerCase(),
          invalid: !!bad,
          count: bad ? '失效' : '',
          actions: `<span class="row-actions"><button data-act="unfav" title="取消收藏">${ICON.starFill}</button></span>`
        }));
      }
    }
    parts.push('</div>');

    /* 历史 */
    parts.push('<div class="side-section" data-sec="hist">');
    parts.push(`<div class="side-title"><span>历史记录</span>${hist.length ? `<button data-act="clearHist" title="清空历史">${ICON.trash}</button>` : ''}</div>`);
    if (!hist.length) {
    } else {
      hist.forEach((h) => {
        const bad = S.invalid.get(h.path.toLowerCase());
        const fav = lib.favorites.some((f) => f.toLowerCase() === h.path.toLowerCase());
        const kids = Array.isArray(h.dirs) ? h.dirs.filter((k) => pathAllowed(k.rel)) : [];
        const openH = S.openHist.has(h.path);
        parts.push(rowHtml({
          kind: 'hist',
          path: h.path,
          label: baseName(h.path),
          sub: dirOf(h.path),
          icon: ICON.clock,
          pinned: !!h.pinned,
          active: S.root && S.root.toLowerCase() === h.path.toLowerCase(),
          invalid: !!bad,
          count: bad ? '失效' : (kids.length ? String(kids.length) : ''),
          caret: kids.length ? `<span class="caret ${openH ? 'open' : ''}" data-caret="h" data-hpath="${escapeHtml(h.path)}">${ICON.chevron}</span>` : '',
          actions: `<span class="row-actions">
              <button data-act="${h.pinned ? 'unpin' : 'pin'}" title="${h.pinned ? '取消置顶' : '置顶'}">${h.pinned ? ICON.pinFill : ICON.pin}</button>
              <button data-act="${fav ? 'unfav' : 'fav'}" title="${fav ? '取消收藏' : '收藏'}">${fav ? ICON.starFill : ICON.star}</button>
              <button data-act="removeHist" title="从历史中移除">${ICON.x}</button>
            </span>`
        }));
        if (openH && kids.length) {
          for (const k of kids) {
            const depth = k.rel.split('/').length - 1;
            const kPath = h.path + '\\' + k.rel.split('/').join('\\');
            const kOn = S.root && S.root.toLowerCase() === kPath.toLowerCase();
            parts.push(`<div class="row tree-sub hist-sub ${kOn ? 'on' : ''}" data-row="hdir" data-path="${escapeHtml(kPath)}" title="${escapeHtml(k.rel)}" style="margin-left:${6 + depth * 12}px">
              <span class="row-ico">${ICON.folder}</span>
              <span class="row-label">${escapeHtml(k.rel)}</span>
              <span class="row-count">${k.n}</span></div>`);
          }
        }
      });
    }
    parts.push('</div>');

    /* 自动分类 */
    parts.push('<div class="side-section" data-sec="auto">');
    parts.push(`<div class="side-title"><span>自动分类</span></div>`);

    for (const Y of tree.years) {
      const open = S.openYears.has(Y.y);
      const on = S.mode === 'date' && S.payload && S.payload.y === Y.y && !S.payload.m && !S.payload.d;
      parts.push(rowHtml({
        kind: 'year', y: Y.y, label: `${Y.y} 年`, count: Y.count, active: on,
        icon: ICON.folder,
        caret: `<span class="caret ${open ? 'open' : ''}" data-caret="y" data-y="${Y.y}">${ICON.chevron}</span>`
      }));
      if (open) {
        for (const M of Y.monthList) {
          const mOpen = S.openMonths.has(`${Y.y}-${M.m}`);
          const mOn = S.mode === 'date' && S.payload && S.payload.y === Y.y
            && S.payload.m === M.m && !S.payload.d;
          parts.push(rowHtml({
            kind: 'month', y: Y.y, m: M.m, label: `${M.m} 月`, count: M.count,
            active: mOn, icon: ICON.folder,
            caret: `<span class="caret ${mOpen ? 'open' : ''}" data-caret="m" data-y="${Y.y}" data-m="${M.m}">${ICON.chevron}</span>`
          }).replace('class="row ', 'class="row tree-month '));
          if (mOpen) {
            const days = Array.from(M.days.entries()).sort((a, b) => b[0] - a[0]);
            for (const [day, c] of days) {
              const dOn = S.mode === 'date' && S.payload
                && S.payload.y === Y.y && S.payload.m === M.m && S.payload.d === day;
              parts.push(rowHtml({
                kind: 'day', y: Y.y, m: M.m, d: day, label: `${day} 日`, count: c,
                active: dOn, icon: ICON.folder
              }).replace('class="row ', 'class="row tree-day '));
            }
          }
        }
      }
    }

    if (tree.unknown) {
      parts.push(rowHtml({
        kind: 'unknown', label: '未知时间素材', count: tree.unknown,
        active: S.mode === 'unknown', icon: ICON.image
      }));
    }

    if (S.items.length) {
      parts.push(rowHtml({
        kind: 'type', label: '图片合集', count: S.counts.image,
        active: S.mode === 'type' && S.payload === 'image', icon: ICON.image
      }));
      parts.push(rowHtml({
        kind: 'type', label: '视频合集', count: S.counts.video,
        active: S.mode === 'type' && S.payload === 'video', icon: ICON.video
      }));
      parts.push(rowHtml({
        kind: 'type', label: '实况合集', count: S.counts.live,
        active: S.mode === 'type' && S.payload === 'live', icon: ICON.live
      }));
      if ((S.counts.audio || 0) > 0) {
        parts.push(rowHtml({
          kind: 'type', label: '音频合集', count: S.counts.audio,
          active: S.mode === 'type' && S.payload === 'audio', icon: ICON.music
        }));
      }
      if ((S.counts.doc || 0) > 0) {
        parts.push(rowHtml({
          kind: 'type', label: '文档合集', count: S.counts.doc,
          active: S.mode === 'type' && S.payload === 'doc', icon: ICON.doc
        }));
      }
    } else {
    }
    parts.push('</div>');

    /* 智能标签（本地识别结果） */
    const aiTags = (aiState.tags || {});
    const taggedItems = S.items.filter((it) => aiTags[it.path]);
    if (!taggedItems.length) {
      parts.push('<div class="side-section" data-sec="ai">');
      parts.push(`<div class="side-title"><span>智能标签</span></div>`);
      parts.push('</div>');
    }
    if (taggedItems.length) {
      const g = aiCounts(S.items);
      parts.push('<div class="side-section" data-sec="ai">');
      parts.push(`<div class="side-title"><span>智能标签</span></div>`);
      const peopleRows = Object.keys(S.aiPeople || {}).map((fid) => {
        const n = S.items.filter((it) => aiState.tags[it.path] && aiState.tags[it.path].fid === fid).length;
        return { k: 'face', v: fid, label: '人物 · ' + String(S.aiPeople[fid] || ''), icon: ICON.person, n };
      }).filter((r) => r.n > 0);
      for (const row of peopleRows.concat(g.people, g.scene, g.types)) {
        const on = S.mode === 'ai' && S.payload && S.payload.k === row.k && S.payload.v === row.v;
        parts.push(`<div class="row ${on ? 'on' : ''}" data-row="ai" data-ai-k="${row.k}" data-ai-v="${escapeHtml(row.v)}" title="${escapeHtml(row.label)}">
          <span class="row-ico">${row.icon}</span>
          <span class="row-label">${escapeHtml(row.label)}</span>
          <span class="row-count">${row.n}</span>
        </div>`);
      }
      parts.push('</div>');
    }

    /* 相似素材：只显示一个汇总入口 */
    parts.push('<div class="side-section" data-sec="dupe">');
    const dupN = (lib.dupGroups || []).length;
    parts.push('<div class="side-title"><span>相似素材</span></div>');
    parts.push('<div class="row" data-row="dupeAll" title="查看所有相似组">'
      + '<span class="row-ico">' + ICON.image + '</span>'
      + '<span class="row-label">相似素材</span>'
      + '<span class="row-count">' + (dupN ? dupN + ' 组' : '无') + '</span></div>');
    parts.push('</div>');

    /* 自定义分类 */
    parts.push('<div class="side-section" data-sec="cat">');
    parts.push(`<div class="side-title"><span>自定义分类</span><button data-act="newCat" title="新建分类">${ICON.plus}</button></div>`);
    if (!lib.categories.length) {
    } else {
      for (const c of lib.categories) {
        parts.push(rowHtml({
          kind: 'cat', cat: c.id, label: c.name, count: c.items.length,
          icon: ICON.folder,
          active: S.mode === 'cat' && S.payload === c.id,
          actions: `<span class="row-actions">
            <button data-act="renameCat" data-cat="${c.id}" title="重命名">${ICON.pencil}</button>
            <button data-act="delCat" data-cat="${c.id}" title="删除分类">${ICON.x}</button>
          </span>`
        }));
      }
    }
    parts.push('</div>');

    /* 回收站 */
    parts.push('<div class="side-section" data-sec="bin">');
    parts.push(`<div class="side-title"><span>回收站</span></div>`);
    parts.push(`<div class="row" data-row="bin" title="删除的素材可以在这里还原">
      <span class="row-ico">${ICON.trash}</span>
      <span class="row-label">回收站</span>
      <span class="row-count">${binCount || ''}</span></div>`);
    if ((lib.manualHidden || []).length) {
      parts.push(`<div class="row${S.mode === 'hidden' ? ' on' : ''}" data-row="hidden" title="手动隐藏的素材">
        <span class="row-ico">${ICON.eyeOff || ICON.image}</span>
        <span class="row-label">已隐藏素材</span>
        <span class="row-count">${lib.manualHidden.length}</span></div>`);
    }
    parts.push('</div>');

    sidebar.innerHTML = parts.join('');
    applySidePrefs();
    syncDragTargets();
  }

  function applySidePrefs() {
    const vis = Object.assign({ fav: true, hist: true, auto: true, ai: true, dupe: true, cat: true, bin: true }, lib.settings.visible || {});
    const secs = Array.from(sidebar.querySelectorAll('.side-section'));
    secs.forEach((s) => { if (vis[s.dataset.sec] === false) s.style.display = 'none'; });
    const order = lib.settings.sideOrder;
    if (Array.isArray(order) && order.length) {
      const map = new Map();
      secs.forEach((s) => { if (!map.has(s.dataset.sec)) map.set(s.dataset.sec, []); map.get(s.dataset.sec).push(s); });
      const tail = [];
      order.forEach((k) => { if (map.has(k)) { map.get(k).forEach((n) => sidebar.appendChild(n)); map.delete(k); } });
      map.forEach((arr) => arr.forEach((n) => tail.push(n)));
      tail.forEach((n) => sidebar.appendChild(n));
    }
    bindSideDrag();
  }

  function saveSideOrder() {
    lib.settings.sideOrder = Array.from(sidebar.querySelectorAll('.side-section')).map((s) => s.dataset.sec);
    persist();
  }

  function bindSideDrag() {
    const secs = Array.from(sidebar.querySelectorAll('.side-section'));
    secs.forEach((sec) => {
      const title = sec.querySelector('.side-title');
      if (!title || title.__dragBound) return;
      title.__dragBound = true;
      title.classList.add('sec-grip');
      title.setAttribute('draggable', 'true');
      title.addEventListener('dragstart', (e) => {
        sec.classList.add('sec-dragging');
        e.dataTransfer.setData('application/x-side-sec', sec.dataset.sec);
        e.dataTransfer.effectAllowed = 'move';
      });
      title.addEventListener('dragend', () => {
        sec.classList.remove('sec-dragging');
        $('.sec-drop-line') && $('.sec-drop-line').classList.remove('sec-drop-line');
        saveSideOrder();
      });
      sec.addEventListener('dragover', (e) => {
        if (!Array.from(e.dataTransfer.types).includes('application/x-side-sec')) return;
        e.preventDefault();
        sec.classList.add('sec-drop-line');
      });
      sec.addEventListener('dragleave', () => sec.classList.remove('sec-drop-line'));
      sec.addEventListener('drop', (e) => {
        const src = e.dataTransfer.getData('application/x-side-sec');
        sec.classList.remove('sec-drop-line');
        if (!src || src === sec.dataset.sec) return;
        e.preventDefault();
        const srcEl = sidebar.querySelector('.side-section[data-sec="' + src + '"]');
        if (!srcEl) return;
        const rect = sec.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        sec.parentNode.insertBefore(srcEl, after ? sec.nextSibling : sec);
        saveSideOrder();
      });
    });
  }

  /* ───────────────────────── 素材网格 ───────────────────────── */

  /* 缩略图队列：一屏只有几十张，6 路并发，滚动不吃力 */
  const thumbQueue = [];
  const thumbCache = new Map();   // path -> url，回滚不再走 IPC
  const thumbPending = new Map(); // path -> promise，避免同一张重复请求
  let thumbActive = 0;

  function pumpThumb() {
    while (thumbActive < 6 && thumbQueue.length) {
      const img = thumbQueue.shift();
      if (!img) continue;
      thumbActive += 1;
      // 卡片是本轮才拼进网格的，等下一帧再取缩略图，此时 img 已在 DOM 里
      setTimeout(() => {
        Promise.resolve()
          .then(() => (img.isConnected ? loadThumb(img) : null))
          .catch(() => {})
          .then(() => { thumbActive -= 1; pumpThumb(); });
      }, 0);
    }
  }

  function queueThumb(img) {
    thumbQueue.push(img);
    pumpThumb();
  }

  function placeholder(it) {
    const d = el('div', 'ph');
    d.innerHTML = (it.kind === 'live' ? ICON.live : it.kind === 'video' ? ICON.video : ICON.image)
      + `<span>${escapeHtml((it.ext || '').toUpperCase() || '未知')}</span>`;
    return d;
  }

  async function loadThumb(img) {
    const p = img.dataset.src;
    const it = S.byPath.get(p) || itemForPath(p);
    if (!it || !img.isConnected) return;
    const thumb = img.parentElement;

    const cached = thumbCache.get(p);
    if (cached) {
      img.src = cached;
      return;
    }
    // 小图直接读原图（省一次 IPC），大图走 512px 磁盘缓存
    if (DIRECT_IMG.has(it.ext) && !it.virtual && (it.size || 0) < 900 * 1024) {
      const u = fileUrl(it.path);
      thumbCache.set(p, u);
      img.src = u;
      return;
    }
    let job = thumbPending.get(p);
    if (!job) {
      job = api.thumb(it).then((r) => {
        const url = r && r.url ? r.url : null;
        thumbPending.delete(p);
        if (url) thumbCache.set(p, url);
        return url;
      }).catch(() => { thumbPending.delete(p); return null; });
      thumbPending.set(p, job);
    }
    const url = await job;
    if (url) {
      if (img.isConnected) img.src = url;
    } else if (img.isConnected && !thumb.querySelector('.ph')) {
      thumb.appendChild(placeholder(it));
    }
  }

  /* 文件夹卡片：封面 + 名称 + 张数，单击进入该目录 */
  function folderEl(tile) {
    const card = el('article', 'card folder');
    card.dataset.dir = tile.rel;
    card.draggable = false;
    card.title = tile.name + ` · ${tile.total} 项`;

    const thumb = el('div', 'thumb');
    if (tile.cover) {
      const img = el('img');
      img.dataset.src = tile.cover.path;
      img.alt = '';
      img.draggable = false;
      thumb.appendChild(img);
      img.addEventListener('load', () => img.classList.add('loaded'));
      queueThumb(img);
    } else {
      const ph = el('div', 'ph');
      ph.innerHTML = ICON.folder + '<span>' + (tile.total ? tile.total + ' 项' : '空目录') + '</span>';
      thumb.appendChild(ph);
    }

    const badge = el('span', 'badge count', `${tile.total} 项`);
    thumb.appendChild(badge);
    card.appendChild(thumb);

    const cap = el('div', 'cap');
    const icon = el('span', 'cap-ico');
    icon.innerHTML = ICON.folder;
    cap.appendChild(icon);
    cap.appendChild(el('span', 'nm', tile.name));
    card.appendChild(cap);

    return card;
  }

  /* 音频 / 文档没有画面：用图标 + 扩展名做封面，保持版面干净 */
  function kindCover(it, icon) {
    const d = el('div', 'kind-cover');
    d.innerHTML = icon + '<span>' + escapeHtml((it.ext || '').toUpperCase()) + '</span>';
    return d;
  }

  function cardEl(it) {
    const card = el('article', 'card');
    card.dataset.path = it.path;
    card.draggable = true;
    card.title = it.name;

    if (it.kind === 'archive') {
      card.classList.add('archive-card');
      card.title = it.name + ' · 双击打开压缩包';
      const thumb = el('div', 'thumb');
      const cover = kindCover(it, ICON.archive);
      cover.classList.add('archive-cover');
      thumb.appendChild(cover);
      thumb.appendChild(el('span', 'badge count', '压缩包'));
      if (it.size) thumb.appendChild(el('span', 'sz-tag', fmtSize(it.size)));
      const dot = el('span', 'sel-dot');
      dot.innerHTML = ICON.check;
      thumb.appendChild(dot);
      card.appendChild(thumb);
      const cap = el('div', 'cap');
      const ico = el('span', 'cap-ico');
      ico.innerHTML = ICON.archive;
      cap.appendChild(ico);
      cap.appendChild(el('span', 'nm', niceName(it.name)));
      card.appendChild(cap);
      if (it.path === S.active || S.selected.has(it.path)) card.classList.add('on');
      return card;
    }

    const thumb = el('div', 'thumb');
    const img = el('img');
    img.dataset.src = it.path;
    img.alt = '';
    img.draggable = false;
    thumb.appendChild(img);
    if (!DIRECT_IMG.has(it.ext) || it.virtual) thumb.appendChild(placeholder(it));

    if (it.kind === 'audio') thumb.appendChild(kindCover(it, ICON.music));
    if (it.kind === 'doc') thumb.appendChild(kindCover(it, ICON.doc));
    if (it.kind === 'live') {
      const b = el('span', 'badge live');
      b.innerHTML = '<i></i>LIVE';
      thumb.appendChild(b);
    }
    if (it.kind === 'video' || it.kind === 'live') {
      const b = el('span', 'badge play');
      b.innerHTML = ICON.play;
      thumb.appendChild(b);
    }

    const dot = el('span', 'sel-dot');
    dot.innerHTML = ICON.check;
    thumb.appendChild(dot);

    card.appendChild(thumb);

    const cap = el('div', 'cap');
    const nm = el('span', 'nm', niceName(it.name));
    cap.appendChild(nm);
    card.appendChild(cap);
    if ((S.mode === 'dupe' || S.binMode) && it.size) thumb.appendChild(el('span', 'sz-tag', fmtSize(it.size)));

    if (it.path === S.active || S.selected.has(it.path)) card.classList.add('on');

    queueThumb(img);

    img.addEventListener('load', () => {
      img.classList.add('loaded');
      const ph = thumb.querySelector('.ph');
      if (ph) ph.remove();
      if (isMasonry() && img.naturalWidth && img.naturalHeight && it.kind !== 'video' && it.kind !== 'live') {
        thumb.style.aspectRatio = img.naturalWidth + ' / ' + img.naturalHeight;
      }
    });
    img.addEventListener('error', () => {
      const ph = thumb.querySelector('.ph');
      if (ph) ph.remove();
      thumb.appendChild(placeholder(it));
    });

    return card;
  }

  /* ───────── 虚拟滚动网格：只渲染可视区域，一万多张也顺滑 ───────── */
  const GRID_GAP_X = 18;
  const GRID_GAP_Y = 22;
  const GRID_PAD_X = 24;
  const GRID_PAD_TOP = 4;
  const CAP_H = 30;

  let vcols = 1;
  let vcellW = 168;
  let vrowH = 220;
  let vrows = 0;
  let vstart = -1;
  let vend = -1;
  let vTileRows = 0;

  function measureGrid() {
    const inner = Math.max(220, grid.clientWidth - GRID_PAD_X * 2);
    const cell = Math.max(100, Number(lib.settings.cell) || 168);
    const cols = Math.max(1, Math.floor((inner + GRID_GAP_X) / (cell + GRID_GAP_X)));
    const cellW = Math.floor((inner - GRID_GAP_X * (cols - 1)) / cols);
    return { cols, cellW, rowH: cellW + CAP_H + GRID_GAP_Y };
  }

  /* 缩略图拉到最大（≥236px）时切换成小红书那种交错瀑布流 */
  function isMasonry() {
    return Number(lib.settings.cell) >= 236;
  }

  function layoutGrid() {
    const m = measureGrid();
    if (isMasonry() && m.cols < 2 && grid.clientWidth > 560) {
      m.cols = 2;
      const inner = Math.max(220, grid.clientWidth - GRID_PAD_X * 2);
      m.cellW = Math.floor((inner - GRID_GAP_X) / 2);
      m.rowH = m.cellW + CAP_H + GRID_GAP_Y;
    }
    vcols = m.cols;
    vcellW = m.cellW;
    vrowH = m.rowH;
    vTileRows = S.dirTiles.length ? Math.ceil(S.dirTiles.length / vcols) : 0;
    if (isMasonry()) {
      grid.classList.add('masonry');
      grid.style.height = '';
      grid.style.columnCount = String(Math.max(1, m.cols));
      grid.style.columnGap = GRID_GAP_X + 'px';
      vstart = -1;
      vend = -1;
      return;
    }
    grid.classList.remove('masonry');
    grid.style.columnCount = '';
    vrows = vTileRows + Math.ceil(S.filtered.length / vcols);
    grid.style.height = `${GRID_PAD_TOP + vrows * vrowH + 20}px`;
    vstart = -1;
    vend = -1;
  }

  function placeAt(card, row, col) {
    card.style.width = `${vcellW}px`;
    card.style.left = `${GRID_PAD_X + col * (vcellW + GRID_GAP_X)}px`;
    card.style.top = `${GRID_PAD_TOP + row * vrowH}px`;
  }

  function placeCard(card, i) {
    const r = Math.floor(i / vcols);
    const c = i % vcols;
    card.style.width = `${vcellW}px`;
    card.style.left = `${GRID_PAD_X + c * (vcellW + GRID_GAP_X)}px`;
    card.style.top = `${GRID_PAD_TOP + r * vrowH}px`;
  }

  /* 瀑布流：按滚动分页追加，卡片用真实宽高比，交错排布 */
  function renderMasonry(force) {
    const list = S.filtered;
    const tiles = S.dirTiles || [];
    const total = tiles.length + list.length;
    if (!total) { grid.replaceChildren(); S.masonryCount = 0; return; }
    if (force && S.masonryCount < 60) S.masonryCount = 60;
    const limit = Math.min(total, S.masonryCount || 60);
    if (force) { grid.replaceChildren(); S.masonryCount = limit; }
    const have = grid.childElementCount;
    if (have >= limit) return;
    const frag = document.createDocumentFragment();
    for (let i = have; i < limit; i++) {
      let node;
      if (i < tiles.length) node = folderEl(tiles[i]);
      else node = cardEl(list[i - tiles.length]);
      node.classList.add('ms');
      frag.appendChild(node);
    }
    grid.appendChild(frag);
  }

  function renderWindow(force) {
    if (isMasonry()) { renderMasonry(!!force); return; }
    const list = S.filtered;
    const tiles = S.dirTiles || [];
    if (!vrows || (!list.length && !tiles.length)) {
      grid.replaceChildren();
      vstart = -1;
      vend = -1;
      return;
    }
    const top = stageBody.scrollTop;
    const vh = stageBody.clientHeight || 640;
    const first = Math.max(0, Math.floor(top / vrowH) - 2);
    const last = Math.min(vrows - 1, Math.ceil((top + vh) / vrowH) + 2);
    if (!force && first === vstart && last === vend) return;
    vstart = first;
    vend = last;
    const frag = document.createDocumentFragment();
    for (let r = first; r <= last; r++) {
      for (let c = 0; c < vcols; c++) {
        if (r < vTileRows) {
          const ti = r * vcols + c;
          if (ti >= tiles.length) continue;
          const node = folderEl(tiles[ti]);
          placeAt(node, r, c);
          frag.appendChild(node);
        } else {
          const i = (r - vTileRows) * vcols + c;
          if (i >= list.length) continue;
          const card = cardEl(list[i]);
          placeAt(card, r, c);
          frag.appendChild(card);
        }
      }
    }
    grid.replaceChildren(frag);
  }

  let scrollRaf = 0;
  function onStageScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (isMasonry()) {
        const near = stageBody.scrollTop + stageBody.clientHeight > stageBody.scrollHeight - 700;
        const total = (S.dirTiles || []).length + S.filtered.length;
        if (near && grid.childElementCount < total) {
          S.masonryCount = (grid.childElementCount || 0) + 60;
          renderMasonry(false);
        }
        return;
      }
      renderWindow(false);
    });
  }

  function ensureVisible(idx) {
    if (isMasonry()) return;
    if (idx < 0 || !vrowH) return;
    const top = (Math.floor(idx / vcols) + vTileRows) * vrowH;
    const view = stageBody.scrollTop;
    const h = stageBody.clientHeight;
    if (top < view) stageBody.scrollTop = Math.max(0, top - 10);
    else if (top + vrowH > view + h) stageBody.scrollTop = top + vrowH - h + 10;
    renderWindow(true);
  }

  function renderGrid(reset) {
    if (reset) {
      layoutGrid();
      if (stageBody.scrollTop) stageBody.scrollTop = 0;
    }
    renderWindow(true);
  }

  function renderList(reset) {
    S.filtered = computeFiltered();
    renderGrid(reset !== false);
    renderChrome();
    if (S.viewerOpen) renderViewer();
  }

  function renderChrome() {
    const n = S.filtered.length;
    if (S.binMode) countText.textContent = `回收站 · ${S.binItems.length} 项` + (S.selected.size ? ` · 已选 ${S.selected.size}` : '');
    else if (S.selected.size) countText.textContent = `${n} 项 · 已选 ${S.selected.size}`;
    else if (isDirMode() && S.dirTiles.length) countText.textContent = `${S.dirTiles.length} 个文件夹 · ${n} 项`;
    else countText.textContent = `${n} 项`;

    let txt = '全部素材';
    if (S.binMode) {
      crumb.innerHTML = '<button class="crumb-chip on" title="回收站里的素材可以还原">回收站 · ' + S.binItems.length + ' 项</button>'
        + '<button class="crumb-flat" data-act="exitBin" title="返回全部素材">返回全部</button>';
    } else if (S.mode === 'date') {
      const p = S.payload;
      txt = p && p.d ? `${p.y} 年 ${p.m} 月 ${p.d} 日` : p && p.m ? `${p.y} 年 ${p.m} 月` : `${p && p.y} 年`;
    } else if (S.mode === 'place') {
      txt = '这个地点的照片';
    } else if (S.mode === 'type') {
      txt = { image: '图片合集', video: '视频合集', live: '实况合集', audio: '音频合集', doc: '文档合集' }[S.payload] || '全部素材';
    } else if (S.mode === 'hidden') {
      txt = '已隐藏素材';
    } else if (S.mode === 'unknown') {
      txt = '未知时间素材';
    } else if (S.mode === 'dupe') {
      const dg = (lib.dupGroups || []).find((x) => x.id === S.payload);
      txt = '相似相簿' + (dg ? ' · ' + dg.items.length + ' 项' : '');
    } else if (S.mode === 'cat') {
      const c = lib.categories.find((x) => x.id === S.payload);
      txt = c ? `分类 · ${c.name}` : '分类';
    } else if (S.filter !== 'all') {
      txt = { image: '图片合集', video: '视频合集', live: '实况合集', audio: '音频合集', doc: '文档合集' }[S.filter] || '全部素材';
    }

    /* 目录模式：面包屑可点，末尾可切「合并显示」 */
    if (S.binMode) {
      /* 回收站面包屑已在上方设置，避免被下面的通用分支覆盖 */
    } else if (isDirMode()) {
      const segs = S.dir ? S.dir.split('/') : [];
      const rootName = escapeHtml(baseName(S.root || '') || '全部素材');
      const trail = segs.map((seg, i) => {
        const rel = segs.slice(0, i + 1).join('/');
        const on = i === segs.length - 1 ? ' on' : '';
        return `<span class="crumb-sep">›</span><button class="crumb-chip${on}" data-dir="${escapeHtml(rel)}">${escapeHtml(seg)}</button>`;
      }).join('');
      const rootOn = segs.length ? '' : ' on';
      crumb.innerHTML = `<button class="crumb-chip${rootOn}" data-dir="" title="回到打开的这个文件夹">${rootName}</button>`
        + trail
        + `<button class="crumb-flat" data-flat="1" title="不分子目录，全部平铺显示">合并显示</button>`;
    } else if (S.mode === 'all' && S.filter === 'all' && !S.query.trim() && S.flat) {
      crumb.innerHTML = `全部素材 · 已合并<button class="crumb-flat on" data-flat="0" title="按子目录分开显示">按目录显示</button>`;
    } else if (S.mode === 'place') {
      const label = (S.payload && S.payload.label) || '这个地点';
      crumb.innerHTML = '<button class="crumb-chip on" title="只显示这个地点拍的照片">' + escapeHtml(label) + ' · ' + S.filtered.length + ' 张</button><button class="crumb-flat" data-act="backmap">返回地图</button>';
    } else {
      crumb.textContent = txt;
    }


    const baseItems = S.binMode ? S.binItems : S.items;
    const noItems = !baseItems.length;
    const noMatch = !!baseItems.length && !S.filtered.length && !S.dirTiles.length;
    if (!S.scanning) {
      emptyBox.hidden = !(noItems || noMatch);
      const t = $('#emptyTitle');
      const s = $('#emptySub');
      const btn = $('#btnEmptyOpen');
      /* 空状态只保留一个主标题，去掉所有说明小字 */
      if (s) { s.textContent = ''; s.hidden = true; }
      if (S.binMode) {
        t.textContent = '回收站是空的';
        s.textContent = '删除的素材会先放在这里，随时可以还原';
        btn.hidden = true;
      } else if (noItems && !S.root) {
        t.textContent = '还没有素材';
        s.textContent = '打开一个文件夹，开始整理你的图片、视频与实况';
        btn.hidden = false;
      } else if (noItems) {
        t.textContent = '这个文件夹里没有素材';
        s.textContent = '支持 JPG / PNG / WEBP / GIF / MP4 / MOV / 实况 等格式';
        btn.hidden = false;
      } else if (noMatch) {
        t.textContent = '没有符合条件的素材';
        s.textContent = '换个类型标签，或清空搜索关键词试试';
        btn.hidden = true;
      }
    }  }

  /* ───────────── 排序按钮 / 菜单 ───────────── */
  function sortLabelText(st) {
    if (!sortCustom()) return '默认排序';
    const o = SORT_OPTS.find((x) => x.k === st.k) || SORT_OPTS[0];
    return o.n;
  }
  function renderSortLabel() {
    const el = document.getElementById('sortLabel');
    if (el) el.textContent = sortLabelText(sortState());
  }
  function buildSortMenu() {
    const menu = document.getElementById('sortMenu');
    if (!menu) return;
    const st = sortState();
    menu.innerHTML = '<div class="sm-h">排序方式</div>'
      + '<button class="sm-row' + (!sortCustom() ? ' on' : '') + '" data-sort="default"><span>默认排序</span>'
      + '<span class="sm-dir">' + (!sortCustom() ? '按拍摄时间 <svg class="sm-check" viewBox="0 0 24 24" width="12" height="12"><path d="M5 13l4 4 10-11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '') + '</span></button>'
      + SORT_OPTS.map((o) => {
        const on = o.k === st.k;
        return '<button class="sm-row' + (on ? ' on' : '') + '" data-sort="' + o.k + '">'
          + '<span>' + o.n + '</span>'
          + '<span class="sm-dir">' + (on ? (st.dir === 'asc' ? o.asc : o.desc) + ' <svg class="sm-check" viewBox="0 0 24 24" width="12" height="12"><path d="M5 13l4 4 10-11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '') + '</span>'
          + '</button>';
      }).join('');
  }
  function closeSortMenu() {
    const menu = document.getElementById('sortMenu');
    const btn = document.getElementById('btnSort');
    if (menu && !menu.hidden) menu.hidden = true;
    if (btn) btn.classList.remove('on');
  }
  function toggleSortMenu(force) {
    const menu = document.getElementById('sortMenu');
    const btn = document.getElementById('btnSort');
    if (!menu || !btn) return;
    const open = force !== undefined ? force : menu.hidden;
    buildSortMenu();
    menu.hidden = !open;
    btn.classList.toggle('on', open);
  }
  function applySortChange(k) {
    if (k === 'default') {
      lib.settings.sort = null;
      persist(); renderSortLabel(); buildSortMenu(); renderList(true);
      return;
    }
    const st = sortState();
    const o = SORT_OPTS.find((x) => x.k === k);
    if (!o) return;
    if (!sortCustom()) {
      lib.settings.sort = { k, dir: o.d, custom: true };
      persist(); renderSortLabel(); buildSortMenu(); renderList(true);
      return;
    }
    if (st.k === k) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
    else st.dir = o.d;
    lib.settings.sort = { k, dir: st.dir, custom: true };
    persist();
    renderSortLabel();
    buildSortMenu();
    renderList(true);
  }
  function initSortUI() {
    const btn = document.getElementById('btnSort');
    const menu = document.getElementById('sortMenu');
    if (!btn || !menu) return;
    renderSortLabel();
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleSortMenu(); });
    menu.addEventListener('click', (e) => {
      const row = e.target.closest('[data-sort]');
      if (!row) return;
      e.stopPropagation();
      applySortChange(row.dataset.sort);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.sort-wrap')) closeSortMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSortMenu(); });
    document.getElementById('stageBody').addEventListener('scroll', closeSortMenu, { passive: true });
  }

  function renderAll() {
    renderSidebar();
    renderList(true);
    renderBatchBar();
  }

  /* ───────────────────────── 选中与批量 ───────────────────────── */

  function setActive(path, opts = {}) {
    if (!path) {
      S.active = null;
      S.selected.clear();
      syncCardStates();
      showInspector(null);
      renderChrome();
      return;
    }
    const multi = opts.multi || S.batch;
    if (multi) {
      if (S.selected.has(path) && !opts.forceAdd) S.selected.delete(path);
      else S.selected.add(path);
      if (!S.selected.has(path) && S.selected.size) {
        S.active = Array.from(S.selected)[S.selected.size - 1];
      } else {
        S.active = path;
      }
    } else {
      S.selected.clear();
      S.selected.add(path);
      S.active = path;
    }
    syncCardStates();
    renderChrome();
    renderBatchBar();
    if (!multi && opts.reveal !== false) ensureVisible(S.filtered.findIndex((i) => i.path === S.active));
    if (S.active) showInspector(lookupItem(S.active));
  }

  function syncCardStates() {
    $$('.card', grid).forEach((c) => {
      c.classList.toggle('on', S.selected.has(c.dataset.path));
    });
  }

  function renderBatchBar() {
    if (S.binMode) {
      if (!S.selected.size) { batchbar.hidden = true; batchbar.innerHTML = ''; return; }
      batchbar.hidden = false;
      batchbar.innerHTML = `
        <div class="n">已选 ${S.selected.size} 项 · 回收站 ${S.binItems.length} 项</div>
        <button data-act="binRestore" class="primary">还原所选</button>
        <button data-act="binClear" class="danger">清空回收站</button>
        <button data-act="all">${S.selected.size === S.filtered.length && S.filtered.length ? '取消全选' : '全选'}</button>
        <button data-act="exitBin">返回全部</button>`;
      return;
    }
    if (!S.batch && !S.selected.size) {
      batchbar.hidden = true;
      return;
    }
    if (!S.batch) {
      batchbar.hidden = true;
      return;
    }
    batchbar.hidden = false;
    batchbar.innerHTML = `
      <div class="n">已选 ${S.selected.size} 项</div>
      ${S.mode === 'cat' ? '<button data-act="rmCat" class="danger">移出当前分类</button>' : ''}
      <button data-act="cat">加入分类</button>
      <button data-act="hide">${S.mode === 'hidden' ? '取消隐藏' : '隐藏'}</button>
      <button data-act="move">移动</button>
      <button data-act="del" class="danger">删除</button>
      <button data-act="all">${S.selected.size === S.filtered.length ? '取消全选' : '全选'}</button>
      <button data-act="exit">退出选择</button>`;
  }

  function enterBatch(on) {
    S.batch = on;
    $('#btnSelect').textContent = on ? '完成' : '选择';
    if (!on) {
      S.selected.clear();
      S.active = null;
      syncCardStates();
      showInspector(null);
      renderChrome();
    } else {
      batchbar.hidden = false;
    }
    renderBatchBar();
  }

  /* ───────────────────────── 右侧详情 ───────────────────────── */

  function inspectorEmpty() {
    const total = S.items.length;
    const stats = [
      ['素材', total],
      ['图片', S.counts.image || 0],
      ['视频', S.counts.video || 0],
      ['实况', S.counts.live || 0]
    ];
    if ((S.counts.audio || 0) > 0) stats.push(['音频', S.counts.audio]);
    if ((S.counts.doc || 0) > 0) stats.push(['文档', S.counts.doc]);
    if ((S.counts.archive || 0) > 0) stats.push(['压缩包', S.counts.archive]);
    inspector.innerHTML = `<div class="ins-empty">
      <div class="ie-art">
        ${svg('<rect x="3.5" y="5" width="17" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8.6" cy="10" r="1.7" fill="currentColor"/><path d="M4.6 16.6l5-4.6 3.4 3 2.6-2.3 4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>', 40)}
      </div>
      <div class="ins-empty-t">${total ? '还没有选中素材' : '还没有打开文件夹'}</div>
      ${total ? `<div class="ie-stats">${stats.map(([k, v]) => `<div class="ie-stat"><b>${v}</b><span>${k}</span></div>`).join('')}</div>` : ''}
    </div>`;
  }

  function kv(k, v, muted) {
    return `<div class="kv"><span class="k">${escapeHtml(k)}</span><span class="v ${muted ? 'muted' : ''}">${v}</span></div>`;
  }

  function showArchiveInspector(it) {
    const size = fmtSize(it.size || 0);
    const changed = fmtFull(it.mtime || it.btime || Date.now());
    inspector.innerHTML = `
      <div class="ins-wrap archive-ins">
        <div class="ins-preview">
          <div class="archive-preview">${ICON.archive}<span>${escapeHtml((it.ext || '').toUpperCase())}</span></div>
          <div class="prev-actions"><button data-act="reveal">在文件夹中显示</button></div>
        </div>
        <div class="ins-name">${escapeHtml(niceName(it.name))}</div>
        <div class="ins-path" title="${escapeHtml(it.path)}">${escapeHtml(it.path)}</div>
        <div class="ins-actions">
          <button data-act="arcOpen">打开压缩包</button>
          <button data-act="reveal">在文件夹中显示</button>
          <button data-act="copy">复制路径</button>
        </div>
        <div class="ins-sec">
          <h4>压缩包</h4>
          ${kv('格式', escapeHtml((it.ext || '').toUpperCase()) + ' · 压缩包')}
          ${kv('文件大小', size)}
          ${kv('修改时间', changed)}
        </div>
      </div>`;
  }

  async function showInspector(it) {
    const token = ++S.insToken;
    if (!it) { inspectorEmpty(); return; }
    if (it.kind === 'archive') { showArchiveInspector(it); return; }

    const dt = dtOf(it);
    const edTop = editOf(it) || {};
    const noteVal = edTop.note != null ? edTop.note : ((lib.notes || {})[it.path] || '');
    const changedBits = [];
    if (edTop.date) changedBits.push('时间');
    if (edTop.place != null) changedBits.push('地点');
    if (edTop.note != null) changedBits.push('备注');
    if (edTop.name) changedBits.push('名称');
    const preview = DIRECT_IMG.has(it.ext) && !it.virtual
      ? `<img src="${fileUrl(it.path)}" alt="">`
      : `<div class="ph" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:#c2c2c8;font-size:11px">${it.kind === 'video' ? ICON.video : ICON.image}<span>${escapeHtml((it.ext || '').toUpperCase())}</span></div>`;

    inspector.innerHTML = `
      <div class="ins-wrap">
        <div class="ins-preview" id="insPreview">
          ${preview}
          <div class="prev-actions">
            <button data-act="reveal">在文件夹中显示</button>
          </div>
        </div>
        <div class="ins-name" data-edit="name" title="双击修改名称">${escapeHtml(niceName(it.name))}</div>
        <div class="ins-path" title="${escapeHtml(it.arc ? it.arc + ' › ' + (it.arcEntry || '') : it.path)}">${escapeHtml(it.arc ? baseName(it.arc) + ' › ' + (it.arcEntry || '') : it.path)}</div>
        <div class="ins-actions">
          <button data-act="viewer">全屏预览</button>
          <button data-act="open">默认应用打开</button>
          <button data-act="copy">复制路径</button>
        </div>

        <div class="ins-sec">
          <h4>时间</h4>
          <div class="shot-big ins-edit" data-edit="time" title="双击修改时间">${dt ? fmtDate(dt) : '—'}</div>
          <div class="shot-sub">${dt ? `${fmtTime(dt)} · ${editOf(it) && editOf(it).date ? '已修改' : (it.shotAt ? '拍摄时间' : '文件时间')}` : '无时间信息'}</div>
          ${editOf(it) && editOf(it).date && rawDateOf(it) ? '<div class="ins-orig">原始：' + fmtFull(rawDateOf(it).getTime()) + '</div>' : ''}
          <div style="margin-top:8px">
            ${kv('创建时间', fmtFull(it.btime || it.mtime))}
            ${edTop.at ? kv('信息修改时间', fmtFull(edTop.at)) : ''}
          </div>
        </div>

        <div class="ins-sec">
          <h4>位置</h4>
          <div id="insGeo" class="shot-sub ins-edit" data-edit="place" style="font-size:12.2px;color:#a1a1a6" title="双击修改地点">正在读取定位信息…</div>
        </div>

        <div class="ins-sec">
          <h4>参数</h4>
          <div id="insParams">
            ${kv('格式', escapeHtml((it.ext || '').toUpperCase()) + ' · ' + (KIND_LABEL[it.kind] || ''))}
            ${kv('文件大小', fmtSize(it.size))}
            ${it.arc ? kv('来源', escapeHtml(baseName(it.arc) + ' › ' + (it.arcEntry || ''))) : ''}
          </div>
        </div>

        <div class="ins-sec">
          <h4>备注</h4>
          <div class="ins-note" data-edit="note">${escapeHtml(noteVal || '无 · 双击添加备注')}</div>
        </div>

        <div class="ins-sec">
          <h4>分类</h4>
          <div class="chips" id="insChips"></div>
        </div>

        ${changedBits.length ? `<div class="ins-sec"><h4>修改记录</h4><div class="edit-record"><b>已修改：${escapeHtml(changedBits.join('、'))}</b><br>${escapeHtml(fmtFull(edTop.at || Date.now()))}${edTop.original && edTop.date && edTop.original.date ? '<br>原始时间：' + escapeHtml(fmtFull(new Date(edTop.original.date).getTime())) : ''}</div></div>` : ''}
      </div>`;

    /* 预览：非直读格式走缩略图；视频/实况稍后替换 */
    if (!DIRECT_IMG.has(it.ext) || it.virtual) {
      if (it.kind === 'video' && !it.virtual) {
        const pv = $('#insPreview');
        pv.innerHTML = `<video src="${mediaUrl(it.path)}" preload="metadata" muted playsinline></video>
          <div class="prev-actions"><button data-act="reveal">在文件夹中显示</button></div>`;
        const v = pv.querySelector('video');
        v.addEventListener('loadeddata', () => { try { v.currentTime = 0.35; } catch { /* ignore */ } });
        const pvFail = () => {
          pv.innerHTML = `<div class="ph" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#b0b0b6;font-size:11.5px">${ICON.video}<span>该编码暂不支持内嵌预览</span></div>
            <div class="prev-actions"><button data-act="reveal">在文件夹中显示</button></div>`;
        };
        /* 打包后 file:// 会被拒绝，HEVC 也不被支持：先转码，转不动再提示 */
        let pvTried = false;
        v.addEventListener('error', () => {
          if (pvTried || token !== S.insToken) { pvFail(); return; }
          pvTried = true;
          api.prepareVideo(it).then((r) => {
            if (token !== S.insToken) return;
            if (!r || !r.path) { pvFail(); return; }
            v.src = mediaUrl(r.path);
            v.load();
            setTimeout(() => { if (token === S.insToken && v.error) pvFail(); }, 3000);
          }).catch(pvFail);
        });
      } else {
        const r = await api.thumb(it);
        if (token !== S.insToken) return;
        if (r && r.url) {
          const pv = $('#insPreview');
          if (!pv) return;
          const im = el('img');
          im.className = it.kind === 'video' || it.kind === 'live' ? 'fill' : '';
          im.src = r.url;
          pv.insertBefore(im, pv.firstChild);
          pv.querySelectorAll('.ph,img:not(:first-child)').forEach((n) => { if (n !== im) n.remove(); });
        }
      }
    }

    renderChips(it);

    /* 读取完整元数据 */
    const meta = await api.meta({
      path: it.path, ext: it.ext, kind: it.kind,
      videoPath: it.videoPath || null, videoSize: it.videoSize || 0
    });
    if (token !== S.insToken) return;

    if (!meta || meta.error) {
      const geoBox = $('#insGeo');
      if (geoBox) geoBox.textContent = meta && meta.error ? `无法读取：${meta.error}` : '读取失败';
      return;
    }

    const geo = $('#insGeo');
    const ed = editOf(it);
    const customPlace = ed && ed.place;
    const gps = effectiveGps(it, ed) || (meta && meta.gps) || null;
    const coord = gps ? Number(gps.lat).toFixed(5) + ', ' + Number(gps.lon).toFixed(5) : '';
    if (geo) {
      if (gps || customPlace) {
        geo.innerHTML = `<div style="color:#1d1d1f;font-size:12.6px;line-height:1.5">${escapeHtml(customPlace || meta.place || coord)}</div>
          ${customPlace && (meta.place || meta.coord) ? '<div class="ins-orig">原始地点：' + escapeHtml(meta.place || meta.coord || '') + '</div>' : ''}
          ${customPlace && !meta.gps ? '<div class="ins-orig">手动添加 · 双击可修改</div>' : ''}
          ${gps ? '<div style="margin-top:2px">' + escapeHtml(coord) + '</div><div class="ins-map" id="insMap"></div><div class="ins-map-acts"><button data-act="amap">在高德地图打开</button><button data-act="bigmap">在足迹地图里看</button></div>' : ''}`;
        if (gps) drawInsMap(gps);
      } else {
        geo.innerHTML = '<span style="color:#a1a1a6">无 · 双击添加地点</span>';
      }
    }

    const params = $('#insParams');
    if (params) {
      const rows = [];
      rows.push(kv('格式', escapeHtml(meta.ext || (it.ext || '').toUpperCase()) + ' · ' + (KIND_LABEL[it.kind] || '')));
      if (meta.pixel) rows.push(kv('分辨率', `${meta.pixel.w} × ${meta.pixel.h}`));
      rows.push(kv('文件大小', fmtSize(meta.size)));
      if (meta.camera) rows.push(kv('相机', escapeHtml(meta.camera)));
      if (meta.lens) rows.push(kv('镜头', escapeHtml(meta.lens)));
      if (meta.exposure) {
        const e = meta.exposure;
        const bits = [];
        if (e.iso) bits.push('ISO ' + e.iso);
        if (e.f) bits.push('f/' + e.f);
        if (e.shutter) bits.push(e.shutter);
        if (e.focal) bits.push(e.focal + 'mm');
        if (bits.length) rows.push(kv('曝光', escapeHtml(bits.join(' · '))));
      }
      if (it.kind === 'video' || it.kind === 'live') {
        const dl = meta.duration || (meta.live && meta.live.duration);
        if (dl) rows.push(kv('时长', fmtDur(dl)));
        const fps = meta.fps || (meta.live && meta.live.fps);
        if (fps) rows.push(kv('帧率', fps + ' fps'));
      }
      if (meta.live) {
        rows.push(kv('实况视频', escapeHtml(meta.live.name)));
        rows.push(kv('实况大小', fmtSize(meta.live.size)));
      }
      if (it.virtual) rows.push(kv('状态', '文件可能已移动', true));
      params.innerHTML = rows.join('');
    }
  }

  function renderChips(it) {
    const box = $('#insChips');
    if (!box) return;
    const has = lib.categories.filter((c) => c.items.includes(it.path));
    const chips = has.map((c) => `<span class="chip">${escapeHtml(c.name)}
      <span class="x" data-rmcat="${c.id}" title="移出分类">${ICON.x}</span></span>`).join('');
    box.innerHTML = (chips || '') + `<span class="chip chip-btn" data-addcat="1">＋ 加入分类</span>`;
  }

  /* ───────────────────────── 全屏预览 ───────────────────────── */

  let chromeTimer = null;

  /* 鼠标移动唤出控件，静止 2.6 秒后自动淡出 */
  function flashChrome() {
    viewer.classList.remove('chrome-hidden');
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(() => {
      if (!S.viewerOpen) return;
      /* 指针停在顶部区域时不淡出，保证关闭按钮随时可点 */
      if (typeof S.hoverY === 'number' && S.hoverY < 112) { flashChrome(); return; }
      viewer.classList.add('chrome-hidden');
    }, 3000);
  }

  async function renderPdfPreview(it) {
    const canvas = viewer.querySelector('#pdfCanvas');
    if (!canvas || !window.pdfjsLib) return;
    const wrap = viewer.querySelector('#pdfWrap');
    const loading = viewer.querySelector('#pdfLoading');
    const tip = viewer.querySelector('#pdfTip');
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({
        url: mediaUrl(it.path),
        cMapUrl: 'vendor/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: 'vendor/pdfjs/standard_fonts/'
      }).promise;
      if (!canvas.isConnected) return;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const maxW = Math.max(320, Math.min(980, viewer.clientWidth - 160));
      const maxH = Math.max(260, Math.min(680, viewer.clientHeight - 210));
      const scale = Math.max(0.6, Math.min(2.4, maxW / base.width, maxH / base.height));
      const vp = page.getViewport({ scale });
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      if (!canvas.isConnected) return;
      if (wrap) wrap.classList.add('ready');
      if (loading) loading.hidden = true;
      if (tip) tip.textContent = `第 1 / ${pdf.numPages} 页 · 完整内容请用默认应用打开`;
    } catch (e) {
      if (loading) loading.textContent = 'PDF 预览失败，请点下面「用默认应用打开」';
    }
  }

  function openViewer(path, listOverride, opts = {}) {
    closeInfoEditor();
    const raw = Array.isArray(listOverride) && listOverride.length ? listOverride : S.filtered;
    const list = raw.filter((x) => x && x.kind !== 'archive');
    const idx = list.findIndex((i) => i.path === path);
    if (idx < 0) return;
    S.viewerList = list;
    S.viewerReturnAI = !aiView.hidden;
    aiView.hidden = true;
    document.body.classList.add('viewer-open');
    S.viewerIdx = idx;
    S.viewerOpen = true;
    S.viewerAt = Date.now();
    S.viewerScreen = false;
    S.slideshow = !!opts.slideshow;
    S.slideshowPaused = false;
    clearTimeout(S.slideTimer);
    if (insMapObj) { try { insMapObj.remove(); } catch { /* ignore */ } insMapObj = null; }
    try { api.setFullscreen(false); } catch { /* ignore */ }
    viewer.classList.remove('screen');
    viewer.classList.add('windowed');
    viewer.hidden = false;
    viewer.classList.remove('chrome-hidden');
    viewer.classList.remove('sheet-open');
    viewer.classList.remove('sheet-ready');
    renderViewer();
    if (opts.screen) toggleViewerScreen(true);
    if (S.slideshow) scheduleSlide();
  }

  function toggleViewerScreen(force) {
    if (!S.viewerOpen) return;
    const want = force === undefined ? !S.viewerScreen : !!force;
    S.viewerScreen = want;
    viewer.classList.toggle('screen', want);
    viewer.classList.toggle('windowed', !want);
    document.body.classList.toggle('viewer-screen', want);
    try { api.setFullscreen(want); } catch { /* ignore */ }
    setTimeout(() => { if (S.viewerOpen) syncStagePad(viewer.classList.contains('sheet-open') ? 1 : 0); }, 160);
    flashChrome();
  }

  function clearSlideshow() {
    clearTimeout(S.slideTimer);
    S.slideTimer = 0;
    S.slideshow = false;
    S.slideshowPaused = false;
  }

  function scheduleSlide() {
    clearTimeout(S.slideTimer);
    if (!S.viewerOpen || !S.slideshow || S.slideshowPaused) return;
    const list = S.viewerList || S.filtered;
    const it = list[S.viewerIdx];
    if (!it) return;
    const sec = Math.max(2, Math.min(20, Number(lib.settings.slideSec) || 4));
    S.slideTimer = setTimeout(() => {
      if (!S.viewerOpen || !S.slideshow || S.slideshowPaused) return;
      const L = S.viewerList || S.filtered;
      if (!L.length) return;
      S.viewerIdx = (S.viewerIdx + 1) % L.length;
      renderViewer();
    }, it.kind === 'video' ? Math.max(3000, sec * 1000) : sec * 1000);
  }

  function closeViewer() {
    closeInfoEditor();
    document.body.classList.remove('viewer-open');
    document.body.classList.remove('viewer-screen');
    S.viewerOpen = false;
    S.viewerList = null;
    clearSlideshow();
    S.viewerScreen = false;
    viewer.classList.remove('screen');
    try { api.setFullscreen(false); } catch { /* ignore */ }
    S.hoverY = null;
    viewer.hidden = true;
    clearTimeout(chromeTimer);
    viewer.classList.remove('chrome-hidden');
    viewer.classList.remove('sheet-open');
    viewer.classList.remove('sheet-ready');
    if (S.viewerReturnAI) {
      aiView.hidden = false;
      S.viewerReturnAI = false;
    }
    if (sheetMap) { try { sheetMap.remove(); } catch { /* ignore */ } sheetMap = null; }
    stopViewerMedia();
    viewer.innerHTML = '';
  }


  /* 切换素材 / 退出预览前，先把旧视频、音频彻底停掉并清空 src。
     只靠 innerHTML 替换时，Chromium 有时会继续播放上一段视频的声音。 */
  function stopViewerMedia() {
    viewer.querySelectorAll('video, audio').forEach((m) => {
      try { m.pause(); } catch { /* ignore */ }
      try { m.muted = true; m.volume = 0; } catch { /* ignore */ }
      try { m.removeAttribute('src'); m.load(); } catch { /* ignore */ }
    });
  }

  function renderViewer() {
    closeInfoEditor();
    if (!S.viewerOpen) return;
    /* 幻灯片从视频切到图片时，必须先停掉上一条视频的声音 */
    stopViewerMedia();
    viewer.classList.toggle('screen', !!S.viewerScreen);
    viewer.classList.toggle('windowed', !S.viewerScreen);
    viewer.classList.toggle('slideshow', !!S.slideshow);
    const list = S.viewerList || S.filtered;
    if (!list.length) { closeViewer(); return; }
    S.viewerIdx = Math.max(0, Math.min(list.length - 1, S.viewerIdx));
    const it = list[S.viewerIdx];
    const sheetToken = ++S.sheetToken;
    /* 每次换图都先把信息层收回并移除 ready，避免新面板在布局完成前闪一整帧 */
    viewer.classList.remove('sheet-ready');
    closeSheet(true);
    if (sheetMap) { try { sheetMap.remove(); } catch { /* ignore */ } sheetMap = null; }

    const media = [];
    if (it.kind === 'audio') {
      media.push(`<div class="media-doc audio-view">
        <div class="md-ico">${ICON.music}</div>
        <div class="md-name">${escapeHtml(niceName(it.name))}</div>
        <audio class="viewer-audio" src="${mediaUrl(it.path)}" controls autoplay preload="metadata"></audio>
      </div>`);
    } else if (it.kind === 'doc') {
      const isPdf = String(it.ext || '').toLowerCase() === 'pdf';
      media.push(`<div class="media-doc doc-view${isPdf ? ' pdf-view' : ''}" id="docView">
        ${isPdf ? '' : `<div class="md-ico">${ICON.doc}</div><div class="md-name">${escapeHtml(niceName(it.name))}</div>`}
        ${isPdf ? `<div class="doc-pdf-wrap" id="pdfWrap"><canvas id="pdfCanvas"></canvas><div class="doc-pdf-loading" id="pdfLoading">正在渲染 PDF…</div></div><div class="doc-pdf-tip" id="pdfTip">仅预览第一页，完整内容请用默认应用打开</div>` : `<pre class="md-body" id="docBody">正在读取…</pre>`}
        <div class="md-acts"><button data-act="openExt">用默认应用打开</button><button data-act="reveal">在文件夹中显示</button></div>
      </div>`);
    } else if (it.kind === 'video') {
      media.push(`<video class="viewer-video" controls ${lib.settings.videoAutoplay === false ? '' : 'autoplay'} preload="auto" playsinline></video>`);
    } else if (it.kind === 'live' && it.videoPath) {
      media.push(`<div class="live-box" id="liveBox">
        <img class="live-still" alt="">
        <video class="live-motion" preload="auto" muted ${lib.settings.livePlay === false ? '' : 'autoplay'} playsinline></video>
        <span class="live-tag">LIVE</span>
      </div>`);
    } else if (canDirect(it)) {
      media.push(`<img src="${imgUrl(it)}" alt="">`);
    } else {
      media.push(`<div class="viewer-fallback"><div style="font-size:13px">正在载入预览…</div></div>`);
    }

    viewer.innerHTML = `
      <div class="viewer-bg" id="viewerBg"></div>
      <div class="viewer-stage">
        ${list.length > 1 ? `<button class="nav-btn prev" data-act="prev" title="上一张">${ICON.chevL}</button>` : ''}
        ${media.join('')}
        ${list.length > 1 ? `<button class="nav-btn next" data-act="next" title="下一张">${ICON.chevR}</button>` : ''}
      </div>
      <div class="viewer-top">
        <div class="viewer-top-hit" id="viewerTopHit"></div>
        <div class="viewer-pill">
          <div class="viewer-title">${escapeHtml(niceName(it.name))}<span>${S.viewerIdx + 1} / ${list.length}${it.kind === 'live' ? ' · 实况' : ''}</span></div>
          <div class="tools">
            <button data-act="screen" title="${S.viewerScreen ? '退出铺满屏幕' : '铺满屏幕'}">${S.viewerScreen ? ICON.collapse : ICON.expand}</button>
            <button data-act="openExt" title="用默认应用打开">${ICON.folderOpen}</button>
            <button data-act="close" title="关闭（按 Esc）">${ICON.close}</button>
          </div>
        </div>
      </div>
      ${S.slideshow ? '' : `<div class="viewer-sheet" id="viewerSheet">
        <div class="sheet-grip"></div>
        <div class="sheet-inner" id="sheetInner"></div>
      </div>`}
      ${S.slideshow ? '<div class="slide-bar"><button data-act="slidePause">' + (S.slideshowPaused ? '继续' : '暂停') + '</button><span>幻灯片 · ' + (S.viewerIdx + 1) + ' / ' + list.length + '</span><button data-act="endSlide">退出</button></div>' : ''}`;

    const setBg = (u) => {
      const bg = viewer.querySelector('#viewerBg');
      if (bg && u) bg.style.backgroundImage = 'url("' + u + '")';
    };

    if (canDirect(it)) {
      setBg(imgUrl(it));
    } else if (it.kind === 'video' || it.kind === 'live') {
      api.thumb(it).then((r) => { if (r && r.url) setBg(r.url); });
    } else {
      api.prepareImage(it).then((r) => {
        if (!S.viewerOpen || !r || !r.path) return;
        const st = viewer.querySelector('.viewer-stage');
        if (!st) return;
        const im = el('img');
        im.src = mediaUrl(r.path);
        const fb = st.querySelector('.viewer-fallback');
        if (fb) fb.replaceWith(im);
        setBg(mediaUrl(r.path));
      }).catch(() => {
        api.thumb(it).then((r) => {
          if (!r || !r.url) return;
          setBg(r.url);
          const st = viewer.querySelector('.viewer-stage');
          const fb = st && st.querySelector('.viewer-fallback');
          if (fb) { const im = el('img'); im.src = r.url; fb.replaceWith(im); }
        });
      });
    }

    /* 实况：先铺静态封面（HEIC 也能显示），再叠一层动态视频 */
    const liveBox = viewer.querySelector('#liveBox');
    if (liveBox) {
      const still = liveBox.querySelector('.live-still');
      const motion = liveBox.querySelector('.live-motion');
      /* 静态封面优先用原图（清晰不裁切），HEIC 等再退回缩略图 */
      if (canDirect(it)) {
        const u = imgUrl(it);
        still.addEventListener('load', () => liveBox.classList.add('ready'), { once: true });
        still.src = u;
        setBg(u);
      } else {
        api.thumb(it).then((r) => {
          if (!r || !r.url || !still.isConnected) return;
          still.src = r.url;
          setBg(r.url);
          liveBox.classList.add('ready');
        });
      }
      /* 封面解码不出来（HEIC 等）：把画面交给视频本身，避免整块空白 */
      const markNoCover = () => {
        if (!still.isConnected) return;
        if (still.naturalWidth > 0) return;
        liveBox.classList.add('no-cover');
      };
      /* 封面晚到（HEIC 转码）时补上：解码成功就把画面交回封面 */
      still.addEventListener('load', () => {
        if (still.naturalWidth > 0 && still.isConnected) liveBox.classList.remove('no-cover');
      });
      still.addEventListener('error', markNoCover);
      setTimeout(markNoCover, 1200);
      motion.addEventListener('loadedmetadata', markNoCover);

      /* Chromium 的自动播放策略常把 autoplay 拦掉（表现为只看到静态帧），这里显式 play() 并重试 */
      const showMotion = () => {
        if (motion.readyState >= 2) liveBox.classList.add('playing');
      };
      const kick = () => {
        if (lib.settings.livePlay === false && !motion.__userStarted) return;
        showMotion();
        if (!motion.paused || !motion.isConnected) return;
        try {
          const pr = motion.play();
          if (pr && typeof pr.catch === 'function') pr.catch(() => { /* 被拦：保留封面 */ });
        } catch { /* ignore */ }
      };
      const failLive = () => {
        if (liveBox.classList.contains('failed')) return;
        try { motion.remove(); } catch { /* ignore */ }
        liveBox.classList.remove('playing');
        liveBox.classList.add('failed');
        if (still.isConnected) {
          still.classList.add('only');
          if (!still.getAttribute('src')) liveBox.classList.add('no-cover');
        }
        const tip = el('div', 'live-fail');
        tip.textContent = '实况视频无法内嵌播放';
        liveBox.appendChild(tip);
        const btn = el('button', 'live-open');
        btn.dataset.act = 'openExt';
        btn.textContent = '用系统播放器打开';
        liveBox.appendChild(btn);
      };

      ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'seeked']
        .forEach((ev) => motion.addEventListener(ev, kick));
      /* 编码不被支持（如 HEVC .MOV）：先转码再重试一次，仍失败才提示 */
      let liveRetried = false;
      const retryLive = () => {
        if (!motion.isConnected || liveRetried) return;
        liveRetried = true;
        api.prepareVideo(it).then((r) => {
          if (!motion.isConnected) return;
          if (r && r.path) {
            motion.src = mediaUrl(r.path);
            motion.load();
            kick();
            setTimeout(() => {
              if (!motion.isConnected) return;
              if (motion.error || motion.videoWidth === 0) failLive();
            }, 3500);
          } else {
            failLive();
          }
        }).catch(() => failLive());
      };
      motion.addEventListener('error', () => {
        if (!motion.isConnected) return;
        if (liveRetried) { failLive(); return; }
        retryLive();
      });
      /* Chromium 有时只解出声轨、画面是黑的（readyState 都正常、videoWidth 却是 0），
         这种情况不会触发 error，必须主动探测一次 */
      const probeLive = () => {
        if (!motion.isConnected || motion.error || liveRetried) return;
        if (!livePrepared || !motion.getAttribute('src')) return;
        if (motion.videoWidth > 0) return;
        retryLive();
      };
      ['loadeddata', 'canplay', 'playing'].forEach((ev) => motion.addEventListener(ev, () => setTimeout(probeLive, 800)));
      setTimeout(probeLive, 2800);
      const liveStage = viewer.querySelector('.viewer-stage');
      if (it.liveNeedTc) retryLive();

      /* 先等转码/镜像校正完成再换源。否则会先播原片、几百毫秒后又切到校正版，
         视觉上就是「打开瞬间反转一下」。封面先顶着，换源后再淡入动态。 */
      let livePrepared = false;
      api.prepareVideo(it).then((r) => {
        if (!motion.isConnected) return;
        livePrepared = true;
        motion.src = mediaUrl((r && r.path) || it.videoPath);
        motion.load();
        kick();
      }).catch(() => {
        if (!motion.isConnected) return;
        livePrepared = true;
        motion.src = mediaUrl(it.videoPath);
        motion.load();
        kick();
      });

      /* 实况控制：苹果式折叠胶囊。默认只露「实况 · 状态」，点开才是两个选项。
         位置放在画面左下、信息抽屉上方，不再贴着左上角。 */
      if (liveStage && !liveStage.querySelector('.live-ctl')) {
        const ctl = el('div', 'live-ctl');
        ctl.dataset.state = 'static';
        ctl.innerHTML = '<button class="live-head" title="显示实况选项" aria-label="显示实况选项">'
          + '<span class="live-dot"></span><span>实况</span><span class="live-head-state">静态</span>'
          + '<span class="live-chevron"><svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
          + '</button>'
          + '<div class="live-opts">'
          + '<button data-live="static" class="on">静态图片</button>'
          + '<button data-live="loop">循环播放</button>'
          + '</div>';
        liveStage.appendChild(ctl);
        const head = ctl.querySelector('.live-head');
        const state = ctl.querySelector('.live-head-state');
        const bStatic = ctl.querySelector('[data-live="static"]');
        const bLoop = ctl.querySelector('[data-live="loop"]');
        const setOpen = (on) => {
          ctl.classList.toggle('open', !!on);
          ctl.dataset.open = on ? '1' : '0';
        };
        const setButtons = (mode) => {
          bStatic.classList.toggle('on', mode === 'static');
          bLoop.classList.toggle('on', mode === 'loop');
          ctl.dataset.state = mode;
          state.textContent = mode === 'loop' ? '循环' : mode === 'play' ? '播放中' : '静态';
        };
        const setStatic = () => {
          motion.loop = false;
          try { motion.pause(); } catch { /* ignore */ }
          liveBox.classList.remove('playing');
          setButtons('static');
        };
        const playOnce = (hold) => {
          motion.__userStarted = true;
          motion.loop = !!hold;
          try { motion.currentTime = 0; } catch { /* ignore */ }
          liveBox.classList.add('playing');
          const pr = motion.play();
          if (pr && typeof pr.catch === 'function') pr.catch(() => { /* ignore */ });
          setButtons(hold ? 'loop' : 'play');
        };
        const playLoop = () => {
          motion.__userStarted = true;
          motion.loop = true;
          liveBox.classList.add('playing');
          const pr = motion.play();
          if (pr && typeof pr.catch === 'function') pr.catch(() => { /* ignore */ });
          setButtons('loop');
        };
        head.addEventListener('click', (ev) => {
          ev.stopPropagation();
          setOpen(!ctl.classList.contains('open'));
        });
        bStatic.addEventListener('click', (ev) => { ev.stopPropagation(); setStatic(); setOpen(false); });
        bLoop.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (bLoop.classList.contains('on')) setStatic(); else playLoop();
          setOpen(false);
        });
        const closeOnOutside = (ev) => {
          if (!ctl.classList.contains('open')) return;
          if (ev.target.closest('.live-ctl')) return;
          setOpen(false);
        };
        viewer.addEventListener('pointerdown', closeOnOutside, true);
        motion.addEventListener('ended', () => {
          if (!motion.isConnected) return;
          if (motion.loop) return;
          liveBox.classList.remove('playing');
          setButtons('static');
        });
        motion.addEventListener('playing', () => {
          if (!motion.isConnected) return;
          if (motion.loop) setButtons('loop');
          else if (!motion.paused) setButtons('play');
        });
        /* 画面上单击播放一次；长按持续循环，松开回到静态 */
        let holdTimer = 0, holding = false, downAt = 0, downX = 0, downY = 0;
        const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; } };
        liveStage.addEventListener('pointerdown', (ev) => {
          if (ev.button !== 0) return;
          if (ev.target.closest('.live-ctl, .live-open, .live-fail')) return;
          holding = false; downAt = Date.now(); downX = ev.clientX; downY = ev.clientY;
          clearHold();
          holdTimer = setTimeout(() => { holding = true; playLoop(); }, 460);
        });
        liveStage.addEventListener('pointerup', (ev) => {
          if (!downAt) return;
          const moved = Math.abs(ev.clientX - downX) > 6 || Math.abs(ev.clientY - downY) > 6;
          const wasHolding = holding;
          const wasQuick = Date.now() - downAt < 460;
          downAt = 0; holding = false; clearHold();
          if (wasHolding) { setStatic(); return; }
          if (wasQuick && !moved) playOnce(false);
        });
        liveStage.addEventListener('pointercancel', () => { downAt = 0; holding = false; clearHold(); });
        if (lib.settings.livePlay === false) setStatic();
      }
      motion.muted = true;
      motion.defaultMuted = true;
      try { motion.playsInline = true; } catch { /* ignore */ }

      /* 兜底：还在暂停就继续重试；超过 12 次仍未动，判定为被策略拦死 */
      let liveTries = 0;
      const liveTimer = setInterval(() => {
        if (!motion.isConnected || !S.viewerOpen) { clearInterval(liveTimer); return; }
        if (!motion.paused && motion.currentTime > 0) { showMotion(); clearInterval(liveTimer); return; }
        if (liveTries++ > 12) { clearInterval(liveTimer); return; }
        kick();
      }, 240);
      setTimeout(() => {
        if (!motion.isConnected) return;
        if (motion.error) failLive();
      }, 2000);
    }

    /* 文本文档直接读出来预览，其他格式交给默认应用 */
    if (viewer.querySelector('#pdfCanvas')) renderPdfPreview(it);
    const docBody = viewer.querySelector('#docBody');
    if (docBody) {
      api.previewDoc(it.path).then((r) => {
        if (!docBody.isConnected) return;
        docBody.textContent = (r && r.text) ? r.text.slice(0, 200000) : ((r && r.error) || '预览失败');
      }).catch(() => { if (docBody.isConnected) docBody.textContent = '预览失败'; });
    }

    const v = viewer.querySelector('video');
    if (v && !liveBox) {
      const startVideo = () => {
        if (lib.settings.videoAutoplay === false) return;
        if (!v.paused) return;
        try {
          const pr = v.play();
          if (pr && typeof pr.catch === 'function') pr.catch(() => { /* 等用户点播放 */ });
        } catch { /* ignore */ }
      };
      ['loadedmetadata', 'canplay', 'canplaythrough'].forEach((ev) => v.addEventListener(ev, startVideo));
      startVideo();
      /* HEVC / AVI 等 Chromium 解不了的编码：后台用随包 ffmpeg 转成 H.264 再重试；
         只有转码也失败、或换源后仍然没有画面，才给「用系统播放器打开」的兜底 */
      const showTip = () => {};
      const hideTip = () => {};
      /* 先用缩略图当 poster，点开立刻有画面，不再先黑一下再出帧 */
      api.thumb(it).then((r) => { if (r && r.url && v.isConnected) v.poster = r.url; }).catch(() => { /* ignore */ });
      v.src = mediaUrl(it.path);
      v.load();
      v.addEventListener('loadeddata', () => { if (v.videoWidth > 0) hideTip(); });

      const videoFallback = () => {
        const st = viewer.querySelector('.viewer-stage');
        if (!st || !v.isConnected) return;
        hideTip();
        try { v.remove(); } catch { /* ignore */ }
        const fb = el('div', 'viewer-fallback');
        fb.innerHTML = '<div>该视频的编码无法内嵌播放（如 AVI / HEVC）</div>'
          + '<button data-act="openExt">用系统播放器打开</button>';
        st.appendChild(fb);
      };
      let vidRetried = false;
      const retryVideo = () => {
        if (!v.isConnected || vidRetried) return;
        vidRetried = true;
        api.prepareVideo(it).then((r) => {
          if (!v.isConnected) return;
          if (!r || !r.path) { videoFallback(); return; }
          v.src = mediaUrl(r.path);
          v.load();
          startVideo();
          setTimeout(() => { if (v.isConnected && (v.error || v.videoWidth === 0)) videoFallback(); }, 3500);
        }).catch(videoFallback);
      };
      v.addEventListener('error', () => {
        if (!v.isConnected) return;
        if (vidRetried) { videoFallback(); return; }
        retryVideo();
      });
      /* 只出声轨、画面全黑（videoWidth 为 0、又没有 error）时也要转码 */
      const probeVideo = () => {
        if (!v.isConnected || v.error || vidRetried) return;
        if (v.videoWidth > 0) return;
        showTip('正在解码画面…');
        retryVideo();
      };
      ['loadeddata', 'canplay'].forEach((ev) => v.addEventListener(ev, () => setTimeout(probeVideo, 700)));
      setTimeout(probeVideo, 2600);
      /* 扫描时已经知道要转码（HEVC / 带旋转）→ 直接开始，不用等探测 */
      if (it.needTc) { showTip('正在解码画面…'); retryVideo(); }
      }

    viewer.classList.toggle('has-motion', it.kind === 'video' || it.kind === 'live');
    flashChrome();
    const revealSheet = () => {
      if (!S.viewerOpen || S.slideshow) return;
      /* 上一张遗留的 fillSheet / 1200ms 兜底不能把当前这张的信息层提前放出来 */
      if (sheetToken !== S.sheetToken) return;
      if (viewer.classList.contains('sheet-ready')) return;
      closeSheet(true);
      viewer.classList.add('sheet-ready');
    };
    if (!S.slideshow) {
      /* 先让画面出现，再把底部把手淡入；切换瞬间不会先闪一条信息栏 */
      const revealSheetLater = () => setTimeout(revealSheet, 480);
      fillSheet(it).then(revealSheetLater).catch(revealSheetLater);
      setTimeout(revealSheet, 1200);
    }
    scheduleSlide();
    /* 每次换图都复位信息层与图片区，避免上一张的抽屉高度残留，导致图片被压成小图。
       布局计算必须同步跑一次，之后再用 rAF / 160ms 兜底，避免打包版窗口刚显示时
       舞台高度还是旧的，图片按错误高度铺满而被裁掉。 */
    syncStagePad(0);
    requestAnimationFrame(() => {
      if (!S.viewerOpen) return;
      viewer.classList.remove('sheet-open');
      closeSheet(true);
      syncStagePad(0);
    });
    setTimeout(() => { if (S.viewerOpen) syncStagePad(viewer.classList.contains('sheet-open') ? 1 : 0); }, 160);
  }

  /* 双击名称/备注：改真实文件名 + 本地备注 */
  async function editItemInfo(it) {
    const e = editOf(it) || {};
    const meta = await metaOf(it).catch(() => null);
    const raw = rawDateOf(it);
    const shown = dtOf(it) || raw;
    const note = (e.note != null ? e.note : ((lib.notes || {})[it.path] || '')) || '';
    const place = (e.place != null ? e.place : ((it.place || (meta && meta.place) || ''))) || '';
    const y = shown ? shown.getFullYear() : '';
    const mo = shown ? pad(shown.getMonth() + 1) : '';
    const da = shown ? pad(shown.getDate()) : '';
    const hh = shown ? pad(shown.getHours()) : '00';
    const mi = shown ? pad(shown.getMinutes()) : '00';

    openModal('<h3>编辑素材信息</h3>'
      + '<div class="sub">时间和地点会同步到本地文件：时间写入文件时间，地点和备注写入同名 XMP 侧车；原始信息会保留。</div>'
      + '<label class="set-lab">名称</label><input type="text" id="eiName" value="' + escapeHtml(it.name) + '" />'
      + '<div class="edit-grid"><label class="set-lab">日期<input type="date" id="eiDate" value="' + (y ? y + '-' + mo + '-' + da : '') + '" /></label>'
      + '<label class="set-lab">时间<input type="time" id="eiTime" step="1" value="' + hh + ':' + mi + '" /></label></div>'
      + '<label class="set-lab">地点</label><input type="text" id="eiPlace" maxlength="120" value="' + escapeHtml(place) + '" placeholder="例如：佛山 · 千灯湖" />'
      + '<label class="set-lab">备注</label><input type="text" id="eiNote" maxlength="200" value="' + escapeHtml(note) + '" placeholder="例如：毕业照 / 待整理" />'
      + '<div class="modal-foot"><button class="btn-ghost" data-act="cancel">取消</button><button class="btn-primary" data-act="ok">保存并同步</button></div>', (m) => {
      const nm = m.querySelector('#eiName');
      const dtIn = m.querySelector('#eiDate');
      const tmIn = m.querySelector('#eiTime');
      const plIn = m.querySelector('#eiPlace');
      const nt = m.querySelector('#eiNote');
      nm.focus();
      m.querySelector('[data-act="cancel"]').addEventListener('click', closeModal);
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        const want = nm.value.trim();
        const dateStr = dtIn.value;
        const timeStr = tmIn.value || '00:00:00';
        let iso = '';
        if (dateStr) {
          const parts = dateStr.split('-').map(Number);
          const tparts = timeStr.split(':').map(Number);
          const d = new Date(parts[0], parts[1] - 1, parts[2], tparts[0] || 0, tparts[1] || 0, tparts[2] || 0);
          if (!Number.isNaN(d.getTime())) {
            iso = parts[0] + '-' + pad(parts[1]) + '-' + pad(parts[2]) + 'T' + pad(tparts[0] || 0) + ':' + pad(tparts[1] || 0) + ':' + pad(tparts[2] || 0);
          }
        }
        const placeVal = plIn.value.trim();
        const noteVal = nt.value.trim();
        let target = it.path;
        if (want && want !== it.name) {
          if (it.arc || it.virtual) { toast('压缩包或回收站里的素材暂不支持改名，其他信息会保存'); }
          else {
            const r = await api.renameFile(it.path, want);
            if (!r || !r.ok) { toast('改名失败：' + ((r && r.error) || '未知错误')); return; }
            target = r.path || it.path;
          }
        }
        const original = (e.original && typeof e.original === 'object') ? e.original : {
          date: raw ? raw.toISOString() : '',
          place: it.place || (meta && meta.place) || '',
          note: (lib.notes || {})[it.path] || '',
          name: it.name
        };
        const rec = Object.assign({}, e, {
          date: iso || null,
          place: placeVal || null,
          note: noteVal || null,
          original,
          at: Date.now()
        });
        lib.edits = lib.edits || {};
        if (target !== it.path) { delete lib.edits[it.path]; }
        lib.edits[target] = rec;
        lib.notes = lib.notes || {};
        if (noteVal) lib.notes[target] = noteVal; else delete lib.notes[target];
        persist();
        const wr = await api.updateInfo({ path: target, date: iso, place: placeVal, note: noteVal });
        if (!wr || !wr.ok) toast('信息已保存在软件内，但本地侧车写入失败：' + ((wr && wr.error) || '未知错误'));
        else toast('已保存并同步到本地');
        closeModal();
        if (target !== it.path || (want && want !== it.name)) {
          if (S.root) openFolder(S.root);
        } else {
          const ni = lookupItem(target);
          if (ni) { ni.name = it.name; ni.shotAt = iso ? new Date(iso).getTime() : it.shotAt; ni.place = placeVal || it.place; }
          renderList(true);
          if (S.active) showInspector(lookupItem(S.active));
          if (S.viewerOpen) renderViewer();
        }
      });
    });
  }

  /* ───────────── 信息就地编辑（不弹信息表单） ───────────── */
  function fmtDateInput(d) { return d ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) : ''; }
  function fmtTimeInput(d) { return d ? pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) : ''; }
  function effectiveGps(it, ed) {
    const g = (ed && ed.gps) || (it && it.gps) || null;
    if (g && Number.isFinite(Number(g.lat)) && Number.isFinite(Number(g.lon))) return { lat: Number(g.lat), lon: Number(g.lon) };
    return null;
  }

  async function applyInfoPatch(it, patch) {
    if (!it) return;
    if (it.isBin) { toast('回收站里的素材不能修改信息，请先还原'); return; }
    const meta = await metaOf(it).catch(() => null);
    const e = editOf(it) || {};
    const raw = rawDateOf(it);
    const original = (e.original && typeof e.original === 'object') ? e.original : {
      date: raw ? raw.toISOString() : '',
      place: it.place || (meta && meta.place) || '',
      note: (lib.notes || {})[it.path] || '',
      name: it.name
    };
    const rec = Object.assign({}, e, patch, { original, at: Date.now() });
    if (patch.date === null) delete rec.date;
    if (patch.place === null) delete rec.place;
    if (patch.note === null) delete rec.note;
    if (patch.lat === null) { delete rec.lat; delete rec.lon; delete rec.gps; }
    if (Number.isFinite(Number(patch.lat)) && Number.isFinite(Number(patch.lon))) {
      rec.lat = Number(patch.lat); rec.lon = Number(patch.lon); rec.gps = { lat: rec.lat, lon: rec.lon };
    }
    lib.edits = lib.edits || {};
    lib.edits[it.path] = rec;
    lib.notes = lib.notes || {};
    if (rec.note) lib.notes[it.path] = rec.note; else delete lib.notes[it.path];
    persist();
    const wr = await api.updateInfo({
      path: it.path,
      date: rec.date || '',
      place: rec.place || '',
      note: rec.note || '',
      lat: rec.lat, lon: rec.lon
    });
    if (wr && wr.mtime) it.mtime = wr.mtime;
    if (rec.date) it.shotAt = new Date(rec.date).getTime();
    if (!wr || !wr.ok) toast('信息已保存在软件内，本地写入失败：' + ((wr && wr.error) || '未知错误'));
    else toast('已保存并同步到本地');
    if (S.active) showInspector(lookupItem(S.active));
    if (S.viewerOpen) {
      const cur = (S.viewerList || S.filtered)[S.viewerIdx] || it;
      fillSheet(cur && cur.path === it.path ? it : cur);
    } else {
      renderList(true);
      if (S.active) showInspector(lookupItem(S.active));
    }
  }

  async function renameInline(it, want) {
    const name = String(want || '').trim();
    if (!name || name === it.name) return false;
    if (it.virtual || it.isBin) { toast('回收站或压缩包里的素材暂不支持改名'); return false; }
    const r = await api.renameFile(it.path, name);
    if (!r || !r.ok) { toast('改名失败：' + ((r && r.error) || '未知错误')); return false; }
    const old = it.path;
    const np = r.path || it.path;
    if (lib.edits && lib.edits[old]) { lib.edits[np] = lib.edits[old]; delete lib.edits[old]; }
    if (lib.notes && lib.notes[old]) { lib.notes[np] = lib.notes[old]; delete lib.notes[old]; }
    for (const c of (lib.categories || [])) c.items = c.items.map((x) => x === old ? np : x);
    persist();
    if (S.active === old) S.active = np;
    if (S.viewerOpen) closeViewer();
    if (S.root) openFolder(S.root); else renderList(true);
    return true;
  }

  let infoEditorCleanup = null;
  function closeInfoEditor() {
    if (typeof infoEditorCleanup === 'function') {
      try { infoEditorCleanup(); } catch { /* ignore */ }
    }
    infoEditorCleanup = null;
  }

  function makeInlineEditor(target, it, field) {
    if (!target || !it) return;
    closeInfoEditor();
    const isTime = field === 'time';
    const isNote = field === 'note';
    const isName = field === 'name';
    const ed = editOf(it) || {};
    const d = dtOf(it) || rawDateOf(it) || new Date();
    const wrap = document.createElement('div');
    wrap.className = 'info-editor';
    wrap.id = 'infoEditor';
    const title = isTime ? '修改拍摄时间' : isName ? '修改名称' : '修改备注';
    const sub = isTime ? '日期和时间会写回本地文件，原始时间仍保留' : '保存后同步到本地文件，右侧信息栏会保留修改记录';
    wrap.innerHTML = '<div class="ie-head"><div><div class="ie-title">' + title + '</div><div class="ie-sub">' + sub + '</div></div>'
      + '<button class="ie-close" title="关闭" aria-label="关闭">×</button></div>'
      + (isTime
        ? '<div class="ie-grid">'
          + '<label class="ie-field"><span class="ie-label">日期</span><input id="ieDate" type="date" /></label>'
          + '<label class="ie-field"><span class="ie-label">时间</span><input id="ieTime" type="time" step="1" /></label>'
          + '</div>'
        : '<label class="ie-field"><span class="ie-label">' + (isName ? '文件名' : '备注') + '</span><input id="ieText" type="text" maxlength="' + (isName ? '180' : '200') + '" /></label>')
      + '<div class="ie-actions"><button class="ie-cancel">取消</button><button class="ie-save">保存</button></div>';
    document.body.appendChild(wrap);

    const dateIn = wrap.querySelector('#ieDate');
    const timeIn = wrap.querySelector('#ieTime');
    const textIn = wrap.querySelector('#ieText');
    if (isTime) {
      dateIn.value = fmtDateInput(d);
      timeIn.value = fmtTimeInput(d);
    } else {
      textIn.value = isName ? it.name
        : (ed.note != null ? ed.note : ((lib.notes || {})[it.path] || ''));
      textIn.placeholder = isNote ? '例如：毕业照 / 待整理' : '输入文件名称';
    }

    const close = () => {
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      if (wrap.isConnected) wrap.remove();
      if (infoEditorCleanup === close) infoEditorCleanup = null;
    };
    const onDocDown = (ev) => {
      if (!wrap.isConnected) return;
      if (ev.target.closest('#infoEditor')) return;
      close();
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
      if (ev.key === 'Enter' && !ev.shiftKey && ev.target.tagName !== 'TEXTAREA') {
        ev.preventDefault();
        save();
      }
    };
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    infoEditorCleanup = close;

    const place = () => {
      const r = target.getBoundingClientRect();
      const w = wrap.offsetWidth || 356;
      const h = wrap.offsetHeight || 190;
      let left = Math.max(10, Math.min(innerWidth - w - 10, r.left));
      let top = r.bottom + 8;
      if (top + h > innerHeight - 10) top = Math.max(10, r.top - h - 8);
      wrap.style.left = Math.round(left) + 'px';
      wrap.style.top = Math.round(top) + 'px';
    };
    place();
    requestAnimationFrame(place);

    const saveBtn = wrap.querySelector('.ie-save');
    const cancelBtn = wrap.querySelector('.ie-cancel');
    const closeBtn = wrap.querySelector('.ie-close');
    let busy = false;
    const save = async () => {
      if (busy) return;
      if (isTime) {
        const ds = dateIn.value;
        if (!ds) { toast('请选择日期'); dateIn.focus(); return; }
        const ts = timeIn.value || '00:00:00';
        const parts = ds.split('-').map(Number);
        const tp = ts.split(':').map(Number);
        const iso = parts[0] + '-' + pad(parts[1]) + '-' + pad(parts[2]) + 'T'
          + pad(tp[0] || 0) + ':' + pad(tp[1] || 0) + ':' + pad(tp[2] || 0);
        busy = true; saveBtn.disabled = true; saveBtn.textContent = '保存中…';
        try { await applyInfoPatch(it, { date: iso }); close(); } catch { /* applyInfoPatch 已 toast */ }
        finally { busy = false; if (saveBtn.isConnected) { saveBtn.disabled = false; saveBtn.textContent = '保存'; } }
        return;
      }
      if (isName) {
        const name = String(textIn.value || '').trim();
        if (!name || name === it.name) { close(); return; }
        busy = true; saveBtn.disabled = true; saveBtn.textContent = '保存中…';
        try {
          const ok = await renameInline(it, name);
          if (ok) close();
        } finally {
          busy = false;
          if (saveBtn.isConnected) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
        }
        return;
      }
      const val = String(textIn.value || '').trim();
      busy = true; saveBtn.disabled = true; saveBtn.textContent = '保存中…';
      try { await applyInfoPatch(it, { note: val || null }); close(); } catch { /* ignore */ }
      finally { busy = false; if (saveBtn.isConnected) { saveBtn.disabled = false; saveBtn.textContent = '保存'; } }
    };

    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', save);
    if (textIn) { textIn.focus(); if (isName) textIn.select(); }
    else dateIn.focus();
    place();
  }
  function beginInlineEdit(el, field, it) {
    if (!el || !it) return;
    if (field === 'place') { openPlacePicker(it); return; }
    const dark = !!el.closest('.viewer-sheet');
    makeInlineEditor(el, it, field, dark);
  }

  async function openPlacePicker(it) {
    closeInfoEditor();
    if (!it) return;
    const meta = await metaOf(it).catch(() => null);
    const ed = editOf(it) || {};
    const gps = effectiveGps(it, ed) || (meta && meta.gps) || null;
    const curName = (ed.place != null ? ed.place : (it.place || (meta && meta.place) || '')) || '';
    let picked = gps ? { lat: gps.lat, lon: gps.lon, name: curName } : null;
    openModal(
      '<div class="place-head"><h3>修改地点</h3>'
      + '<div class="place-search"><input id="peSearch" placeholder="搜索地点，例如 千灯湖 / 佛山祖庙" autocomplete="off" /><button data-act="peGo">搜索</button></div>'
      + '<button class="place-close" data-act="peClose">×</button></div>'
      + '<div class="place-map" id="peMap"></div>'
      + '<div class="place-foot"><div class="place-name" id="peName">' + (curName ? escapeHtml(curName) : '在地图上单击或搜索后选择地点') + '</div>'
      + '<button class="place-reset" data-act="peReset">清除地点</button><button class="place-ok" data-act="peSave">使用此地点</button></div>',
      (m) => {
        m.classList.add('place-modal');
        const mapEl = m.querySelector('#peMap');
        const nameEl = m.querySelector('#peName');
        const search = m.querySelector('#peSearch');
        const start = picked || { lat: 23.0218, lon: 113.1219, name: '' };
        const map = L.map(mapEl, { zoomControl: true, attributionControl: false }).setView([start.lat, start.lon], picked ? 15 : 12);
        L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
          subdomains: ['1', '2', '3', '4'], maxZoom: 19
        }).addTo(map);
        let marker = null;
        const refreshName = async () => {
          if (!picked) return;
          nameEl.textContent = picked.name || '正在解析地点…';
          if (!picked.name) {
            const nm = await api.place({ lat: picked.lat, lon: picked.lon }).catch(() => null);
            if (nm) { picked.name = nm; nameEl.textContent = nm; }
          }
        };
        const put = (lat, lon, name) => {
          picked = { lat, lon, name: name || '' };
          if (!marker) {
            marker = L.marker([lat, lon], { draggable: true }).addTo(map);
            marker.on('dragend', () => { const p = marker.getLatLng(); picked = { lat: p.lat, lon: p.lng, name: '' }; refreshName(); });
          } else marker.setLatLng([lat, lon]);
          map.setView([lat, lon], Math.max(map.getZoom(), 14));
          nameEl.textContent = name || '正在解析地点…';
          if (!name) refreshName();
        };
        if (picked) put(picked.lat, picked.lon, picked.name);
        map.on('click', (ev) => put(ev.latlng.lat, ev.latlng.lng, ''));
        const go = async () => {
          const q = search.value.trim();
          if (!q) return;
          nameEl.textContent = '正在搜索…';
          const list = await api.geocode(q).catch(() => []);
          if (!list || !list.length) { nameEl.textContent = '没有找到这个地点，请换个关键词'; return; }
          put(list[0].lat, list[0].lon, list[0].name);
        };
        m.querySelector('[data-act="peGo"]').addEventListener('click', go);
        search.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
        m.querySelector('[data-act="peClose"]').addEventListener('click', closeModal);
        const saveBtn = m.querySelector('[data-act="peSave"]');
        const resetBtn = m.querySelector('[data-act="peReset"]');
        resetBtn.addEventListener('click', async () => {
          resetBtn.disabled = true;
          resetBtn.textContent = '清除中…';
          try { await applyInfoPatch(it, { place: null, lat: null, lon: null }); closeModal(); }
          finally {
            resetBtn.disabled = false;
            resetBtn.textContent = '清除地点';
          }
        });
        saveBtn.addEventListener('click', async () => {
          if (!picked) { toast('请在地图上选一个地点'); return; }
          saveBtn.disabled = true;
          saveBtn.textContent = '保存中…';
          try {
            await applyInfoPatch(it, { place: picked.name || curName || '自定义地点', lat: picked.lat, lon: picked.lon });
            closeModal();
          } catch { /* applyInfoPatch 已提示 */ }
          finally {
            saveBtn.disabled = false;
            saveBtn.textContent = '使用此地点';
          }
        });
        setTimeout(() => map.invalidateSize(), 80);
      }
    );
  }

  inspector.addEventListener('dblclick', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (!ed) return;
    const it = S.active && lookupItem(S.active);
    if (it) beginInlineEdit(ed, ed.dataset.edit, it);
  });

  /* ───────────────────────── 分类操作 ───────────────────────── */

  function addToCategory(catId, paths) {
    const cat = lib.categories.find((c) => c.id === catId);
    if (!cat) return 0;
    let n = 0;
    for (const p of paths) {
      if (!cat.items.includes(p)) { cat.items.push(p); n += 1; }
    }
    persist();
    renderSidebar();
    renderChips(S.byPath.get(paths[0]) || itemForPath(paths[0]));
    if (S.mode === 'cat' && S.payload === catId) renderList(true);
    return n;
  }

  function removeFromCategory(catId, p) {
    const cat = lib.categories.find((c) => c.id === catId);
    if (!cat) return false;
    const had = cat.items.includes(p);
    cat.items = cat.items.filter((x) => x !== p);
    persist();
    renderSidebar();
    const it = S.byPath.get(p) || itemForPath(p);
    renderChips(it);
    if (S.mode === 'cat' && S.payload === catId) renderList(true);
    return had;
  }

  function createCategory(name, paths) {
    const nm = (name || '').trim();
    if (!nm) return null;
    const cat = {
      id: 'c' + Math.random().toString(36).slice(2, 9),
      name: nm,
      items: paths ? paths.slice() : [],
      at: Date.now()
    };
    lib.categories.push(cat);
    persist();
    renderSidebar();
    return cat;
  }

  /* ───────────────────────── 弹层 ───────────────────────── */

  function openModal(html, mount) {
    modalRoot.hidden = false;
    modalRoot.innerHTML = `<div class="modal">${html}</div>`;
    if (mount) mount(modalRoot.querySelector('.modal'));
  }

  function closeModal() {
    modalRoot.hidden = true;
    modalRoot.innerHTML = '';
  }

  function modalNewCategory(paths) {
    openModal(`
      <h3>新建分类</h3>
      <div class="sub">分类只是虚拟标签，不会移动或复制本地文件。</div>
      <input type="text" id="catName" placeholder="例如：旅行 / 工作 / 生活 / 截图" maxlength="24">
      <div class="modal-foot">
        <button class="btn-ghost" data-act="cancel">取消</button>
        <button class="btn-primary" data-act="ok">创建</button>
      </div>`, (m) => {
      const input = m.querySelector('#catName');
      input.focus();
      const ok = () => {
        const cat = createCategory(input.value, paths || []);
        if (!cat) { toast('请输入分类名称'); return; }
        closeModal();
        toast(`已创建分类「${cat.name}」`);
        if (paths && paths.length) {
          S.mode = 'cat'; S.payload = cat.id;
          S.filter = 'all';
          renderSidebar(); renderList(true);
        }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      m.querySelector('[data-act="ok"]').addEventListener('click', ok);
      m.querySelector('[data-act="cancel"]').addEventListener('click', closeModal);
    });
  }

  function modalPickCategory(paths) {
    const rows = lib.categories.map((c) => `
      <div class="row" data-pick="${c.id}">
        <span class="row-ico">${ICON.folder}</span>
        <span class="row-label">${escapeHtml(c.name)}</span>
        <span class="row-count">${c.items.length}</span>
      </div>`).join('');

    openModal(`
      <h3>加入分类</h3>
      <div class="sub">已选 ${paths.length} 项素材。可放入已有分类，或新建一个。</div>
      <div class="list" id="pickList">
        ${rows || '<div class="side-note">无</div>'}
      </div>
      <div class="modal-foot">
        <button class="btn-ghost" data-act="cancel">取消</button>
        <button class="btn-primary" data-act="new">新建分类</button>
      </div>`, (m) => {
      m.querySelector('#pickList').addEventListener('click', (e) => {
        const row = e.target.closest('[data-pick]');
        if (!row) return;
        const n = addToCategory(row.dataset.pick, paths);
        closeModal();
        toast(n ? `已加入 ${n} 项` : '这些素材已在该分类中');
      });
      m.querySelector('[data-act="new"]').addEventListener('click', () => { closeModal(); modalNewCategory(paths); });
      m.querySelector('[data-act="cancel"]').addEventListener('click', closeModal);
    });
  }

  function modalConfirm(title, sub, okText, danger, onOk) {
    openModal(`
      <h3>${escapeHtml(title)}</h3>
      <div class="sub">${escapeHtml(sub)}</div>
      <div class="modal-foot">
        <button class="btn-ghost" data-act="cancel">取消</button>
        <button class="${danger ? 'btn-primary' : 'btn-primary'}" data-act="ok" ${danger ? 'style="background:#ff3b30"' : ''}>${escapeHtml(okText)}</button>
      </div>`, (m) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', closeModal);
      m.querySelector('[data-act="ok"]').addEventListener('click', () => { closeModal(); onOk(); });
    });
  }

  function modalRename(cat) {
    openModal(`
      <h3>重命名分类</h3>
      <input type="text" id="catName" maxlength="24" value="${escapeHtml(cat.name)}">
      <div class="modal-foot">
        <button class="btn-ghost" data-act="cancel">取消</button>
        <button class="btn-primary" data-act="ok">保存</button>
      </div>`, (m) => {
      const input = m.querySelector('#catName');
      input.focus(); input.select();
      const ok = () => {
        const v = input.value.trim();
        if (!v) { toast('名称不能为空'); return; }
        cat.name = v;
        persist(); renderSidebar(); renderChrome();
        closeModal();
        toast('已重命名');
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      m.querySelector('[data-act="ok"]').addEventListener('click', ok);
      m.querySelector('[data-act="cancel"]').addEventListener('click', closeModal);
    });
  }

  async function modalSettings() {
    let bytes = await api.cacheSize();
    const info = await api.appInfo();
    const vis = Object.assign({ fav: true, hist: true, auto: true, ai: true, dupe: true, cat: true, bin: true }, lib.settings.visible || {});

    const swRow = (id, on, title, desc) =>
      '<label class="set-line"><span class="sl-t"><b>' + title + '</b><i>' + desc + '</i></span>'
      + '<input type="checkbox" class="sw-input" id="' + id + '"' + (on ? ' checked' : '') + '>'
      + '<span class="sw"></span></label>';
    const selRow = (id, val, title, desc, opts) =>
      '<div class="set-line"><span class="sl-t"><b>' + title + '</b><i>' + desc + '</i></span>'
      + '<select class="set-sel" id="' + id + '">' + opts.map(([v, l]) => '<option value="' + v + '"' + (String(val) === String(v) ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>';
    const actRow = (title, desc, label, act, primary) =>
      '<div class="set-line"><span class="sl-t"><b>' + title + '</b><i>' + desc + '</i></span>'
      + '<button class="set-action' + (primary ? ' primary' : '') + '" data-act="' + act + '">' + label + '</button></div>';
    const infoRow = (title, desc, value) =>
      '<div class="set-line"><span class="sl-t"><b>' + title + '</b><i>' + desc + '</i></span><span class="sl-v">' + value + '</span></div>';

    const tabs = [
      ['general', '通用设置'], ['sidebar', '侧栏显示'], ['data', '数据与缓存'],
      ['paths', '素材路径'], ['categories', '相册分类'], ['preview', '预览设置'],
      ['ai', '自动识别'], ['export', '导出设置'], ['keys', '快捷键'], ['about', '关于']
    ];

    openModal(
      '<div class="set-shell">'
      + '<aside class="set-nav">'
      + '<div class="set-nav-t">设置</div>'
      + '<div class="set-nav-list">' + tabs.map(([id, label], i) => '<button class="set-tab' + (i === 0 ? ' on' : '') + '" data-tab="' + id + '">' + label + '</button>').join('') + '</div>'
      + '</aside>'
      + '<section class="set-pane">'
      + '<header class="set-head"><button class="set-close" data-act="closeSettings" title="关闭">' + ICON.x + '</button></header>'
      + '<div class="set-body" id="setBody"></div>'
      + '</section>'
      + '</div>', (m) => {
        m.classList.add('set-modal');
        const body = m.querySelector('#setBody');
        let tab = 'general';

        const applySwitch = (id, fn) => {
          const el = m.querySelector('#' + id);
          if (el) el.addEventListener('change', () => fn(el.checked));
        };
        let pendingRescan = false;
        const rescanLater = () => {
          pendingRescan = true;
          toast('已保存，关闭设置后按新设置重新扫描');
        };
        const copyText = (txt, okMsg) => {
          const ta = document.createElement('textarea');
          ta.value = txt || '';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); toast(okMsg || '已复制'); } catch { toast('复制失败'); }
          ta.remove();
        };

        function paint() {
          Array.from(m.querySelectorAll('.set-tab')).forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
          body.style.animation = 'none';
          void body.offsetWidth;
          body.style.animation = 'setFade .22s cubic-bezier(.2,.8,.2,1) both';

          if (tab === 'general') {
            body.innerHTML =
              swRow('optNight', !!lib.settings.night, '夜间模式', '开启后软件切换为深色显示，晚上更不刺眼')
              + swRow('optHidden', !!lib.settings.showHidden, '显示隐藏文件', '关闭时，扫描和本地路径列表都会隐藏隐藏文件与文件夹')
              + swRow('optAudio', !!lib.settings.audio, '识别音频格式', '扫描时收录音频文件，并在左侧显示音频分类')
              + swRow('optDoc', !!lib.settings.doc, '识别文档格式', '扫描时收录文本、Office、PDF 等文档素材')
              + swRow('optMoveConfirm', !lib.settings.skipMoveConfirm, '移动素材前先确认', '移动图片、视频前弹出确认弹窗，避免误操作');
            applySwitch('optNight', (on) => { lib.settings.night = on; applyNight(); persist(); });
            applySwitch('optHidden', (on) => { lib.settings.showHidden = on; persist(); renderSidebar(); refreshHiddenPaths().then(renderSidebar); rescanLater(); });
            applySwitch('optAudio', (on) => { lib.settings.audio = on; persist(); syncFilterButtons(); renderSidebar(); rescanLater(); });
            applySwitch('optDoc', (on) => { lib.settings.doc = on; persist(); syncFilterButtons(); renderSidebar(); rescanLater(); });
            applySwitch('optMoveConfirm', (on) => { lib.settings.skipMoveConfirm = !on; persist(); });
            return;
          }

          if (tab === 'sidebar') {
            const rows = [
              ['svFav', 'fav', '收藏路径', '显示左侧收藏的常用文件夹'],
              ['svHist', 'hist', '历史记录', '显示曾经打开过的文件夹，可置顶或删除'],
              ['svAuto', 'auto', '自动分类', '按拍摄时间自动生成年、月、日分组'],
              ['svAi', 'ai', '智能标签', '显示人物、场景、截图、文档和 RAW 识别结果'],
              ['svDup', 'dupe', '相似素材', '把所有相似组汇总成一个入口'],
              ['svCat', 'cat', '自定义分类', '显示手动创建的分类相簿'],
              ['svBin', 'bin', '回收站', '显示回收站入口和数量']
            ];
            body.innerHTML = rows.map(([id, key, label, desc]) => swRow(id, vis[key] !== false, label, desc)).join('')
              + actRow('侧栏宽度', '拖动侧栏与内容区之间的细线即可调整，松手后自动吸附', '恢复默认', 'resetSide', false);
            rows.forEach(([id, key]) => applySwitch(id, (on) => {
              lib.settings.visible = Object.assign({}, lib.settings.visible || {});
              lib.settings.visible[key] = on;
              vis[key] = on;
              persist(); renderSidebar();
            }));
            body.querySelector('[data-act="resetSide"]').addEventListener('click', () => {
              lib.settings.sideW = 244; lib.settings.insW = 320; persist();
              document.documentElement.style.setProperty('--side-w', '244px');
              document.documentElement.style.setProperty('--ins-w', '320px');
              layoutGrid(); renderWindow(true); toast('侧栏宽度已恢复');
            });
            return;
          }

          if (tab === 'data') {
            body.innerHTML =
              infoRow('缩略图缓存', '用于加速浏览的缩略图、视频转码和实况缓存', fmtSize(bytes))
              + infoRow('数据目录', '书签、标签、分类、回收站和全部缓存都保存在本机', '<span class="sl-path">' + escapeHtml(info.dataDir || '') + '</span>')
              + actRow('打开数据目录', '在资源管理器中查看 library.json、回收站和缓存', '打开', 'openData', false)
              + actRow('清理缩略图缓存', '只删除可再生成的缩略图，不会影响原始照片和视频', '清理缓存', 'clearCache', true)
              + infoRow('版本', '当前运行的智能相册版本', escapeHtml(info.version || '1.0.0'));
            body.querySelector('[data-act="openData"]').addEventListener('click', () => api.openFolder(info.dataDir));
            body.querySelector('[data-act="clearCache"]').addEventListener('click', async () => {
              modalConfirm('清理缩略图缓存', '缩略图会重新生成，原始文件不会被删除。', '清理', true, async () => {
                const r = await api.cacheClear();
                bytes = await api.cacheSize();
                toast('已清理 ' + ((r && r.removed) || 0) + ' 个缓存文件');
                paint();
              });
            });
            return;
          }

          if (tab === 'paths') {
            const hist = (lib.history || []).filter((h) => h && h.path && pathAllowed(h.path));
            body.innerHTML = (hist.length
              ? hist.map((h, i) => '<div class="set-line path-row"><span class="sl-t"><b>' + escapeHtml(baseName(h.path)) + '</b><i>' + escapeHtml(h.path) + '</i></span>'
                + '<button class="set-action" data-open-path="' + escapeHtml(h.path) + '">打开</button>'
                + '<button class="set-action ghost" data-del-path="' + escapeHtml(h.path) + '">移除</button></div>').join('')
              : '<div class="set-empty">还没有打开过文件夹，点右上角「打开文件夹」开始。</div>')
              + actRow('打开新文件夹', '选择后会加入历史记录，下次可直接从这里进入', '选择文件夹', 'pickPath', true);
            body.querySelectorAll('[data-open-path]').forEach((b) => b.addEventListener('click', () => {
              closeModal();
              openFolder(b.dataset.openPath);
            }));
            body.querySelectorAll('[data-del-path]').forEach((b) => b.addEventListener('click', () => {
              lib.history = lib.history.filter((h) => h.path !== b.dataset.delPath);
              persist(); renderSidebar(); paint();
            }));
            body.querySelector('[data-act="pickPath"]').addEventListener('click', async () => {
              const p = await api.pickFolder();
              if (!p) return;
              closeModal();
              openFolder(p);
            });
            return;
          }

          if (tab === 'categories') {
            const cats = lib.categories || [];
            body.innerHTML = (cats.length
              ? cats.map((c) => '<div class="set-line"><span class="sl-t"><b>' + escapeHtml(c.name) + '</b><i>' + (c.items || []).length + ' 项素材</i></span>'
                + '<button class="set-action" data-ren-cat="' + c.id + '">重命名</button>'
                + '<button class="set-action ghost" data-del-cat="' + c.id + '">删除</button></div>').join('')
              : '<div class="set-empty">还没有自定义分类。新建后可以把素材加入分类相簿，不会移动原文件。</div>')
              + actRow('新建分类', '分类只是虚拟标签，不会复制或移动本地文件', '新建分类', 'newCat', true);
            body.querySelectorAll('[data-ren-cat]').forEach((b) => b.addEventListener('click', () => {
              const cat = lib.categories.find((x) => x.id === b.dataset.renCat);
              if (cat) { closeModal(); modalRename(cat); }
            }));
            body.querySelectorAll('[data-del-cat]').forEach((b) => b.addEventListener('click', () => {
              const cat = lib.categories.find((x) => x.id === b.dataset.delCat);
              if (!cat) return;
              modalConfirm('删除分类', '「' + cat.name + '」会被删除，原文件不受影响。', '删除', true, () => {
                lib.categories = lib.categories.filter((x) => x.id !== cat.id);
                if (S.mode === 'cat' && S.payload === cat.id) { S.mode = 'all'; S.payload = null; }
                persist(); renderSidebar(); renderList(true); closeModal();
                toast('分类已删除');
              });
            }));
            body.querySelector('[data-act="newCat"]').addEventListener('click', () => { closeModal(); modalNewCategory(null); });
            return;
          }

          if (tab === 'preview') {
            body.innerHTML =
              swRow('optLivePlay', lib.settings.livePlay !== false, '打开实况时自动播放', '关闭后先显示静态封面，点右下角按钮再播放一次')
              + swRow('optVideoAuto', lib.settings.videoAutoplay !== false, '打开视频时自动播放', '关闭后需要点视频自带的播放按钮')
              + selRow('optSlideSec', Number(lib.settings.slideSec) || 4, '幻灯片停留时长', '幻灯片每张停留的秒数，视频会至少停留到能看清开头', [[3, '3 秒'], [4, '4 秒'], [5, '5 秒'], [6, '6 秒'], [8, '8 秒'], [10, '10 秒']])
              + infoRow('原画质播放', '图片、视频和实况始终读取原文件；只有 HEVC 等无法解码的格式才会在后台转码', '开启');
            applySwitch('optLivePlay', (on) => { lib.settings.livePlay = on; persist(); });
            applySwitch('optVideoAuto', (on) => { lib.settings.videoAutoplay = on; persist(); });
            body.querySelector('#optSlideSec').addEventListener('change', (e) => { lib.settings.slideSec = Number(e.target.value) || 4; persist(); if (S.slideshow) scheduleSlide(); });
            return;
          }

          if (tab === 'ai') {
            body.innerHTML =
              swRow('optAutoAI', lib.settings.autoAI !== false, '扫描后自动识别', '每次扫描完成后在后台识别人物、场景和素材类型，不打断浏览')
              + swRow('optAiShot', lib.settings.aiScreenshot !== false, '识别截图', '识别屏幕截图、聊天截图等，并在左侧「截图」里汇总')
              + swRow('optAiDoc', lib.settings.aiDoc !== false, '识别拍摄文档', '识别白底文档、扫描件、纸质文件照片，并在左侧「拍摄文档」里汇总')
              + swRow('optAiRaw', lib.settings.aiRaw !== false, '识别 RAW 原片', '识别 CR2、NEF、ARW、DNG 等相机原片，并在左侧「RAW 原片」里汇总')
              + actRow('重新识别', '对当前文件夹重新跑一次本地识别并刷新相似分组', '开始识别', 'runAI', true);
            applySwitch('optAutoAI', (on) => { lib.settings.autoAI = on; persist(); if (on && S.items.length) runAI(true); });
            applySwitch('optAiShot', (on) => { lib.settings.aiScreenshot = on; persist(); renderSidebar(); if (S.mode === 'ai' && S.payload && S.payload.k === 'type') renderList(true); });
            applySwitch('optAiDoc', (on) => { lib.settings.aiDoc = on; persist(); renderSidebar(); if (S.mode === 'ai' && S.payload && S.payload.k === 'type') renderList(true); });
            applySwitch('optAiRaw', (on) => { lib.settings.aiRaw = on; persist(); renderSidebar(); if (S.mode === 'ai' && S.payload && S.payload.k === 'type') renderList(true); });
            body.querySelector('[data-act="runAI"]').addEventListener('click', () => { closeModal(); runAI(); });
            return;
          }

          if (tab === 'export') {
            body.innerHTML =
              infoRow('导出位置', '导出时默认写到素材所在的原文件夹，不额外复制一份隐藏数据', '原文件夹')
              + infoRow('导出画质', '始终复制原文件，不重新编码、不压缩画质', '原画质')
              + infoRow('文件信息', '时间、地点和备注会随同名 XMP 侧车一起保留', '保留')
              + actRow('在文件夹中查看', '打开当前素材所在目录，直接复制或分享原文件', '打开当前目录', 'openCurrent', false);
            body.querySelector('[data-act="openCurrent"]').addEventListener('click', () => {
              if (S.root) api.openFolder(S.root); else toast('还没有打开文件夹');
            });
            return;
          }

          if (tab === 'keys') {
            body.innerHTML =
              infoRow('← / →', '在全屏预览和幻灯片里切换上一张、下一张', '切换')
              + infoRow('Esc', '先退出铺满屏幕，再按一次关闭预览', '退出')
              + infoRow('双击画面', '在窗口内预览和铺满屏幕之间切换', '全屏')
              + infoRow('双击时间 / 地点 / 备注', '打开编辑框，修改后同步到本地文件', '编辑')
              + infoRow('Ctrl + 滚轮', '在素材网格上缩放缩略图大小', '缩放')
              + infoRow('拖动顶部空白', '移动整个应用窗口', '拖动');
            return;
          }

          body.innerHTML =
            infoRow('智能相册', '纯本地运行的图片、视频、实况整理工具', escapeHtml(info.version || '1.0.0'))
            + infoRow('数据目录', '所有书签、标签、分类、回收站和缓存都在本机', '<span class="sl-path">' + escapeHtml(info.dataDir || '') + '</span>')
            + infoRow('隐私', '人脸、场景、截图、文档和 RAW 识别全部在本机完成，不上传任何素材', '本地')
            + actRow('打开数据目录', '备份或迁移时复制整个 data 文件夹即可', '打开', 'aboutOpen', false)
            + actRow('复制数据目录', '把路径复制到剪贴板，方便备份', '复制路径', 'aboutCopy', false);
          body.querySelector('[data-act="aboutOpen"]').addEventListener('click', () => api.openFolder(info.dataDir));
          body.querySelector('[data-act="aboutCopy"]').addEventListener('click', () => copyText(info.dataDir, '已复制数据目录'));
        }

        m.querySelectorAll('.set-tab').forEach((b) => b.addEventListener('click', () => {
          tab = b.dataset.tab;
          paint();
        }));
        m.querySelector('[data-act="closeSettings"]').addEventListener('click', () => {
          closeModal();
          if (pendingRescan && S.root) setTimeout(() => openFolder(S.root), 40);
        });
        paint();
      });
  }

  function applyNight() {
    const night = !!lib.settings.night;
    document.body.classList.toggle('night', night);
    try { api.setTitleBarTheme && api.setTitleBarTheme(night); } catch { /* ignore */ }
  }

  /* ───────────────────────── 交互事件 ───────────────────────── */

  /* 顶部：文件夹和压缩包统一走一个来源选择器 */
  $('#btnOpen').addEventListener('click', () => openSourcePicker());
  $('#btnEmptyOpen').addEventListener('click', () => openSourcePicker());
  $('#btnRefresh').addEventListener('click', () => {
    if (!S.root) { toast('请先打开一个文件夹'); return; }
    openFolder(S.root);
  });
  $('#pathChip').addEventListener('click', async () => {
    if (!S.root) {
      openSourcePicker();
    } else {
      api.openFolder(S.root);
    }
  });
  /* 目录面包屑：点层级进入，点「合并显示 / 按目录显示」切换 */
  crumb.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="backmap"]')) {
      S.mode = 'all'; S.payload = null; S.selected.clear(); S.active = null;
      showInspector(null); renderSidebar(); renderList(true); openMap();
      return;
    }
    const dirBtn = e.target.closest('[data-dir]');
    if (dirBtn) { enterDir(dirBtn.dataset.dir || ''); return; }
    const flatBtn = e.target.closest('[data-flat]');
    if (flatBtn) {
      S.flat = flatBtn.dataset.flat === '1';
      S.dir = '';
      S.selected.clear();
      S.active = null;
      showInspector(null);
      renderList(true);
    }
  });

  $('#segFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    S.filter = b.dataset.filter;
    $$('#segFilter button').forEach((x) => x.classList.toggle('on', x === b));
    renderList(true);
  });
  /* 搜索历史：输入停顿或回车时记账，可单条删除或清空 */
  const searchPop = $('#searchPop');
  let searchHistTimer = 0;
  function saveSearch(q) {
    const v = String(q || '').trim();
    if (v.length < 1) return;
    lib.searchHistory = [v, ...lib.searchHistory.filter((x) => x !== v)].slice(0, 14);
    persist();
  }
  function paintSearchPop(show) {
    if (!searchPop) return;
    const q = searchInput.value.trim().toLowerCase();
    const list = lib.searchHistory.filter((x) => !q || x.toLowerCase().includes(q));
    if (!show || !list.length) { searchPop.hidden = true; return; }
    searchPop.innerHTML = '<div class="sp-head"><span>搜索历史</span><button data-sh-clear>清除</button></div>'
      + list.map((x) => '<div class="sp-row" data-sh-q="' + escapeHtml(x) + '">'
        + '<span class="sp-ico">' + ICON.clock + '</span>'
        + '<span class="sp-t">' + escapeHtml(x) + '</span>'
        + '<button data-sh-del="' + escapeHtml(x) + '" title="删除这条历史">' + ICON.x + '</button></div>').join('');
    searchPop.hidden = false;
  }
  searchInput.addEventListener('input', () => {
    S.query = searchInput.value;
    renderList(true);
    paintSearchPop(true);
    clearTimeout(searchHistTimer);
    searchHistTimer = setTimeout(() => saveSearch(S.query), 900);
  });
  searchInput.addEventListener('focus', () => paintSearchPop(true));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveSearch(S.query);
      paintSearchPop(true);
      searchInput.blur();
    } else if (e.key === 'Escape') {
      searchPop.hidden = true;
      searchInput.blur();
    }
  });
  searchPop.addEventListener('mousedown', (e) => e.preventDefault());
  searchPop.addEventListener('click', (e) => {
    const del = e.target.closest('[data-sh-del]');
    if (del) {
      lib.searchHistory = lib.searchHistory.filter((x) => x !== del.dataset.shDel);
      persist();
      paintSearchPop(true);
      return;
    }
    if (e.target.closest('[data-sh-clear]')) {
      lib.searchHistory = [];
      persist();
      paintSearchPop(false);
      return;
    }
    const row = e.target.closest('[data-sh-q]');
    if (row) {
      searchInput.value = row.dataset.shQ;
      S.query = row.dataset.shQ;
      searchPop.hidden = true;
      renderList(true);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap') && searchPop) searchPop.hidden = true;
  });

  $('#btnSelect').addEventListener('click', () => enterBatch(!S.batch));

  /* 幻灯片：从当前素材开始，铺满屏幕自动轮播 */
  $('#btnSlideshow').addEventListener('click', () => {
    const list = S.filtered.filter((x) => x && x.kind !== 'archive');
    if (!list.length) { toast('当前没有可播放的素材'); return; }
    const start = S.active && list.some((x) => x.path === S.active) ? S.active : list[0].path;
    openViewer(start, list, { slideshow: true });
    toggleViewerScreen(true);
    renderViewer();
  });

  $('#btnSettings').addEventListener('click', modalSettings);

  /* 缩放 */
  zoom.addEventListener('input', () => {
    applyCell(zoom.value);
    persist();
    renderGrid(true);
  });
  stageBody.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    applyCell(lib.settings.cell + (e.deltaY > 0 ? -12 : 12));
    persist();
    renderGrid(true);
  }, { passive: false });

  /* 左侧导航（事件委托） */
  /* 历史记录：长按 400ms 后可拖动排序 */
  let histPress = null;
  let suppressHistClick = false;

  const histItems = () => Array.from(sidebar.querySelectorAll('.row[data-row="hist"]'));

  sidebar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const row = e.target.closest('.row[data-row="hist"]');
    if (!row || e.target.closest('[data-act], [data-caret]')) return;
    const pointerId = e.pointerId;
    const startY = e.clientY;
    const order0 = lib.history.slice();
    const timer = setTimeout(() => {
      if (!histPress || histPress.row !== row) return;
      histPress.active = true;
      row.classList.add('drag-lift');
      document.body.classList.add('hist-dragging');
      try { row.setPointerCapture(pointerId); } catch { /* ignore */ }
    }, 400);
    histPress = { row, startY, pointerId, timer, active: false, moved: false, order0 };
  });

  document.addEventListener('pointermove', (e) => {
    const st = histPress;
    if (!st) return;
    const dy = e.clientY - st.startY;
    if (!st.active) {
      if (Math.abs(dy) > 8) { clearTimeout(st.timer); histPress = null; }
      return;
    }
    e.preventDefault();
    st.moved = true;
    const others = histItems().filter((r) => r !== st.row);
    let placed = false;
    for (const r of others) {
      const b = r.getBoundingClientRect();
      if (e.clientY < b.top + b.height / 2) {
        if (st.row.nextElementSibling !== r) r.parentNode.insertBefore(st.row, r);
        placed = true;
        break;
      }
    }
    if (!placed && others.length) {
      const last = others[others.length - 1];
      if (st.row.previousElementSibling !== last) last.parentNode.insertBefore(st.row, last.nextElementSibling);
    }
  });

  const endHistDrag = () => {
    const st = histPress;
    if (!st) return;
    clearTimeout(st.timer);
    histPress = null;
    if (!st.active) return;
    st.row.classList.remove('drag-lift');
    document.body.classList.remove('hist-dragging');
    if (!st.moved) return;
    suppressHistClick = true;
    const visual = histItems().map((r) => r.dataset.path);
    const map = new Map(st.order0.map((h) => [h.path.toLowerCase(), h]));
    const next = [];
    for (const p of visual) {
      const h = map.get(p.toLowerCase());
      if (h) { next.push(h); map.delete(p.toLowerCase()); }
    }
    for (const h of map.values()) next.push(h);
    lib.history = next;
    persist();
    renderSidebar();
  };

  document.addEventListener('pointerup', endHistDrag);
  document.addEventListener('pointercancel', endHistDrag);

  sidebar.addEventListener('click', async (e) => {
    if (suppressHistClick) { suppressHistClick = false; e.preventDefault(); e.stopPropagation(); return; }
    const actBtn = e.target.closest('[data-act]');
    const row = e.target.closest('.row');
    const caret = e.target.closest('[data-caret]');

    if (caret && caret.dataset.caret === 'dup') {
      e.stopPropagation();
      S.openDup = (S.openDup === false);
      renderSidebar();
      return;
    }

    if (caret && row) {
      e.stopPropagation();
      if (caret.dataset.caret === 'h') {
        const hp = caret.dataset.hpath || '';
        if (S.openHist.has(hp)) S.openHist.delete(hp); else S.openHist.add(hp);
        renderSidebar();
        return;
      }
      const y = Number(caret.dataset.y);
      if (caret.dataset.caret === 'y') {
        if (S.openYears.has(y)) S.openYears.delete(y); else S.openYears.add(y);
      } else {
        const key = `${y}-${caret.dataset.m}`;
        if (S.openMonths.has(key)) S.openMonths.delete(key); else S.openMonths.add(key);
      }
      renderSidebar();
      return;
    }

    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.dataset.act;
      const rowPath = actBtn.closest('.row') ? actBtn.closest('.row').dataset.path : '';
      const catId = actBtn.dataset.cat;

      if (act === 'newCat') { modalNewCategory(null); return; }
      if (act === 'openAI') { openAI(); return; }
      if (act === 'clearHist') {
        modalConfirm('清空历史记录', '仅清空记录列表，不会删除任何本地文件夹。', '清空', true, () => {
          lib.history = []; persist(); renderSidebar(); toast('历史记录已清空');
        });
        return;
      }
      if (act === 'fav') {
        if (!lib.favorites.some((f) => f.toLowerCase() === rowPath.toLowerCase())) lib.favorites.push(rowPath);
        persist(); renderSidebar(); toast('已收藏');
        return;
      }
      if (act === 'unfav') {
        lib.favorites = lib.favorites.filter((f) => f.toLowerCase() !== rowPath.toLowerCase());
        persist(); renderSidebar(); toast('已取消收藏');
        return;
      }
      if (act === 'pin' || act === 'unpin') {
        const h = lib.history.find((x) => x.path === rowPath);
        if (h) {
          lib.history = lib.history.filter((x) => x !== h);
          h.pinned = act === 'pin';
          const firstUnpinned = lib.history.findIndex((x) => !x.pinned);
          if (firstUnpinned < 0) lib.history.push(h);
          else lib.history.splice(firstUnpinned, 0, h);
          persist();
          renderSidebar();
          toast(h.pinned ? '已置顶' : '已取消置顶');
        }
        return;
      }
      if (act === 'removeHist') {
        lib.history = lib.history.filter((h) => h.path !== rowPath);
        persist(); renderSidebar();
        return;
      }
      if (act === 'renameCat') {
        const cat = lib.categories.find((c) => c.id === catId);
        if (cat) modalRename(cat);
        return;
      }
      if (act === 'delCat') {
        const cat = lib.categories.find((c) => c.id === catId);
        if (!cat) return;
        modalConfirm('删除分类', `「${cat.name}」将被删除，其中的本地文件不会受到影响。`, '删除分类', true, () => {
          lib.categories = lib.categories.filter((c) => c.id !== catId);
          if (S.mode === 'cat' && S.payload === catId) { S.mode = 'all'; S.payload = null; }
          persist(); renderSidebar(); renderList(true);
          toast('分类已删除');
        });
        return;
      }
      return;
    }

    if (!row) return;
    const kind = row.dataset.row;
    const p = row.dataset.path;

    /* 除了「相似素材 / 智能识别」自身，任何侧栏跳转都先退出相似素材层，
       否则会在相似页下面渲染另一个列表，看起来像点了没反应 */
    if (kind !== 'dupeAll' && kind !== 'ai' && kind !== 'dupe') closeAI();

    if (kind === 'bin') {
      openBin();
      return;
    }
    if (kind === 'hidden') {
      S.binMode = false;
      S.mode = 'hidden';
      S.payload = null;
      S.flat = true; S.dir = '';
      S.filter = 'all'; S.query = '';
      searchInput.value = '';
      S.selected.clear(); S.active = null;
      showInspector(null); renderSidebar(); renderList(true);
      return;
    }

    if (kind === 'dupeAll') {
      openDupAll();
      return;
    }

    if (kind === 'hdir') {
      openFolder(p);
      return;
    }

    if (kind === 'hist' || kind === 'fav') {
      if (S.invalid.get(p.toLowerCase())) {
        const np = await api.pickFolder();
        if (!np) return;
        if (kind === 'hist') {
          const h = lib.history.find((x) => x.path === p);
          if (h) h.path = np;
        } else {
          lib.favorites = lib.favorites.filter((f) => f !== p);
          lib.favorites.push(np);
        }
        persist(); renderSidebar();
        openFolder(np);
        return;
      }
      openFolder(p);
      return;
    }

    /* 从回收站跳去图片合集/视频合集/分类时，必须退出 bin 数据源，否则会一直用回收站列表 */
    if (S.binMode && kind !== 'bin') {
      S.binMode = false;
      S.binItems = [];
      S.binByPath.clear();
    }
    if (kind === 'year') {
      S.mode = 'date'; S.payload = { y: Number(row.dataset.y) };
    } else if (kind === 'month') {
      S.mode = 'date'; S.payload = { y: Number(row.dataset.y), m: Number(row.dataset.m) };
    } else if (kind === 'day') {
      S.mode = 'date'; S.payload = { y: Number(row.dataset.y), m: Number(row.dataset.m), d: Number(row.dataset.d) };
    } else if (kind === 'unknown') {
      S.mode = 'unknown'; S.payload = null;
    } else if (kind === 'type') {
      const label = row.querySelector('.row-label').textContent;
      const map = { '图片合集': 'image', '视频合集': 'video', '实况合集': 'live' };
      S.mode = 'type'; S.payload = map[label] || 'image';
    } else if (kind === 'cat') {
      S.mode = 'cat'; S.payload = row.dataset.cat;
    } else if (kind === 'ai') {
      S.mode = 'ai'; S.payload = { k: row.dataset.aiK, v: row.dataset.aiV };
    } else if (kind === 'dupe') {
      S.mode = 'dupe'; S.payload = row.dataset.cat;
    }
    S.selected.clear(); S.active = null;
    showInspector(null);
    renderSidebar();
    renderList(true);
  });

  function collectFiles(paths) {
    const files = [];
    const seen = new Set();
    for (const p of paths) {
      const it = S.byPath.get(p) || itemForPath(p);
      if (!it) continue;
      const add = (f) => { if (f && !seen.has(String(f).toLowerCase())) { seen.add(String(f).toLowerCase()); files.push(f); } };
      add(it.path);
      if (it.kind === 'live' && it.videoPath) add(it.videoPath);
    }
    return files;
  }

  /* 删除分组：实况图片+视频是一组；实况包目录整组 */
  function collectDeleteGroups(paths) {
    const groups = [];
    const seen = new Set();
    for (const p of paths) {
      const it = S.byPath.get(p) || itemForPath(p);
      if (!it || seen.has(it.path)) continue;
      seen.add(it.path);
      const files = [it.path];
      if (it.kind === 'live' && it.videoPath) files.push(it.videoPath);
      const g = { files, gid: 'g:' + String(it.kind) + ':' + it.path.toLowerCase(), gname: it.name, kind: it.kind };
      if (it.kind === 'live' && it.packDir && S.root) { g.root = S.root; g.dir = it.packDir; }
      groups.push(g);
      if (it.kind === 'live' && it.videoPath) seen.add(it.videoPath);
    }
    return groups;
  }

  /* 移动分组：实况包目录整体移动；普通素材仍按文件移动 */
  function collectMovePacks(paths) {
    const out = [];
    for (const p of paths) {
      const it = S.byPath.get(p) || itemForPath(p);
      if (it && it.kind === 'live' && it.packDir && S.root) {
        if (!out.some((x) => x.dir === it.packDir)) out.push({ root: S.root, dir: it.packDir });
      }
    }
    return out;
  }

  function moveConfirm(paths, dest, onOk) {
    if (lib.settings.skipMoveConfirm) { onOk(); return; }
    const n = paths.length;
    openModal('<h3>移动' + n + ' 个素材</h3>'
      + '<div class="sub">确认把这 ' + n + ' 个素材移动到本地目录「' + escapeHtml(baseName(dest)) + '」？原始文件会被搬走，画质不变。</div>'
      + '<label class="set-row check"><input type="checkbox" id="mNoAsk"><span>以后不再提醒</span></label>'
      + '<div class="modal-foot"><button class="btn-ghost" data-act="cancel">取消</button><button class="btn-primary" data-act="ok">确认移动</button></div>', (m) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', closeModal);
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        if (m.querySelector('#mNoAsk').checked) { lib.settings.skipMoveConfirm = true; persist(); }
        closeModal();
        await onOk();
      });
    });
  }

  async function doMove(paths, dest) {
    const files = collectFiles(paths);
    const packs = collectMovePacks(paths);
    const r = await api.move(files, dest, { packs, root: S.root || '' });
    if (!r || !r.ok) { toast('移动失败，目标可能不可写'); return; }
    toast('已移动 ' + r.count + ' 个文件' + (r.packs ? '（含 ' + r.packs + ' 个实况包）' : ''));
    S.selected.clear(); S.active = null;
    if (S.root) openFolder(S.root);
  }

  /* 拖素材到历史记录（或它的子目录）：真的把这个文件移动到那个文件夹 */
  function bindMoveTarget(row) {
    if (!row || row.__dropBound) return;
    row.__dropBound = true;
    row.addEventListener('dragover', (e) => {
      if (!Array.from(e.dataTransfer.types).includes('application/x-album-paths')) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.add('drop-active');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-active'));
    row.addEventListener('drop', (e) => {
      const raw = e.dataTransfer.getData('application/x-album-paths');
      row.classList.remove('drop-active');
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      let paths = [];
      try { paths = JSON.parse(raw); } catch { paths = []; }
      if (!paths.length) return;
      const dest = row.dataset.path;
      if (!dest) return;
      moveConfirm(paths, dest, () => doMove(paths, dest));
    });
  }

  /* 拖放素材到分类 */
  function syncDragTargets() {
    $$('.row[data-row="hist"], .row[data-row="hdir"], .row[data-row="fav"]', sidebar).forEach(bindMoveTarget);
    $$('.row[data-row="cat"]', sidebar).forEach((row) => {
      row.addEventListener('dragover', (e) => {
        if (!Array.from(e.dataTransfer.types).includes('application/x-album-paths')) return;
        e.preventDefault();
        row.classList.add('drop-active');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-active'));
      row.addEventListener('drop', (e) => {
        const raw = e.dataTransfer.getData('application/x-album-paths');
        row.classList.remove('drop-active');
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        let paths = [];
        try { paths = JSON.parse(raw); } catch { paths = []; }
        if (!paths.length) return;
        const n = addToCategory(row.dataset.cat, paths);
        toast(n ? `已移入分类 ${n} 项` : '已在该分类中');
      });
    });
  }

  /* 素材区点击 / 双击 / 拖拽 */
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    if (card.dataset.dir !== undefined) { enterDir(card.dataset.dir || ''); return; }
    const p = card.dataset.path;
    const multi = e.ctrlKey || e.metaKey || S.batch || S.binMode;
    if (e.shiftKey && S.active) {
      const list = S.filtered;
      const a = list.findIndex((i) => i.path === S.active);
      const b = list.findIndex((i) => i.path === p);
      if (a >= 0 && b >= 0) {
        S.selected.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.selected.add(list[i].path);
        S.active = p;
        syncCardStates(); renderChrome(); renderBatchBar();
        showInspector(lookupItem(p));
        if (!S.batch) { S.batch = true; $('#btnSelect').textContent = '完成'; renderBatchBar(); }
        return;
      }
    }
    setActive(p, { multi, reveal: false });
  });

  /* 双击打开全屏：靠 pointerdown 判定第二下（单击会重建卡片 DOM，原生 dblclick 不可靠）
     注意：单击只做「选中 + 右侧详情」，绝不能再被误判成双击 */
  let lastTap = { p: '', t: 0 };
  let suppressClickUntil = 0;
  grid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const card = e.target.closest('.card');
    if (!card) return;
    if (card.dataset.dir !== undefined) return;
    if (S.batch) return;
    const p = card.dataset.path;
    const now = Date.now();
    if (lastTap.p === p && now - lastTap.t < 420) {
      lastTap = { p: '', t: 0 };
      suppressClickUntil = now + 600;
      e.preventDefault();
      e.stopPropagation();
      const hit = lookupItem(p);
      if (hit && hit.kind === 'archive') openFolder(p);
      else openViewer(p);
      return;
    }
    lastTap = { p, t: now };
  }, true);

  /* 双击的第二下会补一个 click，这里吞掉，避免又跑一次选中 */
  grid.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  grid.addEventListener('dblclick', (e) => {
    if (Date.now() < suppressClickUntil) return;
    const card = e.target.closest('.card');
    if (!card || card.dataset.dir !== undefined) return;
    suppressClickUntil = Date.now() + 600;
    const hit = lookupItem(card.dataset.path);
    if (hit && hit.kind === 'archive') openFolder(card.dataset.path);
    else openViewer(card.dataset.path);
  });

  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card || card.dataset.dir !== undefined) return;
    const p = card.dataset.path;
    const paths = S.selected.has(p) && S.selected.size > 1 ? Array.from(S.selected) : [p];
    e.dataTransfer.setData('application/x-album-paths', JSON.stringify(paths));
    e.dataTransfer.setData('text/plain', p);
    e.dataTransfer.effectAllowed = 'copyLink';
    card.classList.add('dragging');
  });
  grid.addEventListener('dragend', (e) => {
    const card = e.target.closest('.card');
    if (card) card.classList.remove('dragging');
  });

  /* 滚动时只换可视区域的卡片 */
  if (sentinel) sentinel.hidden = true;
  stageBody.addEventListener('scroll', onStageScroll, { passive: true });
  window.addEventListener('resize', () => {
    layoutGrid();
    renderWindow(true);
  });

  /* 外部文件夹拖入 */
  function isFileDrag(e) {
    return Array.from(e.dataTransfer.types || []).includes('Files');
  }
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dropHint.classList.add('show');
  });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    if (e.relatedTarget === null) dropHint.classList.remove('show');
  });
  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dropHint.classList.remove('show');
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    const p = api.getPathForFile(files[0]);
    if (p) openFolder(p);
  });

  /* 右侧详情面板操作 */
  inspector.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    const rm = e.target.closest('[data-rmcat]');
    const add = e.target.closest('[data-addcat]');
    const maybeCat = e.target.closest('.chip[data-addcat]') || e.target.closest('.chip-btn');

    if (rm) {
      const p = S.active;
      if (p) removeFromCategory(rm.dataset.rmcat, p);
      return;
    }
    if (add || maybeCat) {
      if (!S.active) return;
      modalPickCategory([S.active]);
      return;
    }
    if (!btn) return;
    const act = btn.dataset.act;
    if (!S.active) return;
    const it = lookupItem(S.active);
    if (act === 'reveal') api.reveal(it.path);
    if (act === 'open') api.openExternal(it.path);
    if (act === 'amap') {
      metaOf(it).then((m) => {
        if (m && m.gps) api.openUrl(amapUrl(m.gps, m.place || baseName(it.path)));
        else toast('这张没有拍摄地点');
      });
    }
    if (act === 'bigmap') { if (S.items.length) openMap(); else toast('还没有素材'); }
    if (act === 'arcOpen') openFolder(it.path);
    if (act === 'viewer') openViewer(it.path);
    if (act === 'copy') {
      const tmp = el('textarea');
      tmp.value = it.path;
      document.body.appendChild(tmp);
      tmp.select();
      try { document.execCommand('copy'); toast('路径已复制'); } catch { toast('复制失败'); }
      tmp.remove();
    }
  });

  let ctxEl = null;
  function hideCtx() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }

  async function copyFilesToClip(paths) {
    const files = collectFiles(paths);
    if (!files.length) return;
    S.clipPaths = files;
    try { await api.clipboardSetFiles(files); } catch { /* ignore */ }
    toast('已复制文件，可右键粘贴到任意素材文件夹');
  }

  async function pasteIntoRoot() {
    if (!S.root) { toast('先打开一个文件夹'); return; }
    let src = (S.clipPaths || []).filter(Boolean);
    if (!src.length) {
      try { src = await api.clipboardFiles(); } catch { src = []; }
    }
    if (!src.length) { toast('剪贴板里没有可粘贴的图片或视频'); return; }
    const r = await api.copyFiles(src, S.root);
    toast(r && r.ok ? '已粘贴 ' + r.count + ' 个文件' : '粘贴失败，目标可能不可写');
    if (r && r.ok) openFolder(S.root);
  }

  function renameQuick(it) {
    if (!it) return;
    if (it.virtual || it.isBin) { toast('压缩包或回收站里的素材暂不支持改名'); return; }
    openModal('<div style="padding:18px 20px 16px"><div class="set-lab" style="margin-bottom:8px">重命名文件</div>'
      + '<input class="set-inp" id="rqName" maxlength="200" value="' + escapeHtml(it.name) + '" />'
      + '<div class="modal-foot" style="padding:16px 0 0"><button class="btn-ghost" data-act="rqCancel">取消</button><button class="btn-primary" data-act="rqOk">保存</button></div></div>',
      (m) => {
        const input = m.querySelector('#rqName');
        input.focus(); input.select();
        m.querySelector('[data-act="rqCancel"]').addEventListener('click', closeModal);
        const ok = async () => {
          const name = input.value.trim();
          closeModal();
          await renameInline(it, name);
        };
        m.querySelector('[data-act="rqOk"]').addEventListener('click', ok);
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ok(); } });
      });
  }

  function showCtx(x, y, it) {
    hideCtx();
    const menu = el('div', 'ctx-menu');
    const acts = [];
    const add = (label, fn, danger) => acts.push({ label, fn, danger });
    if (it) {
      add('全屏查看', () => openViewer(it.path));
      add('复制', () => copyFilesToClip([it.path]));
      add('复制路径', () => {
        const tmp = el('textarea'); tmp.value = it.path; document.body.appendChild(tmp); tmp.select();
        try { document.execCommand('copy'); toast('路径已复制'); } catch { toast('复制失败'); }
        tmp.remove();
      });
      add('粘贴到此文件夹', pasteIntoRoot);
      add('重命名', () => renameQuick(it));
      if (hiddenHas(new Set(lib.manualHidden || []), it)) {
        add('取消隐藏', () => {
          lib.manualHidden = (lib.manualHidden || []).filter((p) => !hiddenEntryMatches(p, it.path));
          persist(); renderSidebar(); renderList(true); toast('已取消隐藏');
        });
      } else {
        add('隐藏此文件', () => {
          lib.manualHidden = (lib.manualHidden || []).filter((p) => !hiddenEntryMatches(p, it.path));
          if (!lib.manualHidden.includes(it.path)) lib.manualHidden.push(it.path);
          persist(); renderSidebar(); renderList(true); toast('已隐藏，可在左侧「已隐藏素材」找回');
        });
      }
      add('在文件夹中显示', () => api.reveal(it.path));
      add('删除', () => {
        modalConfirm('删除素材', '文件会先放进回收站，之后可还原。', '删除', true, async () => {
          const r = await api.del({ paths: collectFiles([it.path]), groups: collectDeleteGroups([it.path]) });
          if (!r || !r.ok) { toast('删除失败，文件可能已被占用'); return; }
          toast('已移入回收站');
          lib.manualHidden = (lib.manualHidden || []).filter((p) => !collectFiles([it.path]).includes(p));
          persist(); renderSidebar();
          S.selected.clear(); S.active = null;
          if (S.root) openFolder(S.root);
        });
      }, true);
    } else {
      add('粘贴到此文件夹', pasteIntoRoot);
    }
    acts.forEach((a, idx) => {
      if (idx === 5) menu.appendChild(el('div', 'sep'));
      const b = el('button', a.danger ? 'danger' : '', a.label);
      b.addEventListener('click', () => { hideCtx(); a.fn(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    ctxEl = menu;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(x, innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(y, innerHeight - h - 8) + 'px';
  }
  document.addEventListener('click', hideCtx);
  document.addEventListener('scroll', hideCtx, true);
  grid.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.card');
    e.preventDefault(); e.stopPropagation();
    if (item && item.dataset.path) {
      const it = lookupItem(item.dataset.path);
      showCtx(e.clientX, e.clientY, it);
    } else if (S.root) {
      showCtx(e.clientX, e.clientY, null);
    }
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtx(); });

  /* 批量条 */
  batchbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const paths = Array.from(S.selected);
    if (act === 'exitBin') { closeBin(); return; }
    if (act === 'rmCat') {
      const catId = S.payload;
      if (!catId) return;
      let n = 0;
      for (const p of paths) { if (removeFromCategory(catId, p)) n += 1; }
      S.selected.clear();
      renderList(true);
      showInspector(null);
      toast('已从分类移出 ' + n + ' 项（本地文件仍保留）');
      return;
    }
    if (act === 'binRestore') {
      const ids = paths.flatMap((p) => {
        const x = S.binByPath.get(p);
        return x ? (x.binIds || [x.binId]) : [];
      });
      if (!ids.length) { toast('请先选择要还原的素材'); return; }
      api.recycleRestore(ids).then(async (r) => {
        if (!r || !r.ok) { toast('还原失败，原位置可能已不存在'); return; }
        toast('已还原 ' + r.count + ' 个文件');
        refreshBin(false);
        await openBin();
      });
      return;
    }
    if (act === 'binClear') {
      modalConfirm('清空回收站', '回收站里的文件会被永久删除，无法再还原。', '清空', true, async () => {
        await api.recycleClear();
        refreshBin(false);
        toast('回收站已清空');
        await openBin();
      });
      return;
    }
    if (act === 'hide') {
      if (!paths.length) { toast('请先选择素材'); return; }
      if (S.mode === 'hidden') {
        lib.manualHidden = (lib.manualHidden || []).filter((p) => !paths.some((t) => hiddenEntryMatches(p, t)));
        toast('已取消隐藏 ' + paths.length + ' 项');
      } else {
        for (const p of paths) {
          lib.manualHidden = (lib.manualHidden || []).filter((x) => !hiddenEntryMatches(x, p));
          if (!lib.manualHidden.includes(p)) lib.manualHidden.push(p);
        }
        toast('已隐藏 ' + paths.length + ' 项，可在左侧「已隐藏素材」找回');
      }
      S.selected.clear(); S.active = null;
      persist(); renderSidebar(); renderList(true); showInspector(null); renderBatchBar();
      return;
    }
    if (act === 'cat') {
      if (!paths.length) { toast('请先选择素材'); return; }
      modalPickCategory(paths);
    }
    if (act === 'move') {
      if (!paths.length) { toast('请先选择素材'); return; }
      api.pickFolder().then((dest) => {
        if (!dest) return;
        moveConfirm(paths, dest, () => doMove(paths, dest));
      });
    }
    if (act === 'del') {
      if (!paths.length) { toast('请先选择素材'); return; }
      modalConfirm('删除 ' + paths.length + ' 个素材', '确认删除这些本地文件吗？文件会先放进回收站，之后可以在左侧「回收站」里还原。', '删除', true, async () => {
        const r = await api.del({ paths: collectFiles(paths), groups: collectDeleteGroups(paths) });
        if (!r || !r.ok) { toast('删除失败，文件可能已被占用'); return; }
        toast('已移入回收站 ' + r.count + ' 个文件');
        S.selected.clear(); S.active = null;
        S.batch = false;
        $('#btnSelect').textContent = '选择';
        renderBatchBar();
        if (S.root) openFolder(S.root);
      });
    }
    if (act === 'all') {
      if (S.selected.size === S.filtered.length) S.selected.clear();
      else S.filtered.forEach((i) => S.selected.add(i.path));
      syncCardStates(); renderChrome(); renderBatchBar();
    }
    if (act === 'exit') enterBatch(false);
  });

  /* 全屏预览 */
  viewer.addEventListener('click', (e) => {
    if (e.target.closest('.viewer-top-hit')) {
      /* 控件已淡出时，点在原关闭按钮位置就直接退出；否则先唤回控件 */
      if (viewer.classList.contains('chrome-hidden')) {
        const btn = viewer.querySelector('.viewer-pill [data-act="close"]');
        if (btn) {
          const r = btn.getBoundingClientRect();
          const pad = 10;
          if (e.clientX >= r.left - pad && e.clientX <= r.right + pad
            && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad) { closeViewer(); return; }
        }
      }
      flashChrome();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const it = (S.viewerList || S.filtered)[S.viewerIdx];
    if (act === 'close') closeViewer();
    if (act === 'screen') {
      toggleViewerScreen();
      b.innerHTML = S.viewerScreen ? ICON.collapse : ICON.expand;
      b.title = S.viewerScreen ? '退出铺满屏幕' : '铺满屏幕';
    }
    if (act === 'slidePause') {
      S.slideshowPaused = !S.slideshowPaused;
      b.textContent = S.slideshowPaused ? '继续' : '暂停';
      if (S.slideshowPaused) clearTimeout(S.slideTimer);
      else scheduleSlide();
    }
    if (act === 'endSlide') { clearSlideshow(); closeViewer(); return; }
    if (act === 'openExt' && it) api.openExternal(it.kind === 'live' && it.videoPath ? it.videoPath : it.path);
    if (act === 'prev') { const L = S.viewerList || S.filtered; S.viewerIdx = (S.viewerIdx - 1 + L.length) % L.length; renderViewer(); }
    if (act === 'next') { const L = S.viewerList || S.filtered; S.viewerIdx = (S.viewerIdx + 1) % L.length; renderViewer(); }
  });

  /* 双击画面退出全屏 */
  viewer.addEventListener('dblclick', (e) => {
    if (!S.viewerOpen) return;
    /* 双击卡片打开全屏时，这一下 dblclick 会漏到全屏上，刚打开的 0.7 秒内不当作「退出」 */
    if (Date.now() - (S.viewerAt || 0) < 700) return;
    if (e.target.closest('[data-edit]')) {
      const it = (S.viewerList || S.filtered)[S.viewerIdx];
      const ed = e.target.closest('[data-edit]');
      if (it && ed) beginInlineEdit(ed, ed.dataset.edit, it);
      return;
    }
    if (e.target.closest('[data-act], .nav-btn, video, .sheet-inner')) return;
    toggleViewerScreen();
  });

  /* 鼠标活动时控件常驻 */
  viewer.addEventListener('mousemove', (e) => {
    if (!S.viewerOpen) return;
    S.hoverY = e.clientY;
    flashChrome();
  });

  /* 窗口缩放 / 进出铺满屏幕时重新计算图片可用区域，保证竖图、横图、视频都完整适配 */
  window.addEventListener('resize', () => {
    if (!S.viewerOpen) return;
    const open = viewer.classList.contains('sheet-open');
    syncStagePad(open ? 1 : 0);
  });

  /* 弹层 */
  modalRoot.addEventListener('click', (e) => {
    if (e.target === modalRoot) closeModal();
  });

  /* 键盘 */
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (e.key === 'Escape') { e.target.blur(); if (!viewer.hidden) closeViewer(); else closeModal(); }
      return;
    }

    if (S.viewerOpen) {
      if (e.key === 'Escape') {
        if (viewer.classList.contains('sheet-open')) { closeSheet(); return; }
        if (S.viewerScreen) { toggleViewerScreen(false); return; }
        closeViewer();
        return;
      }
      if (e.key === 'ArrowUp') {
        if (!viewer.classList.contains('sheet-open')) openSheet();
        return;
      }
      const VL = S.viewerList || S.filtered;
      if (e.key === 'ArrowRight') {
        S.viewerIdx = (S.viewerIdx + 1) % VL.length; renderViewer(); if (S.slideshow) scheduleSlide(); return;
      }
      if (e.key === 'ArrowLeft') {
        S.viewerIdx = (S.viewerIdx - 1 + VL.length) % VL.length; renderViewer(); if (S.slideshow) scheduleSlide(); return;
      }
      return;
    }

    if (!mapView.hidden) {
      if (e.key === 'Escape') { closeMap(); return; }
    }

    if (!modalRoot.hidden) {
      if (e.key === 'Escape') closeModal();
      return;
    }

    if (e.key === 'Escape' && S.batch) { enterBatch(false); return; }

    if (!S.filtered.length) return;
    const cols = Math.max(1, vcols || 1);
    const cur = S.filtered.findIndex((i) => i.path === S.active);
    let next = cur;

    if (e.key === 'ArrowRight') next = cur < 0 ? 0 : cur + 1;
    else if (e.key === 'ArrowLeft') next = cur < 0 ? 0 : cur - 1;
    else if (e.key === 'ArrowDown') next = (cur < 0 ? -cols : cur) + cols;
    else if (e.key === 'ArrowUp') next = (cur < 0 ? 0 : cur) - cols;
    else if (e.key === 'Enter' && S.active) { openViewer(S.active); return; }
    else return;

    e.preventDefault();
    next = Math.max(0, Math.min(S.filtered.length - 1, next));
    const it = S.filtered[next];
    setActive(it.path, { multi: false });
    ensureVisible(next);
  });

  /* 扫描进度 */
  api.onScanProgress((p) => {
    if (!S.scanning) return;
    loadingBox.hidden = false;
    loadingText.textContent = p.unpack ? `正在解压压缩包 ${p.done} / ${p.total}` : `正在读取拍摄时间 ${p.done} / ${p.total}`;
  });

  /* ───────────────────────── 启动 ───────────────────────── */

  async function boot() {
    const data = await api.libraryGet();
    loadLibrary(data);
    applySideWidths();
    applyInspectorHidden(!!lib.settings.insHidden, true);
    try { aiState.tags = (await api.aiGet()) || {}; } catch { aiState.tags = {}; }
    try { S.aiPeople = (await api.peopleGet()) || {}; } catch { S.aiPeople = {}; }
    applyCell(lib.settings.cell);
    applyNight();
    syncFilterButtons();
    initSortUI();
    refreshBin();

    await refreshHiddenPaths();
    renderSidebar();
    renderChrome();
    inspectorEmpty();
    renderBatchBar();

    await refreshValidity();

    // 自动打开上次使用的文件夹，让首次启动就有内容
    const visibleHist = (lib.history || []).filter((h) => h && h.path && pathAllowed(h.path));
    const lastPath = (lib.lastPath && pathAllowed(lib.lastPath)) ? lib.lastPath : ((visibleHist[0] && visibleHist[0].path) || '');
    if (lastPath) {
      if (!S.invalid.get(lastPath.toLowerCase())) openFolder(lastPath);
      else pathChipSet(lastPath, false);
    } else {
      pathChipSet(null, false);
    }
  }


  /* ═══════════════════ 全屏：上滑查看地点 / 照片信息 ═══════════════════ */

  let insMapObj = null;

  function drawInsMap(gps) {
    const box = document.getElementById('insMap');
    if (!box || !window.L) return;
    if (insMapObj) { try { insMapObj.remove(); } catch { /* ignore */ } insMapObj = null; }
    const c = wgs2gcj(gps.lat, gps.lon);
    const m = L.map(box, {
      zoomControl: false, attributionControl: false,
      scrollWheelZoom: false, doubleClickZoom: false, dragging: true
    });
    L.tileLayer(TILE_URL, TILE_OPTS).addTo(m);
    L.marker([c.lat, c.lng], {
      icon: L.divIcon({ className: 'dot-pin', html: '<i></i>', iconSize: [14, 14], iconAnchor: [7, 7] })
    }).addTo(m);
    m.setView([c.lat, c.lng], 14);
    setTimeout(() => { try { m.invalidateSize(); } catch { /* ignore */ } }, 240);
    insMapObj = m;
  }

  const metaCache = new Map();
  const placeCache = new Map();

  function metaOf(it) {

    const key = it.path + '|' + (it.videoPath || '');
    if (!metaCache.has(key)) {
      metaCache.set(key, api.meta({
        path: it.path, ext: it.ext, kind: it.kind,
        videoPath: it.videoPath || null, videoSize: it.videoSize || 0
      }).catch(() => null));
    }
    return metaCache.get(key);
  }

  function placeOf(gps) {
    if (!gps) return Promise.resolve(null);
    const k = gps.lat.toFixed(3) + ',' + gps.lon.toFixed(3);
    if (!placeCache.has(k)) {
      placeCache.set(k, api.place({ lat: gps.lat, lon: gps.lon }).catch(() => null));
    }
    return placeCache.get(k);
  }

  /* WGS-84 → GCJ-02：高德底图是 GCJ-02，不转换会有几百米偏移 */
  function transformLat(x, y) {
    let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
    r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
    return r;
  }
  function transformLng(x, y) {
    let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
    r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
    return r;
  }
  function wgs2gcj(lat, lng) {
    if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lat, lng };
    let dLat = transformLat(lng - 105, lat - 35);
    let dLng = transformLng(lng - 105, lat - 35);
    const radLat = lat / 180 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - 0.00669342162296594323 * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180) / ((6378245.0 * (1 - 0.00669342162296594323)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180) / (6378245.0 / sqrtMagic * Math.cos(radLat) * Math.PI);
    return { lat: lat + dLat, lng: lng + dLng };
  }

  const TILE_URL = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
  const TILE_OPTS = { subdomains: ['1', '2', '3', '4'], maxZoom: 18, minZoom: 3, attribution: '底图 © 高德地图' };

  function amapUrl(gps, name) {
    return 'https://uri.amap.com/marker?position=' + gps.lon.toFixed(6) + ',' + gps.lat.toFixed(6)
      + '&name=' + encodeURIComponent(name || '拍摄地点')
      + '&coordinate=wgs84&callnative=0&src=smart-album';
  }

  /* 信息层展开时，把图片区让出来，避免图片被压住（progress: 0 收起 · 1 展开） */
  const SHEET_PEEK = 54;
  function stagePadFor(progress) {
    if (S.slideshow) return 0;
    const sheet = viewer.querySelector('.viewer-sheet');
    const h = sheet ? sheet.getBoundingClientRect().height : 0;
    const vh = viewer.clientHeight || 900;
    const rest = SHEET_PEEK;
    /* 展开时最多占 34% 高度，保持图片有足够观看面积 */
    const full = Math.min((h || 0) + 10, Math.round(vh * 0.36));
    const p = Math.max(0, Math.min(1, progress));
    return Math.round(rest + (full - rest) * p);
  }

  function syncStagePad(progress) {
    const stage = viewer.querySelector('.viewer-stage');
    if (!stage) return;
    const open = viewer.classList.contains('sheet-open');
    const pad = stagePadFor(progress == null ? (open ? 1 : 0) : progress);
    stage.style.paddingBottom = pad + 'px';
    /* 实况封面按“舞台自身可用高度”缩放，避免窗口 / 全屏尺寸变化后沿用旧高度 */
    const padTop = parseFloat(getComputedStyle(stage).paddingTop) || 0;
    const limit = Math.max(120, Math.round(stage.clientHeight - padTop - pad));
    viewer.style.setProperty('--stage-limit', limit + 'px');
  }

  function openSheet(instant) { settleSheet(true, instant); }
  function closeSheet(instant) { settleSheet(false, instant); }

  function sheetRow(k, v, edit, orig) {
    return `<div class="sheet-row${edit ? ' editable' : ''}"${edit ? ` data-edit="${edit}" title="双击修改"` : ''}><span>${escapeHtml(k)}</span><b>${v}</b>${orig ? `<em class="sheet-orig">${escapeHtml(orig)}</em>` : ''}</div>`;
  }

  let sheetMap = null;
  function drawSheetMap(gps) {
    const box = viewer.querySelector('#sheetMap');
    if (!box || !window.L) return;
    if (sheetMap) { try { sheetMap.remove(); } catch { /* ignore */ } sheetMap = null; }
    const c = wgs2gcj(gps.lat, gps.lon);
    const m = L.map(box, {
      zoomControl: false, attributionControl: false,
      scrollWheelZoom: false, doubleClickZoom: false, dragging: true
    });
    L.tileLayer(TILE_URL, TILE_OPTS).addTo(m);
    L.marker([c.lat, c.lng], {
      icon: L.divIcon({ className: 'dot-pin', html: '<i></i>', iconSize: [14, 14], iconAnchor: [7, 7] })
    }).addTo(m);
    m.setView([c.lat, c.lng], 15);
    setTimeout(() => { try { m.invalidateSize(); } catch { /* ignore */ } }, 360);
    sheetMap = m;
  }

  async function fillSheet(it) {
    const inner = viewer.querySelector('#sheetInner');
    if (!inner) return;
    const meta = await metaOf(it);
    if (!S.viewerOpen || !inner.isConnected) return;

    const dt = dtOf(it);
    const raw = rawDateOf(it);
    const ed = editOf(it) || {};
    const gps = effectiveGps(it, ed) || (meta && meta.gps) || null;
    const customPlace = ed.place || '';
    const hint = viewer.querySelector('.viewer-hint-text');
    if (hint) hint.textContent = (gps || customPlace) ? '上滑查看拍摄地点' : '上滑查看照片信息';
    const coordText = gps ? `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}` : ((meta && meta.coord) || '');
    const placeKnown = customPlace || (meta && meta.place) || (gps ? coordText : null);
    const noteText = (ed.note != null ? ed.note : ((lib.notes || {})[it.path] || '')) || '';

    const rows = [];
    rows.push(sheetRow('拍摄时间', dt ? '<span class="dt"><span>' + fmtDate(dt) + '</span><span class="dt-time">' + fmtTime(dt) + '</span></span>' : '—', 'time', (ed.date && raw) ? '原始：' + fmtFull(raw.getTime()) : ''));
    rows.push(sheetRow('格式', escapeHtml((it.ext || '').toUpperCase()) + ' · ' + (KIND_LABEL[it.kind] || '')));
    if (meta && meta.pixel) rows.push(sheetRow('分辨率', `${meta.pixel.w} × ${meta.pixel.h}`));
    rows.push(sheetRow('文件大小', fmtSize(meta && meta.size ? meta.size : it.size)));
    if (meta && meta.camera) rows.push(sheetRow('相机', escapeHtml(meta.camera)));
    rows.push(sheetRow('创建时间', fmtFull(it.btime || it.mtime)));
    if (ed.at) rows.push(sheetRow('信息修改时间', fmtFull(ed.at)));
    rows.push(sheetRow('备注', escapeHtml(noteText || '无 · 双击添加备注'), 'note'));

    inner.innerHTML = `
      <div class="sheet-file"><span>${escapeHtml(niceName(it.name))}</span>${it.kind === 'live' ? '<b>实况</b>' : it.kind === 'video' ? '<b>视频</b>' : ''}</div>
      <div class="sheet-kicker">${(gps || customPlace) ? '这张照片的拍摄地点' : '这张照片的信息'}</div>
      <div class="sheet-place${(gps || customPlace) ? ' editable' : ' muted'}" data-edit="place" title="双击修改地点">${(gps || customPlace)
        ? escapeHtml(placeKnown || '正在解析地点…')
        : '未设置地点 · 双击添加'}</div>
      ${customPlace && (meta && (meta.place || meta.coord)) ? `<div class="sheet-coord">原始：${escapeHtml((meta && (meta.place || meta.coord)) || '')}</div>` : ''}
      ${gps && coordText ? `<div class="sheet-coord">${escapeHtml(coordText)}</div>` : ''}
      ${gps ? '<div class="sheet-map" id="sheetMap"></div>' : ''}
      <div class="sheet-rows">${rows.join('')}</div>
      ${(ed.date || ed.place != null || ed.note != null) ? `<div class="edit-record" style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.55)"><b style="color:rgba(255,255,255,.82)">修改记录</b><br>${escapeHtml([ed.date ? '时间' : '', ed.place != null ? '地点' : '', ed.note != null ? '备注' : ''].filter(Boolean).join('、'))} · ${escapeHtml(fmtFull(ed.at || Date.now()))}</div>` : ''}
      <div class="sheet-acts">
        ${gps ? '<button class="primary" data-act="amap">在高德地图打开</button>' : ''}
        <button data-act="closeSheet">收起</button>
      </div>`;

    if (gps && !customPlace && !(meta && meta.place)) {
      placeOf(gps).then((place) => {
        const pel = viewer.querySelector('.sheet-place');
        if (!pel) return;
        pel.textContent = place || '经纬度位置';
      });
    }
    if (gps) drawSheetMap(gps);
    if (viewer.classList.contains('sheet-open')) requestAnimationFrame(syncStagePad);
  }

  /* 信息层：上滑跟手展开，向下拖动（含顶部小横条）跟手收起 */
  let sheetDrag = null;
  let sheetShift = 0;          // 相对基准位置的额外位移（px）
  let sheetAnimTimer = 0;
  const OPEN_AT = 46;
  const CLOSE_AT = 72;
  const FLICK_AT = 22;

  const sheetEl = () => viewer.querySelector('.viewer-sheet');
  const sheetHeight = () => {
    const s = sheetEl();
    return s ? s.getBoundingClientRect().height : 0;
  };

  function paintSheet(y) {
    const s = sheetEl();
    if (s) s.style.transform = 'translateY(' + Math.round(y) + 'px)';
  }

  /* 位移量 → 舞台让位进度 */
  function padFromShift(y, h) {
    if (!h) return 0;
    return Math.max(0, Math.min(1, 1 - y / h));
  }

  /* 统一收放：从当前视觉位置平滑吸到目标位置，避免半路跳动 */
  function settleSheet(targetOpen, instant) {
    const s = sheetEl();
    if (!s) return;
    clearTimeout(sheetAnimTimer);
    const wasOpen = viewer.classList.contains('sheet-open');
    const h = sheetHeight();
    const fromY = wasOpen ? sheetShift : (h - SHEET_PEEK) + sheetShift;
    const toY = targetOpen ? 0 : Math.max(0, h - SHEET_PEEK);
    sheetShift = 0;
    viewer.classList.remove('sheet-dragging');
    s.style.transition = 'none';
    s.style.transform = 'translateY(' + Math.round(fromY) + 'px)';
    viewer.classList.toggle('sheet-open', !!targetOpen);
    void s.offsetHeight;
    syncStagePad(targetOpen ? 1 : 0);
    if (instant) {
      s.style.transition = '';
      s.style.transform = '';
      return;
    }
    if (Math.abs(fromY - toY) < 1.5) {
      s.style.transform = 'translateY(' + Math.round(toY) + 'px)';
      sheetAnimTimer = setTimeout(() => { s.style.transition = ''; s.style.transform = ''; }, 60);
      return;
    }
    s.style.transition = 'transform .46s cubic-bezier(.22, .9, .24, 1)';
    s.style.transform = 'translateY(' + Math.round(toY) + 'px)';
    const done = () => {
      s.removeEventListener('transitionend', onEnd);
      s.style.transition = '';
      s.style.transform = '';
    };
    const onEnd = (ev) => { if (ev && ev.propertyName !== 'transform') return; done(); };
    s.addEventListener('transitionend', onEnd);
    sheetAnimTimer = setTimeout(done, 640);
  }

  viewer.addEventListener('pointerdown', (e) => {
    if (!S.viewerOpen) return;
    if (e.button !== 0) return;
    if (e.target.closest('[data-act], .nav-btn, .viewer-pill, .live-ctl, .slide-bar, [data-edit], input, textarea, select')) return;
    const sheet = sheetEl();
    if (!sheet) return;
    const open = viewer.classList.contains('sheet-open');
    const inSheet = !!e.target.closest('.viewer-sheet');
    if (inSheet) {
      /* 收起时只有把手能拉；展开后从把手/文件头拖，正文区域留给文字选择和滚动 */
      const dragZone = e.target.closest('.sheet-grip, .sheet-file, .sheet-kicker');
      if (open && !dragZone) return;
      if (!open && !e.target.closest('.sheet-grip')) return;
    }
    if (!open && e.target.closest('video')) return;
    clearTimeout(sheetAnimTimer);
    const h = sheetHeight();
    const y = open ? 0 : Math.max(0, h - SHEET_PEEK);
    sheetDrag = { y0: e.clientY, open, moved: false, h, y0abs: y, onGrip: !!e.target.closest('.sheet-grip') };
    sheetShift = 0;
    viewer.classList.add('sheet-dragging');
    sheet.style.transition = 'none';
    sheet.style.transform = 'translateY(' + Math.round(y) + 'px)';
    try { e.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  viewer.addEventListener('pointermove', (e) => {
    if (!sheetDrag) return;
    const dy = e.clientY - sheetDrag.y0;
    if (!sheetDrag.moved && Math.abs(dy) > 4) sheetDrag.moved = true;
    const h = sheetDrag.h;
    const open = sheetDrag.open;
    let y = sheetDrag.y0abs + dy;
    if (open) y = Math.max(0, Math.min(h, y));
    else y = Math.max(0, Math.min(h, y));
    sheetShift = y - sheetDrag.y0abs;
    paintSheet(y);
    syncStagePad(padFromShift(y, h));
  }, { passive: true });

  viewer.addEventListener('pointerup', (e) => {
    if (!sheetDrag) return;
    const dy = e.clientY - sheetDrag.y0;
    const d = sheetDrag;
    sheetDrag = null;
    if (!d.moved) {
      if (d.onGrip) settleSheet(!d.open);
      return;
    }
    if (!d.open) settleSheet(dy <= -OPEN_AT || dy <= -FLICK_AT);
    else settleSheet(!(dy >= CLOSE_AT || dy >= FLICK_AT * 2));
  });
  viewer.addEventListener('pointercancel', () => {
    if (!sheetDrag) return;
    const open = sheetDrag.open;
    sheetDrag = null;
    settleSheet(open);
  });

  /* 滚轮：外观区域上滚滚开；展开后信息正文只负责滚动，不再一滚就收 */
  viewer.addEventListener('wheel', (e) => {
    if (!S.viewerOpen) return;
    if (e.target.closest('.info-editor, .modal-root')) return;
    const open = viewer.classList.contains('sheet-open');
    if (!open) {
      if (e.deltaY < -45) openSheet();
      return;
    }
    if (e.target.closest('.sheet-inner')) return;
    if (e.deltaY > 45) closeSheet();
  }, { passive: true });
  viewer.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'closeSheet') { closeSheet(); return; }
    if (act === 'allmap') { closeSheet(); closeViewer(); openMap(); return; }
    if (act === 'amap') {
      const it = S.filtered[S.viewerIdx];
      if (!it) return;
      const meta = await metaOf(it);
      const g = it.gps || (meta && meta.gps);
      if (g) api.openUrl(amapUrl(g, (meta && meta.place) || baseName(it.path)));
    }
  });

  /* ═══════════════════ 足迹地图 ═══════════════════ */

  const mapView = $('#mapView');
  const mapEl = $('#mapEl');
  const mapSub = $('#mapSub');
  let bigMap = null;

  function photoPin(it) {
    return L.divIcon({
      className: 'photo-pin',
      html: `<div class="pin" data-pin="${escapeHtml(it.path)}"></div>`,
      iconSize: [40, 40], iconAnchor: [20, 20], popupAnchor: [0, -24]
    });
  }

  function placePin(it, n) {
    const dots = '<div class="pin" data-pin="' + escapeHtml(it.path) + '"></div><b class="pin-n">' + (n > 99 ? '99+' : n) + '</b>';
    return L.divIcon({ className: 'photo-pin multi', html: dots, iconSize: [44, 44], iconAnchor: [22, 22], popupAnchor: [0, -24] });
  }

  /* 同一个位置上的多张照片，收成一个数字气泡，避免点位糊成一团 */
  function countPin(n, lat, lng) {
    return L.divIcon({
      className: 'count-pin',
      html: `<div class="cnt"><b>${n > 99 ? '99+' : n}</b><div class="minis"></div></div>`,
      iconSize: [112, 96], iconAnchor: [56, 96]
    });
  }

  async function fillCountMinis(mk) {
    if (!mk || !mk.__group) return;
    const node = mk.getElement();
    const box = node && node.querySelector('.minis');
    if (!box) return;
    const pick = mk.__group.slice(0, 3);
    for (const it of pick) {
      const r = await api.thumb(it);
      if (!r || !r.url) continue;
      if (!box.isConnected) return;
      const d = el('div', 'mini-pin');
      d.dataset.pin = it.path;
      d.style.backgroundImage = 'url("' + r.url + '")';
      box.appendChild(d);
    }
  }

  function bucketStep(zoom) {
    if (zoom >= 16) return 0.0008;
    if (zoom >= 14) return 0.0030;
    if (zoom >= 12) return 0.0130;
    if (zoom >= 10) return 0.0500;
    return 0.2000;
  }

  function groupPins(geo, zoom) {
    const step = bucketStep(zoom);
    const out = new Map();
    for (const it of geo) {
      const key = Math.round(it.gps.lat / step) + '|' + Math.round(it.gps.lon / step);
      const cur = out.get(key);
      if (cur) cur.push(it);
      else out.set(key, [it]);
    }
    return Array.from(out.values());
  }

  async function fillPin(it) {
    const r = await api.thumb(it);
    if (!r || !r.url) return;
    const node = mapEl.querySelector(`.pin[data-pin="${CSS.escape(it.path)}"]`);
    if (node) node.style.backgroundImage = `url("${r.url}")`;
  }

  const pinJobs = [];
  let pinRunning = false;
  function runPinJobs() {
    if (pinRunning) return;
    pinRunning = true;
    (async () => {
      while (pinJobs.length) {
        const job = pinJobs.shift();
        try { await job(); } catch { /* ignore */ }
      }
      pinRunning = false;
    })();
  }

  function popupHtml(it) {
    const dt = dtOf(it);
    return `<div class="pop" data-path="${escapeHtml(it.path)}">
      <div class="pop-img"></div>
      <div class="pop-body">
        <div class="pop-name">${escapeHtml(niceName(it.name))}</div>
        <div class="pop-sub">${dt ? fmtFull(dt) : ''}</div>
        <div class="pop-sub pop-place">${it.gps ? `${it.gps.lat.toFixed(4)}, ${it.gps.lon.toFixed(4)}` : ''}</div>
        <div class="pop-acts">
          <button data-pop-act="view">全屏查看</button>
          <button data-pop-act="map">打开地图</button>
        </div>
      </div>
    </div>`;
  }

  async function fillPopup(it, node) {
    if (!node || !it) return;
    const img = node.querySelector('.pop-img');
    if (img) {
      const r = await api.thumb(it);
      if (r && r.url) img.style.backgroundImage = `url("${r.url}")`;
    }
    const pl = node.querySelector('.pop-place');
    if (pl && it.gps) {
      const place = await placeOf(it.gps);
      if (place) pl.textContent = place;
    }
  }

  function openMap() {
    if (!window.L) { toast('地图组件未加载'); return; }
    const items = S.items || [];
    const geo = items.filter((x) => x.gps);
    mapView.hidden = false;
    mapSub.textContent = geo.length
      ? `${geo.length} 张有拍摄地点${items.length - geo.length ? ` · ${items.length - geo.length} 张无地点` : ''}`
      : (items.length ? '当前素材都没有拍摄地点' : '先打开一个文件夹');
    $('#mapTip').textContent = geo.length
      ? '点击照片查看详情 · 滚轮缩放 · 拖动平移'
      : '截图、下载图通常不含 GPS；手机相机拍摄的素材会显示在这里';

    if (!bigMap) {
      bigMap = L.map(mapEl, { zoomControl: true, attributionControl: false, minZoom: 3, maxZoom: 18 });
      L.tileLayer(TILE_URL, TILE_OPTS).addTo(bigMap);
      bigMap.setView([31, 110], 4);
      bigMap.on('popupopen', (e) => {
        const mk = e.popup && e.popup._source;
        fillPopup(mk && mk.__item, e.popup.getElement());
      });
      bigMap.on('zoomend moveend', () => {
        clearTimeout(mapRebuildTimer);
        mapRebuildTimer = setTimeout(() => { try { renderPins(); } catch { /* ignore */ } }, 200);
      });
    }
    setTimeout(() => { try { bigMap.invalidateSize(); } catch { /* ignore */ } }, 80);

    if (!geo.length) {
      if (pinLayer) { try { bigMap.removeLayer(pinLayer); } catch { /* ignore */ } pinLayer = null; }
      return;
    }

    const pts = geo.map((it) => {
      const c = wgs2gcj(it.gps.lat, it.gps.lon);
      return [c.lat, c.lng];
    });
    bigMap.fitBounds(L.latLngBounds(pts).pad(0.16), { maxZoom: 13 });
    renderPins();
  }

  let pinLayer = null;
  let mapRebuildTimer = null;

  function renderPins() {
    if (!bigMap) return;
    const geo = (S.items || []).filter((x) => x.gps);
    if (pinLayer) { try { bigMap.removeLayer(pinLayer); } catch { /* ignore */ } pinLayer = null; }
    pinJobs.length = 0;
    const view = bigMap.getBounds();
    const groups = groupPins(geo, bigMap.getZoom());
    const layer = L.layerGroup();
    const thumbs = [];

    for (const g of groups) {
      const it = g[0];
      const c = wgs2gcj(it.gps.lat, it.gps.lon);
      if (g.length === 1) {
        const mk = L.marker([c.lat, c.lng], { icon: photoPin(it), riseOnHover: true });
        mk.__item = it;
        mk.bindPopup(() => popupHtml(it), { maxWidth: 240, minWidth: 212, className: 'album-pop' });
        layer.addLayer(mk);
        if (view.contains([c.lat, c.lng])) thumbs.push(it);
      } else {
        const pick = g[Math.floor(Math.random() * g.length)];
        const mk = L.marker([c.lat, c.lng], { icon: placePin(pick, g.length), riseOnHover: true });
        mk.__item = pick;
        mk.on('click', () => { closeMap(); openPlace(g, pick); });
        layer.addLayer(mk);
        if (view.contains([c.lat, c.lng])) thumbs.push(pick);
      }
    }

    layer.addTo(bigMap);
    pinLayer = layer;
    // 只补视野里的缩略图（最多 160 张），一万张的相册也不会卡
    for (const it of thumbs.slice(0, 160)) pinJobs.push(() => fillPin(it));
    runPinJobs();
  }

  function closeMap() { mapView.hidden = true; }

  function openPlace(group, sample) {
    const g = (sample && sample.gps) || (group && group[0] && group[0].gps);
    if (!g) return;
    let members = (group || []).slice();
    if (members.length <= 1) {
      /* 最大缩放时单点被拆开：把附近同一地点的素材一起收进来 */
      members = (S.items || []).filter((it) => it.gps
        && Math.abs(it.gps.lat - g.lat) < 0.0025
        && Math.abs(it.gps.lon - g.lon) < 0.0025);
    }
    if (!members.length && sample) members = [sample];
    S.mode = 'place';
    S.payload = { lat: g.lat, lon: g.lon, label: '', paths: members.map((it) => it.path) };
    S.dir = '';
    S.selected.clear();
    S.active = null;
    S.flat = false;
    showInspector(null);
    renderSidebar();
    renderList(true);
    api.place({ lat: g.lat, lon: g.lon }).then((name) => {
      if (S.mode !== 'place' || !S.payload) return;
      S.payload.label = name || '';
      renderChrome();
    }).catch(() => { /* ignore */ });
  }

  $('#btnMap').addEventListener('click', () => {
    if (!S.items || !S.items.length) { toast('先打开一个文件夹'); return; }
    openMap();
  });
  $('#mapBack').addEventListener('click', closeMap);

  mapEl.addEventListener('click', (e) => {
    const mini = e.target.closest('.mini-pin');
    if (mini && mini.dataset.pin) {
      e.stopPropagation();
      const it = S.byPath.get(mini.dataset.pin) || itemForPath(mini.dataset.pin);
      closeMap();
      openViewer(it.path, [it]);
      return;
    }
    const b = e.target.closest('[data-pop-act]');
    if (!b) return;
    const pop = b.closest('.pop');
    const it = pop ? S.byPath.get(pop.dataset.path) : null;
    if (!it) return;
    if (b.dataset.popAct === 'view') { closeMap(); openViewer(it.path); }
    if (b.dataset.popAct === 'map' && it.gps) api.openUrl(amapUrl(it.gps, it.name));
  });

  /* ═══════════════════ 智能识别（本地模型 · 全程离线） ═══════════════════ */

  const aiView = $('#aiView');
  const aiInner = $('#aiInner');
  const aiState = {
    tags: {},
    model: null,
    running: false,
    stop: false,
    done: 0,
    total: 0,
    currentName: '',
    canvas: null
  };

  function aiCanvas() {
    if (!aiState.canvas) aiState.canvas = el('canvas');
    return aiState.canvas;
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('image'));
      im.src = src;
    });
  }

  async function loadFaceModel() {
    if (aiState.model) return aiState.model;
    aiState.model = (async () => {
      const mod = await import('./vendor/mediapipe/vision_bundle.mjs');
      const fileset = await mod.FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm');
      const face = await mod.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: './vendor/models/blaze_face_short_range.tflite', delegate: 'CPU' },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.35
      });
      return { face };
    })();
    try {
      return await aiState.model;
    } catch (err) {
      aiState.model = null;
      throw err;
    }
  }

  function pixelStats(cx, w, h) {
    let n = 0, sum = 0, light = 0, green = 0, blue = 0, sat = 0;
    const data = cx.getImageData(0, 0, w, h).data;
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 14000)));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
        const lum = (r * 299 + g * 587 + b * 114) / 1000;
        sum += lum; n += 1;
        if (lum > 205) light += 1;
        if (g > r + 12 && g > b + 6) green += 1;
        if (b > r + 10) blue += 1;
        const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
        sat += mx ? (mx - mn) / mx : 0;
      }
    }
    return {
      lum: sum / Math.max(1, n),
      light: light / Math.max(1, n),
      green: green / Math.max(1, n),
      blue: blue / Math.max(1, n),
      sat: sat / Math.max(1, n)
    };
  }

  function dhashFromCanvas(srcCanvas, x, y, w, h) {
    try {
      const cv2 = document.createElement('canvas');
      cv2.width = 9; cv2.height = 8;
      const c2 = cv2.getContext('2d', { willReadFrequently: true });
      c2.drawImage(srcCanvas, x, y, w, h, 0, 0, 9, 8);
      const d = c2.getImageData(0, 0, 9, 8).data;
      const lum = [];
      for (let i = 0; i < 72; i++) {
        const o = i * 4;
        lum.push((d[o] * 299 + d[o + 1] * 587 + d[o + 2] * 114) / 1000);
      }
      let hex = '';
      for (let row = 0; row < 8; row++) {
        let q = 0;
        for (let col = 0; col < 8; col++) {
          q = (q << 1) | (lum[row * 9 + col] > lum[row * 9 + col + 1] ? 1 : 0);
        }
        hex += q.toString(16).padStart(2, '0');
      }
      return hex;
    } catch { return null; }
  }

  function hammingHex(a, b) {
    if (!a || !b || a.length !== b.length) return 64;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
      while (x) { diff += x & 1; x >>= 1; }
    }
    return diff;
  }

  const RAW_EXT = new Set(['raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'rw2', 'orf', 'pef', 'srw']);
  function isShotName(name) {
    return /(屏幕截图|截屏|截图|screenshot|snipaste|微信截图|qq截图|screen[ _-]?shot)/i.test(name || '');
  }
  function inferTypes(it, t) {
    const out = [];
    const ext = String((it && it.ext) || '').toLowerCase();
    const name = it && it.name || '';
    if (RAW_EXT.has(ext) || ext === 'raw') out.push('raw');
    if (t && t.types && t.types.length) {
      for (const x of t.types) if (!out.includes(x)) out.push(x);
    } else {
      if (isShotName(name)) out.push('screenshot');
      if (t && /截图/.test(t.s || '')) out.push('screenshot');
      if (t && /文档/.test(t.s || '')) out.push('document');
    }
    return out;
  }
  function typeAllowed(x) {
    if (x === 'screenshot') return lib.settings.aiScreenshot !== false;
    if (x === 'document') return lib.settings.aiDoc !== false;
    if (x === 'raw') return lib.settings.aiRaw !== false;
    return true;
  }

  function sceneLabel(faces, st) {
    if (faces >= 1) return '人像';
    if (st.lum < 52) return '夜景';
    if (st.light > 0.62 && st.sat < 0.18) return '截图 / 文档';
    if (st.light > 0.5) return '白底文档';
    if (st.green > 0.28) return '风景';
    if (st.blue > 0.42) return '户外';
    if (st.sat < 0.1) return '静物';
    return '日常';
  }

  async function aiTagItem(it, model) {
    const ext = String(it.ext || '').toLowerCase();
    const raw = RAW_EXT.has(ext);
    if (raw) return { p: 0, s: 'RAW 原片', types: ['raw'], at: Date.now() };
    const shotName = isShotName(it.name);
    if (it.kind === 'doc' && !['pdf', 'ofd'].includes(ext)) {
      return { p: 0, s: '拍摄文档', types: ['document'], at: Date.now() };
    }
    const s = await api.sample({ path: it.path, ext: it.ext, kind: it.kind });
    if (!s || s.error) {
      if (shotName) return { p: 0, s: '截图', types: ['screenshot'], at: Date.now() };
      return null;
    }
    let img;
    try { img = await loadImage(s.dataUrl); } catch { return null; }
    const cv = aiCanvas();
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const scale = Math.min(1, 320 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    cv.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    cv.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    cx.drawImage(img, 0, 0, cv.width, cv.height);
    let faces = 0;
    let fh = null;
    try {
      const r = model.face.detect(cv);
      const dts = (r && r.detections) ? r.detections : [];
      faces = dts.length;
      if (faces) {
        let best = dts[0];
        let bestA = 0;
        for (const d of dts) {
          const bb = d.boundingBox || {};
          const a = (bb.width || 0) * (bb.height || 0);
          if (a > bestA) { bestA = a; best = d; }
        }
        const bb = best.boundingBox || {};
        const norm = (bb.width || 0) <= 1.5 && (bb.height || 0) <= 1.5;
        let bx = norm ? bb.originX * cv.width : (bb.originX || 0);
        let by = norm ? bb.originY * cv.height : (bb.originY || 0);
        let bw = norm ? bb.width * cv.width : (bb.width || 0);
        let bh = norm ? bb.height * cv.height : (bb.height || 0);
        const pad = Math.max(4, Math.round(Math.min(bw, bh) * 0.12));
        bx = Math.max(0, bx - pad); by = Math.max(0, by - pad);
        bw = Math.min(cv.width - bx, bw + pad * 2);
        bh = Math.min(cv.height - by, bh + pad * 2);
        if (bw > 8 && bh > 8) fh = dhashFromCanvas(cv, bx, by, bw, bh);
      }
    } catch { faces = 0; }
    let st;
    try { st = pixelStats(cx, cv.width, cv.height); }
    catch { st = { lum: 128, light: 0, green: 0, blue: 0, sat: 0 }; }
    const types = [];
    if (shotName) types.push('screenshot');
    const w = (s && s.w) || cv.width;
    const h = (s && s.h) || cv.height;
    const ratio = h ? (w / h) : 1;
    const screenRatio = ratio >= 1.45 && ratio <= 2.45;
    if (!faces && st.light > 0.58 && st.sat < 0.2) {
      if (screenRatio || shotName) { if (!types.includes('screenshot')) types.push('screenshot'); }
      else { if (!types.includes('document')) types.push('document'); }
    }
    if (!faces && st.light > 0.45 && st.sat < 0.09) {
      if (!types.includes('document')) types.push('document');
    }
    const label = types.includes('screenshot') ? '截图'
      : types.includes('document') ? '拍摄文档'
      : sceneLabel(faces, st);
    return { p: faces, s: label, types, fh: fh || null, at: Date.now() };
  }

  function clusterFaces() {
    const list = S.items.filter((it) => aiState.tags[it.path] && aiState.tags[it.path].fh);
    const groups = [];
    for (const it of list) {
      const h = aiState.tags[it.path].fh;
      let hit = null;
      for (const g of groups) {
        if (hammingHex(h, g.rep) <= 12) { hit = g; break; }
      }
      if (hit) hit.items.push(it.path);
      else groups.push({ rep: h, items: [it.path] });
    }
    const big = groups.filter((g) => g.items.length >= 2);
    const prev = {};
    for (const it of S.items) {
      const t = aiState.tags[it.path];
      if (t && t.fid) {
        prev[t.fid] = prev[t.fid] || new Set();
        prev[t.fid].add(it.path);
      }
    }
    const used = new Set();
    const out = [];
    for (const g of big) {
      let bestId = null;
      let bestN = 0;
      for (const fid of Object.keys(prev)) {
        if (used.has(fid)) continue;
        let n = 0;
        for (const p of g.items) if (prev[fid].has(p)) n += 1;
        if (n > bestN) { bestN = n; bestId = fid; }
      }
      let fid = bestId;
      if (!fid || bestN < 2) {
        let i = 1;
        while (used.has('f' + i) || prev['f' + i]) i += 1;
        fid = 'f' + i;
      }
      used.add(fid);
      out.push({ fid, items: g.items });
    }
    for (const it of S.items) {
      const t = aiState.tags[it.path];
      if (t && t.fid) delete t.fid;
    }
    const patch = {};
    for (const g of out) {
      for (const p of g.items) {
        if (aiState.tags[p]) { aiState.tags[p].fid = g.fid; patch[p] = aiState.tags[p]; }
      }
    }
    return { groups: out, patch };
  }

  function aiCounts(items) {
    const groups = { people: [], scene: [], types: [] };
    const push = (k, v, label, icon) => {
      let g = groups[k].find((x) => x.v === v);
      if (!g) {
        g = { k, v, label, icon, n: 0 };
        groups[k].push(g);
      }
      g.n += 1;
    };
    for (const it of items) {
      const t = aiState.tags[it.path];
      if (!t) continue;
      const p = t.p || 0;
      if (p >= 2) push('people', '2', '多人合影', ICON.person);
      else if (p === 1) push('people', '1', '单人照', ICON.person);
      else push('people', '0', '无人像', ICON.image);
      if (t.s) push('scene', t.s, t.s, ICON.spark);
      const ts = inferTypes(it, t);
      if (ts.includes('screenshot') && typeAllowed('screenshot')) push('types', 'screenshot', '截图', ICON.image);
      if (ts.includes('document') && typeAllowed('document')) push('types', 'document', '拍摄文档', ICON.doc);
      if (ts.includes('raw') && typeAllowed('raw')) push('types', 'raw', 'RAW 原片', ICON.image);
    }
    return groups;
  }

  function clusterSimilar(sigs) {
    const out = [];
    const used = new Set();
    for (let i = 0; i < sigs.length; i++) {
      if (used.has(i)) continue;
      const base = sigs[i];
      const group = [base];
      used.add(i);
      for (let j = i + 1; j < sigs.length; j++) {
        if (used.has(j)) continue;
        const o = sigs[j];
        if (o.kind !== base.kind && !(o.kind === 'live' && base.kind === 'image')) continue;
        if (hammingHex(base.hash, o.hash) > 10) continue;
        const sizeRatio = Math.min(base.size, o.size) / Math.max(base.size, o.size, 1);
        const dimRatio = (base.w && o.w) ? Math.min(base.w / o.w, o.w / base.w) : 1;
        if (sizeRatio < 0.55 || dimRatio < 0.8) continue;
        group.push(o);
        used.add(j);
      }
      if (group.length >= 2) out.push(group);
    }
    return out;
  }

  function renderAI() {
    const GRPX = lib.dupGroups || [];
    if (S.dupOnly) {
      const titleEl = aiView.querySelector('.map-title');
      if (titleEl) titleEl.textContent = '相似素材';
      const cards = GRPX.map((g, gi) => {
        const its = g.items.map((pp) => S.byPath.get(pp) || itemForPath(pp)).filter(Boolean);
        const cells = its.map((it) => '<div class="dup-item">'
          + '<div class="dup-thumb" data-pin="' + escapeHtml(it.path) + '">'
          + (it.size ? '<span class="sz-tag">' + fmtSize(it.size) + '</span>' : '') + '</div>'
          + '<div class="dup-name" title="' + escapeHtml(it.path) + '">' + escapeHtml(niceName(it.name)) + '</div>'
          + '<button data-ai-act="keepOne" data-group="' + escapeHtml(g.id) + '" data-path="' + escapeHtml(it.path) + '">保留这张</button>'
          + '</div>').join('');
        return '<div class="dup-card"><div class="dup-head">相似组 ' + (gi + 1) + ' · ' + g.items.length + ' 项</div>'
          + '<div class="dup-items">' + cells + '</div>'
          + '<div class="dup-acts"><button data-ai-act="keepAll" data-group="' + escapeHtml(g.id) + '">全部保留</button></div></div>';
      }).join('');
      aiInner.innerHTML = cards ? '<div class="ai-dupes">' + cards + '</div>' : '<div class="ai-section"><div class="side-note">无</div></div>';
      aiSub.textContent = '';
      fillAiThumbs();
      return;
    }
    const titleEl2 = aiView.querySelector('.map-title');
    if (titleEl2) titleEl2.textContent = '智能识别';
    const items = S.items || [];
    const total = items.length;
    const tagged = items.filter((it) => aiState.tags[it.path]).length;
    const groups = aiCounts(items);
    const running = aiState.running;
    const pct = aiState.total ? Math.round((aiState.done / aiState.total) * 100) : 0;
    const chip = (g) => '<button class="ai-chip" data-ai-k="' + g.k + '" data-ai-v="' + escapeHtml(g.v) + '">' + g.icon + '<span>' + escapeHtml(g.label) + '</span><b>' + g.n + '</b></button>';

    /* 人物：只有真的分出不同人物时才显示 */
    const faceIds = [];
    for (const it of items) {
      const t = aiState.tags[it.path];
      if (t && t.fid && faceIds.indexOf(t.fid) < 0) faceIds.push(t.fid);
    }
    const peopleCards = faceIds.map((fid) => {
      const n = items.filter((it) => aiState.tags[it.path] && aiState.tags[it.path].fid === fid).length;
      if (!n) return '';
      const first = items.find((it) => aiState.tags[it.path] && aiState.tags[it.path].fid === fid);
      const nm = S.aiPeople[fid] || ('人物 ' + String(fid).replace(/^f/, ''));
      return '<div class="ai-person" data-face="' + escapeHtml(fid) + '">'
        + '<div class="ap-ava" data-pin="' + escapeHtml(first ? first.path : '') + '"></div>'
        + '<div class="ap-meta"><b>' + escapeHtml(String(nm)) + '</b><span>' + n + ' 张</span></div>'
        + '<button class="ap-name" data-ai-act="renameFace" data-face="' + escapeHtml(fid) + '">备注</button></div>';
    }).join('');

    /* 相似素材：有分组才显示，不再放「分析」按钮 */
    const GRP = lib.dupGroups || [];
    const dupCards = GRP.map((g, gi) => {
      const its = g.items.map((p) => S.byPath.get(p) || itemForPath(p));
      const cells = its.map((it) => '<div class="dup-item">'
        + '<div class="dup-thumb" data-pin="' + escapeHtml(it.path) + '">'
        + (it.size ? '<span class="sz-tag">' + fmtSize(it.size) + '</span>' : '') + '</div>'
        + '<div class="dup-name" title="' + escapeHtml(it.path) + '">' + escapeHtml(niceName(it.name)) + '</div>'
        + '<button data-ai-act="keepOne" data-group="' + escapeHtml(g.id) + '" data-path="' + escapeHtml(it.path) + '">保留这张</button>'
        + '</div>').join('');
      return '<div class="dup-card"><div class="dup-head">相似组 ' + (gi + 1) + ' · ' + g.items.length + ' 项</div>'
        + '<div class="dup-items">' + cells + '</div>'
        + '<div class="dup-acts"><button data-ai-act="keepAll" data-group="' + escapeHtml(g.id) + '">全部保留</button></div></div>';
    }).join('');

    aiInner.innerHTML = '<div class="ai-card">'
      + '<div class="ai-rowline"><div class="ai-stat"><b>' + tagged + '</b><span>已识别</span></div>'
      + '<div class="ai-stat"><b>' + total + '</b><span>总素材</span></div></div>'
      + (running
        ? '<div class="ai-progress"><div style="width:' + pct + '%"></div></div>'
          + '<div class="ai-run-line">' + aiState.done + ' / ' + aiState.total + ' · ' + escapeHtml(aiState.currentName || '') + '</div>'
          + '<div class="ai-actions"><button class="ai-btn ghost" data-ai-act="stop">停止</button></div>'
        : '<div class="ai-actions"><button class="btn-primary" data-ai-act="run"' + (total ? '' : ' disabled') + '>'
          + (tagged ? '继续识别剩余素材' : '开始识别') + '</button>'
          + (tagged ? '<button class="ai-btn ghost" data-ai-act="reset">清除结果</button>' : '') + '</div>')
      + '</div>'
      + (groups.people.length || groups.scene.length
        ? '<div class="ai-section"><div class="ai-sec-t">标签</div><div class="ai-chips">' + groups.people.map(chip).join('') + '</div></div>'
          + '<div class="ai-section"><div class="ai-sec-t">场景</div><div class="ai-chips">' + groups.scene.map(chip).join('') + '</div></div>'
        : '')
      + (peopleCards ? '<div class="ai-section"><div class="ai-sec-t">人物</div><div class="ai-people">' + peopleCards + '</div></div>' : '')
      + (dupCards
        ? '<div class="ai-section"><div class="ai-sec-t">相似素材</div><div class="ai-dupes">' + dupCards + '</div>'
          + '<div class="dup-acts"><button class="ai-btn ghost" data-ai-act="similarClear">清空相似结果</button></div></div>'
        : '');

    fillAiThumbs();
    aiSub.textContent = '';
  }

  const aiThumbJobs = [];
  let aiThumbBusy = false;
  function fillAiThumbs() {
    for (const node of aiInner.querySelectorAll('.ap-ava[data-pin], .dup-thumb[data-pin]')) {
      if (node.__thumbQueued) continue;
      node.__thumbQueued = true;
      const p = node.dataset.pin;
      aiThumbJobs.push(async () => {
        const it = S.byPath.get(p) || itemForPath(p);
        const r = await api.thumb(it);
        if (r && r.url && node.isConnected) node.style.backgroundImage = 'url("' + r.url + '")';
        if (node.classList.contains('dup-thumb') && !node.querySelector('.sz-tag') && it) {
          try {
            const m = await api.meta(it);
            if (m && m.size && node.isConnected) {
              const tag = document.createElement('span');
              tag.className = 'sz-tag';
              tag.textContent = fmtSize(m.size);
              node.appendChild(tag);
            }
          } catch { /* ignore */ }
        }
      });
    }
    if (aiThumbBusy) return;
    aiThumbBusy = true;
    (async () => {
      while (aiThumbJobs.length) {
        const job = aiThumbJobs.shift();
        try { await job(); } catch { /* ignore */ }
      }
      aiThumbBusy = false;
    })();
  }

  async function runAI(silent) {
    if (aiState.running) return;
    const todo = (S.items || []).filter((it) => !aiState.tags[it.path]);
    if (!todo.length) {
      if (!silent) toast('当前文件夹已经识别完了');
      if (!(lib.dupGroups || []).length) setTimeout(() => runSimilar(true), 150);
      return;
    }
    aiState.running = true;
    aiState.stop = false;
    aiState.done = 0;
    aiState.total = todo.length;
    renderAI();

    let model;
    try {
      model = await loadFaceModel();
    } catch (err) {
      aiState.running = false;
      renderAI();
      toast('识别模型加载失败：' + ((err && err.message) ? err.message : err));
      return;
    }

    let patch = {};
    try {
      for (const it of todo) {
        if (aiState.stop) break;
        aiState.currentName = it.name;
        const r = await aiTagItem(it, model);
        if (r) {
          aiState.tags[it.path] = r;
          patch[it.path] = r;
        }
        aiState.done += 1;
        if (aiState.done % 4 === 0 || aiState.done === aiState.total) renderAI();
        if (Object.keys(patch).length >= 25) {
          await api.aiSet(patch);
          patch = {};
        }
        await new Promise((r2) => setTimeout(r2, 0));
      }
    } catch (err) {
      toast('识别中断：' + ((err && err.message) ? err.message : err));
    } finally {
      if (Object.keys(patch).length) await api.aiSet(patch);
      aiState.running = false;
      try {
        const cl = clusterFaces();
        if (Object.keys(cl.patch).length) await api.aiSet(cl.patch);
      } catch { /* ignore */ }
      renderAI();
      renderSidebar();
      if (S.mode === 'ai') renderList(true);
      setTimeout(() => { runSimilar(true); }, 200);
    }
  }

  async function runSimilar(silent) {
    if (aiState.simBusy) return;
    aiState.simBusy = true;
    renderAI();
    try {
      const items = (S.items || []).filter((it) => it.kind !== 'audio' && it.kind !== 'doc');
      const sigs = await api.hashItems(items.map((it) => ({
        path: it.path, ext: it.ext, kind: it.kind, size: it.size, mtime: it.mtime, videoPath: it.videoPath || null
      })));
      const groups = clusterSimilar(sigs || []);
      lib.dupGroups = groups.map((g, i) => ({
        id: 'd' + Date.now().toString(36) + i,
        items: g.map((x) => x.path),
        at: Date.now()
      }));
      if (!lib.dupGroups.length && !silent) toast('没有发现明显重复的素材');
      persist();
    } catch (err) {
      toast('分析失败：' + ((err && err.message) || err));
    } finally {
      aiState.simBusy = false;
      renderAI();
      renderSidebar();
    }
  }

  async function openDupAll() {
    if (!S.items || !S.items.length) { toast('先打开一个文件夹'); return; }
    if (!(lib.dupGroups || []).length) { toast('暂无相似素材'); return; }
    openAI(true);
  }

  async function openAI(dupOnly) {
    S.dupOnly = !!dupOnly;
    if (!S.items || !S.items.length) { toast('先打开一个文件夹'); return; }
    showInspector(null);
    if (insMapObj) { try { insMapObj.remove(); } catch { /* ignore */ } insMapObj = null; }
    aiView.hidden = false;
    renderAI();
    try { aiState.tags = (await api.aiGet()) || aiState.tags; } catch { /* ignore */ }
    try { S.aiPeople = (await api.peopleGet()) || {}; } catch { S.aiPeople = {}; }
    renderAI();
    const tagged = (S.items || []).filter((it) => aiState.tags[it.path]).length;
    if (tagged && !(lib.dupGroups || []).length && (S.items || []).length <= 900) runSimilar(true);
  }

  function closeAI() { aiView.hidden = true; S.dupOnly = false; }

  const btnAIEl = $('#btnAI');
  if (btnAIEl) btnAIEl.addEventListener('click', () => openAI());
  $('#aiBack').addEventListener('click', closeAI);

  function openDupThumb(th) {
    const card = th && th.closest('.dup-card');
    let list = null;
    if (card) {
      const gBtn = card.querySelector('[data-group]');
      const g = gBtn && (lib.dupGroups || []).find((x) => x.id === gBtn.dataset.group);
      if (g) list = g.items.map((pp) => S.byPath.get(pp) || itemForPath(pp)).filter(Boolean);
    }
    if (th && th.dataset.pin) openViewer(th.dataset.pin, list);
  }
  aiView.addEventListener('dblclick', (e) => {
    const th = e.target.closest('.dup-thumb[data-pin], .ap-ava[data-pin]');
    if (th) openDupThumb(th);
  });

  aiView.addEventListener('click', async (e) => {
    /* 相似素材：单击直接全屏，关闭全屏后仍回到当前相似页 */
    const th = e.target.closest('.dup-thumb[data-pin], .ap-ava[data-pin]');
    if (th && !e.target.closest('[data-ai-act], button')) { openDupThumb(th); return; }
    const chipBtn = e.target.closest('.ai-chip');
    if (chipBtn) {
      S.mode = 'ai';
      S.payload = { k: chipBtn.dataset.aiK, v: chipBtn.dataset.aiV };
      closeAI();
      S.selected.clear();
      S.active = null;
      showInspector(null);
      renderSidebar();
      renderList(true);
      return;
    }
    const act = e.target.closest('[data-ai-act]');
    if (!act) return;
    const a = act.dataset.aiAct;
    if (a === 'run') { runAI(); return; }
    if (a === 'similar') { runSimilar(); return; }
    if (a === 'similarClear') {
      modalConfirm('清空相似结果', '只是清掉分组记录，不会动任何文件。', '清空', false, () => {
        const keep = lib.dupGroups;
        lib.dupGroups = [];
        for (const g of keep) lib.hidden = lib.hidden.filter((p) => !g.items.includes(p));
        persist(); renderAI(); renderSidebar();
        if (S.mode === 'dupe') { S.mode = 'all'; S.payload = null; }
        renderList(true);
      });
      return;
    }
    if (a === 'renameFace') {
      const fid = act.dataset.face;
      openModal(`<h3>给这个人物起个名字</h3>
        <div class="sub">只在本机做备注，方便搜索和分类。</div>
        <input type="text" id="pName" maxlength="16" value="${escapeHtml(String(S.aiPeople[fid] || ''))}" placeholder="例如：妈妈 / 小林">
        <div class="modal-foot"><button class="btn-ghost" data-act="cancel">取消</button><button class="btn-primary" data-act="ok">保存</button></div>`, (m) => {
        const input = m.querySelector('#pName');
        input.focus();
        const ok = async () => {
          const v = input.value.trim();
          if (!v) { toast('名字不能为空'); return; }
          S.aiPeople[fid] = v;
          await api.peopleSet(S.aiPeople);
          closeModal(); renderAI(); renderSidebar();
          toast('已备注为「' + v + '」');
        };
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ok(); });
        m.querySelector('[data-act="ok"]').addEventListener('click', ok);
        m.querySelector('[data-act="cancel"]').addEventListener('click', closeModal);
      });
      return;
    }
    if (a === 'keepOne' || a === 'keepAll') {
      const gid = act.dataset.group;
      const g = lib.dupGroups.find((x) => x.id === gid);
      if (!g) return;
      if (a === 'keepAll') {
        lib.dupGroups = lib.dupGroups.filter((x) => x.id !== gid);
        lib.hidden = lib.hidden.filter((p) => !g.items.includes(p));
      } else {
        const keep = act.dataset.path;
        for (const p of g.items) {
          if (p === keep) lib.hidden = lib.hidden.filter((x) => x !== p);
          else if (!lib.hidden.includes(p)) lib.hidden.push(p);
        }
        g.keep = keep;
      }
      persist(); renderAI(); renderSidebar(); renderList(true);
      toast(a === 'keepAll' ? '已全部保留' : '已合并，其余暂时隐藏');
      return;
    }
    if (a === 'stop') { aiState.stop = true; return; }
    if (a === 'reset') {
      modalConfirm('清除识别结果', '只删除识别标签，不会影响任何原始照片。', '清除', true, async () => {
        await api.aiClear();
        aiState.tags = {};
        if (S.mode === 'ai') { S.mode = 'all'; S.payload = null; }
        renderSidebar();
        renderList(true);
        renderAI();
      });
    }
  });

  /* 左右侧栏拖拽：改 CSS 变量后同帧重算网格，拖动过程中也实时跟随，不再等松手才补内容 */
  function applySideWidths() {
    const sw = Math.max(180, Math.min(430, Number(lib.settings.sideW) || 244));
    const iw = Math.max(250, Math.min(540, Number(lib.settings.insW) || 320));
    document.documentElement.style.setProperty('--side-w', sw + 'px');
    document.documentElement.style.setProperty('--ins-w', iw + 'px');
  }
  function initSideResize() {
    applySideWidths();
    const bind = (handle, side) => {
      if (!handle) return;
      let sx = 0, sv = 0, on = false, raf = 0;
      const flushLayout = () => {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        layoutGrid();
        renderWindow(true);
      };
      const queueLayout = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (!on) return;
          layoutGrid();
          renderWindow(true);
        });
      };
      handle.addEventListener('pointerdown', (e) => {
        if (S.viewerOpen) return;
        e.preventDefault();
        on = true;
        sx = e.clientX;
        sv = side === 'left'
          ? (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--side-w')) || 244)
          : (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ins-w')) || 320);
        try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        document.body.classList.add('side-resizing');
        handle.classList.add('dragging');
      });
      const move = (e) => {
        if (!on) return;
        const dx = e.clientX - sx;
        const room = innerWidth - 590;
        if (side === 'left') {
          const w = Math.max(180, Math.min(Math.min(430, room), sv + dx));
          lib.settings.sideW = Math.round(w);
          document.documentElement.style.setProperty('--side-w', Math.round(w) + 'px');
        } else {
          const w = Math.max(250, Math.min(Math.min(540, room), sv - dx));
          lib.settings.insW = Math.round(w);
          document.documentElement.style.setProperty('--ins-w', Math.round(w) + 'px');
        }
        queueLayout();
      };
      const end = () => {
        if (!on) return;
        on = false;
        handle.classList.remove('dragging');
        document.body.classList.remove('side-resizing');
        persist();
        flushLayout();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    };
    bind($('#resizeSide'), 'left');
    bind($('#resizeIns'), 'right');
    addEventListener('resize', applySideWidths);
  }
  /* 右侧信息栏折叠 / 展开：状态持久化，折叠后只留贴边开关 */
  function applyInspectorHidden(hidden, quiet) {
    lib.settings = lib.settings || {};
    lib.settings.insHidden = !!hidden;
    document.body.classList.toggle('ins-hidden', !!hidden);
    const btn = $('#insToggle');
    if (btn) {
      btn.title = hidden ? '显示信息栏' : '收起信息栏';
      btn.setAttribute('aria-label', btn.title);
    }
    if (!quiet) {
      requestAnimationFrame(() => {
        layoutGrid();
        renderWindow(true);
      });
    }
  }
  function initWindowControls() {
    const bar = document.getElementById('winControls');
    if (!bar) return;
    const min = document.getElementById('winMin');
    const max = document.getElementById('winMax');
    const close = document.getElementById('winClose');
    if (!api.winMinimize || !api.winToggleMaximize || !api.winClose) {
      bar.hidden = true;
      return;
    }
    const applyState = (st) => {
      const isMax = !!(st && st.maximized);
      bar.classList.toggle('is-max', isMax);
      if (max) {
        max.title = isMax ? '还原窗口' : '最大化';
        max.setAttribute('aria-label', max.title);
      }
    };
    min && min.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); api.winMinimize(); });
    max && max.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      Promise.resolve(api.winToggleMaximize()).then(applyState).catch(() => {});
    });
    close && close.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); api.winClose(); });
    try { Promise.resolve(api.winState()).then(applyState).catch(() => {}); } catch { /* ignore */ }
    try { api.onWinState && api.onWinState(applyState); } catch { /* ignore */ }

    /* 标题栏空白处双击最大化 / 还原；按钮和控件不参与 */
    const tb = document.querySelector('.titlebar');
    if (tb) {
      tb.addEventListener('dblclick', (e) => {
        if (e.target.closest('button, input, .pathchip, .seg, .search-wrap, .brand')) return;
        Promise.resolve(api.winToggleMaximize()).then(applyState).catch(() => {});
      });
    }
  }

  function initInspectorToggle() {
    const btn = $('#insToggle');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hidden = !document.body.classList.contains('ins-hidden');
      applyInspectorHidden(hidden, false);
      persist();
    });
  }
  initInspectorToggle();
  initWindowControls();
  initSideResize();
  boot();
})();
