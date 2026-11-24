'use strict';
/**
 * 提词器 · 独立客户端主进程（Windows / macOS 通用）
 *
 * 这是一个独立的客户端进程：单独双击 提词器.app 就能开，命令方块没开也能用，
 * 关掉命令方块不影响它。它不再是从命令方块里开出来的第二个网页窗口。
 *
 * 与命令方块的分工：
 *   端口文件   port-prompter（命令方块写 port，虚幻客户端「看原文」仍走那一个）
 *   窗口数据   ~/Library/Application Support/CommandBlockPrompter（独立缓存）
 *   需求库     ~/Library/Application Support/CommandBlock（共用同一份，不搬家、不复制）
 *   剪贴板捕获 只在这个进程跑，避免两个进程同时写需求库 json
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu } = require('electron');
const { createApp, defaultDataDir } = require('./backend/server');

const APP_ROOT = path.resolve(__dirname, '..');   // app/ 的上一级 = 命令方块/
const IS_MAC = process.platform === 'darwin';
const DATA_DIR = defaultDataDir();
const PORT_FILE = 'port-prompter';
const HOME = os.homedir();
const USER_DATA = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'CommandBlockPrompter')
  : IS_MAC ? path.join(HOME, 'Library', 'Application Support', 'CommandBlockPrompter')
    : path.join(HOME, '.config', 'CommandBlockPrompter');
const LOG_FILE = process.platform === 'win32'
  ? path.join(DATA_DIR, '提词器.log')
  : IS_MAC ? path.join(HOME, 'Library', 'Logs', 'CommandBlock-Prompter.log')
    : path.join(USER_DATA, 'prompter.log');

// 独立缓存目录，和命令方块区分开（必须在 ready 之前设）。
app.setPath('userData', USER_DATA);

let backend = null;
let mainWin = null;
let port = 0;

function log(line) {
  const text = '[' + new Date().toISOString() + '] ' + line + '\n';
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, text); } catch (e) {}
  if (process.env.CB_VERBOSE) console.log(text.trim());
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1000,
    height: 740,
    minWidth: 720,
    minHeight: 520,
    title: '提词器',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 14, y: 16 } : undefined,
    backgroundColor: '#F3F6FB',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWin.loadURL('http://127.0.0.1:' + port + '/?app=prompter&platform=' + process.platform);
  mainWin.once('ready-to-show', () => { mainWin.show(); mainWin.focus(); log('提词器窗口已显示'); });
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  return mainWin;
}

// ---------------------------------------------------------------------------
// IPC：和命令方块同一套 preload，四个能力都补齐
// ---------------------------------------------------------------------------
ipcMain.handle('cb:info', () => ({
  port,
  platform: process.platform,
  appRoot: APP_ROOT,
  version: app.getVersion(),
}));

ipcMain.handle('cb:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWin, {
    title: '选择要只读浏览的文件夹',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '打开这个文件夹',
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('cb:readClipboard', () => {
  try { return clipboard.readText() || ''; } catch (e) { return ''; }
});

// 关联文件在独立客户端里没有文件视图，点了就在系统文件管理器里定位。
ipcMain.handle('cb:reveal', (event, rel) => {
  try {
    const root = backend ? backend.repo.rootDisplay() : '';
    if (!root || !rel) return { ok: false };
    const abs = path.resolve(root, String(rel));
    if (!abs.startsWith(root + path.sep)) return { ok: false };
    shell.showItemInFolder(abs);
    return { ok: true };
  } catch (e) { return { ok: false }; }
});

// ---------------------------------------------------------------------------
// 启动：单实例也用端口文件判断，不用 Electron 的 SingletonLock（强杀会留陈旧锁）
// ---------------------------------------------------------------------------
function cbHttp(portNum, method, route) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: portNum, path: route, method },
      res => { res.resume(); res.on('end', () => resolve({ ok: res.statusCode === 200 })); });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(900, () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

async function runningPort() {
  let p = 0;
  try { p = Number(fs.readFileSync(path.join(DATA_DIR, PORT_FILE), 'utf8').trim()) || 0; } catch (e) { return 0; }
  if (!p) return 0;
  const r = await cbHttp(p, 'GET', '/api/health');
  return r.ok ? p : 0;
}

app.whenReady().then(async () => {
  if (Menu.setApplicationMenu) Menu.setApplicationMenu(null);

  const existing = await runningPort();
  if (existing) {
    log('提词器已在运行 port=' + existing + '，本次不再开第二个窗口');
    app.quit();
    return;
  }

  try {
    backend = createApp({
      appRoot: APP_ROOT,
      webDir: path.join(APP_ROOT, 'web'),
      dataDir: DATA_DIR,
      portFile: PORT_FILE,
      enablePrompts: true,
      rootOverride: process.env.CB_ROOT || '',
      verbose: !!process.env.CB_VERBOSE,
      pickFolder: async () => {
        const result = await dialog.showOpenDialog(mainWin, {
          title: '选择要只读浏览的文件夹',
          properties: ['openDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
      },
      readClipboard: async () => { try { return clipboard.readText() || ''; } catch (e) { return ''; } },
    });
    port = await backend.listen(0);
    log('服务已启动 port=' + port + ' root=' + backend.repo.rootDisplay());
  } catch (e) {
    log('启动失败：' + (e && e.stack || e));
    dialog.showErrorBox('提词器启动失败', String(e && e.message || e));
    app.quit();
    return;
  }

  createMainWindow();
});

// 独立客户端关掉窗口就整个退出，不在后台常驻。
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (backend) { try { backend.close(); } catch (e) {} }
  log('提词器退出');
});
