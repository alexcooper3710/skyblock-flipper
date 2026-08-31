'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flipper', {
  on: (channel, cb) => {
    const allowed = ['flips', 'bazaar', 'stats', 'log', 'config', 'copied'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
  copy: (text) => ipcRenderer.invoke('copy', text),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  restart: () => ipcRenderer.invoke('restart-engine'),
});
