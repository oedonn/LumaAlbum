'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('album', {
  pickFolder: (start) => ipcRenderer.invoke('album:pickFolder', start || ''),
  pickArchive: () => ipcRenderer.invoke('album:pickArchive'),
  listDir: (p, opts) => ipcRenderer.invoke('album:listDir', p, opts || {}),
  hiddenPaths: (paths) => ipcRenderer.invoke('album:hiddenPaths', paths || []),
  scan: (root, opts) => ipcRenderer.invoke('album:scan', root, opts),
  thumb: (item) => ipcRenderer.invoke('album:thumb', item),
  meta: (item) => ipcRenderer.invoke('album:meta', item),
  libraryGet: () => ipcRenderer.invoke('album:library:get'),
  librarySet: (data) => ipcRenderer.invoke('album:library:set', data),
  exists: (paths) => ipcRenderer.invoke('album:exists', paths),
  reveal: (p) => ipcRenderer.invoke('album:reveal', p),
  openExternal: (p) => ipcRenderer.invoke('album:openExternal', p),
  openFolder: (p) => ipcRenderer.invoke('album:openFolder', p),
  openUrl: (u) => ipcRenderer.invoke('album:openUrl', u),
  place: (gps) => ipcRenderer.invoke('album:place', gps),
  exportItems: (items) => ipcRenderer.invoke('album:export', items),
  cacheClear: () => ipcRenderer.invoke('album:cacheClear'),
  cacheSize: () => ipcRenderer.invoke('album:cacheSize'),
  appInfo: () => ipcRenderer.invoke('album:appInfo'),
  setFullscreen: (flag) => ipcRenderer.invoke('album:fullscreen', flag),
  setTitleBarTheme: (night) => ipcRenderer.invoke('album:titlebarTheme', !!night),
  winMinimize: () => ipcRenderer.send('album:winMinimize'),
  winToggleMaximize: () => ipcRenderer.invoke('album:winToggleMaximize'),
  winClose: () => ipcRenderer.send('album:winClose'),
  winState: () => ipcRenderer.invoke('album:winState'),
  onWinState: (cb) => {
    const h = (e, payload) => cb(payload);
    ipcRenderer.on('album:winState', h);
    return () => ipcRenderer.removeListener('album:winState', h);
  },
  renameFile: (p, name) => ipcRenderer.invoke('album:renameFile', p, name),
  updateInfo: (payload) => ipcRenderer.invoke('album:updateInfo', payload),
  copyFiles: (paths, dest) => ipcRenderer.invoke('album:copyFiles', paths, dest),
  sample: (item) => ipcRenderer.invoke('album:sample', item),
  prepareVideo: (item) => ipcRenderer.invoke('album:prepareVideo', item),
  prepareImage: (item) => ipcRenderer.invoke('album:prepareImage', item),
  aiGet: () => ipcRenderer.invoke('album:aiGet'),
  aiSet: (patch) => ipcRenderer.invoke('album:aiSet', patch),
  aiClear: () => ipcRenderer.invoke('album:aiClear'),
  hashItems: (items) => ipcRenderer.invoke('album:hash', items),
  move: (paths, dest, extra) => ipcRenderer.invoke('album:move', Object.assign({ paths, dest }, extra || {})),
  del: (payload) => ipcRenderer.invoke('album:delete', payload),
  clipboardFiles: () => ipcRenderer.invoke('album:clipboardFiles'),
  clipboardSetFiles: (paths) => ipcRenderer.invoke('album:clipboardSetFiles', paths),
  geocode: (q) => ipcRenderer.invoke('album:geocode', q),
  recycleList: () => ipcRenderer.invoke('album:recycleList'),
  recycleRestore: (ids) => ipcRenderer.invoke('album:recycleRestore', ids),
  recycleClear: () => ipcRenderer.invoke('album:recycleClear'),
  readText: (p) => ipcRenderer.invoke('album:text', p),
  previewDoc: (p) => ipcRenderer.invoke('album:previewDoc', p),
  peopleGet: () => ipcRenderer.invoke('album:peopleGet'),
  peopleSet: (data) => ipcRenderer.invoke('album:peopleSet', data),
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  onScanProgress: (cb) => {
    const h = (e, payload) => cb(payload);
    ipcRenderer.on('scan:progress', h);
    return () => ipcRenderer.removeListener('scan:progress', h);
  }
});
