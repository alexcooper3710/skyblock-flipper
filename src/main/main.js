'use strict';
// Electron shell. The engine runs in this process; the renderer is a dumb view
// so a slow repaint can never delay a snapshot read.

process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const { app, BrowserWindow, ipcMain, clipboard, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const store = require('./store');
const { Flipper } = require('./engine/poller');

let win = null;
let tray = null;
let engine = null;
let cfg = null;
let recent = [];   // newest flips first, for the copy hotkeys

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startEngine() {
  if (engine) engine.stop();
  engine = new Flipper(cfg);
  engine.on('flips', (flips) => {
    recent = [...flips, ...recent].slice(0, 200);
    send('flips', flips);
  });
  engine.on('bazaar', (b) => send('bazaar', b));
  engine.on('stats', (s) => send('stats', s));
  engine.on('log', (l) => send('log', l));
  engine.start();
}

function copyFlip(index) {
  const flip = recent[index];
  if (!flip) return;
  clipboard.writeText(flip.command);
  send('copied', { index, uuid: flip.uuid, name: flip.name });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d1017',
    title: 'SkyBlock Flipper',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => send('config', cfg));
}

app.whenReady().then(() => {
  cfg = store.load(app.getPath('userData'));
  createWindow();
  startEngine();

  // Copy the Nth newest flip without leaving Minecraft. This is the whole
  // ergonomic point: alt-tab costs more than the flip is worth.
  for (let i = 1; i <= 5; i++) {
    globalShortcut.register(`CommandOrControl+Alt+${i}`, () => copyFlip(i - 1));
  }

  try {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip('SkyBlock Flipper');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show', click: () => win && win.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
  } catch { /* tray is a nicety, not a requirement */ }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text || '')); return true; });
ipcMain.handle('get-config', () => cfg);
ipcMain.handle('set-config', (_e, patch) => {
  cfg = { ...cfg, ...patch };
  store.save(app.getPath('userData'), cfg);
  if (engine) engine.cfg = cfg;
  return cfg;
});
ipcMain.handle('restart-engine', () => { startEngine(); return true; });

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
