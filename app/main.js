'use strict';
/**
 * 命令方块 · Electron 主进程（Windows / macOS 通用）
 *
 * 取代旧的 Objective-C + WKWebView 启动器；Python 服务换成 app/backend/server.js。
 * 所有数据仍落在 ~/Library/Application Support/CommandBlock（win 为 %APPDATA%/CommandBlock），
 * 端口文件 port 保持不变，虚幻客户端「看原文」的 /api/focus 链路继续可用。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu } = require('electron');
const { createApp } = require('./backend/server');

// 项目根：源码形态在 app/ 上一级；打包形态在 .app/Contents/Resources/bundle/ 内。
function resolveAppRoot() {
  const has = dir => {
    try {
      return fs.existsSync(path.join(dir, 'web', 'index.html')) && fs.existsSync(path.join(dir, '版本公告.json'));
    } catch (e) { return false; }
  };
  if (process.env.CB_APP_ROOT && has(process.env.CB_APP_ROOT)) return process.env.CB_APP_ROOT;
  for (const start of [__dirname, process.cwd()]) {
    let dir = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      if (has(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.join(os.homedir(), 'Documents', 'xuhuan mac', '命令方块');
}

const APP_ROOT = resolveAppRoot();
const IS_MAC = process.platform === 'darwin';
// 日志必须写在 bundle 之外：写进 .app 会破坏签名，且打包后可能没权限。
const LOG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'CommandBlock')
  : IS_MAC ? path.join(os.homedir(), 'Library', 'Logs') : path.join(os.homedir(), '.config', 'CommandBlock');
const LOG_FILE = path.join(LOG_DIR, 'CommandBlock.log');

function log(line) {
  const text = '[' + new Date().toISOString() + '] ' + line + '\n';
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, text); } catch (e) {}
  if (process.env.CB_VERBOSE) console.log(text.trim());
}

let backend = null;
let mainWin = null;
let port = 0;
let initialFocus = null;   // 从 COMMAND_BLOCK_HASH 解析出来的首次定位

function parseInitialHash() {
  const raw = process.env.COMMAND_BLOCK_HASH || '';
  if (!raw || raw.charAt(0) !== '#') return null;
  const q = raw.indexOf('?');
  if (q < 0) return null;
  try {
    const params = new URLSearchParams(raw.slice(q + 1));
    const p = params.get('path');
    if (!p) return null;
    return { path: p, line: Number(params.get('line') || 0) || 0 };
  } catch (e) { return null; }
}

function windowOptions(extra) {
  return Object.assign({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0E1320',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  }, extra || {});
}

function createMainWindow() {
  mainWin = new BrowserWindow(windowOptions({
    title: '命令方块',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 14, y: 16 } : undefined,
  }));
  mainWin.loadURL('http://127.0.0.1:' + port + '/?platform=' + process.platform);
  // mac 用 hiddenInset 标题栏，交通灯浮在页面左上；由主进程注入留白，
  // 不依赖 preload（沙箱配置下 preload 里读平台不一定可靠）。
  if (IS_MAC) {
    mainWin.webContents.on('dom-ready', () => {
      try { mainWin.webContents.insertCSS('html .topbar { padding-left: 92px !important; }'); } catch (e) {}
    });
  }
  mainWin.once('ready-to-show', () => { mainWin.show(); mainWin.focus(); });
  // 把文件夹拖进窗口时，Chromium 默认会导航到 file:// 目录页，整页会被替换掉。
  // 扇形图要接管拖放，所以这里禁止任何导航（本地服务的页面也不会自己跳）。
  mainWin.webContents.on('will-navigate', (event) => { event.preventDefault(); });
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  return mainWin;
}

// 提词器不在这里开窗口：它是单独一个 提词器.app（独立进程、可双击）。
// 本文件只负责命令方块的窗口与「看原文」链路。

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('cb:info', () => ({
  port,
  platform: process.platform,
  appRoot: APP_ROOT,
  version: app.getVersion(),
}));

ipcMain.handle('cb:pickFolder', async () => {
  const parent = mainWin;
  const result = await dialog.showOpenDialog(parent, {
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

// 渲染层的 navigator.clipboard.writeText 在文档未聚焦时会被 Chromium 直接拒绝
// （"Document is not focused"），切窗口、点别处再回来都可能踩到。
// 走主进程写，不受焦点影响，也不会静默失败。
ipcMain.handle('cb:writeClipboard', (event, text) => {
  try {
    clipboard.writeText(String(text == null ? '' : text));
    return true;
  } catch (e) {
    return false;
  }
});

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
// 启动
// ---------------------------------------------------------------------------
// 单实例判断不用 Electron 的 userData 锁：进程被强杀后会留下陈旧 SingletonLock，
// 下一次双击会直接静默退出。改用端口文件 + /api/health，和虚幻客户端「看原文」同一套。
const { defaultDataDir } = require('./backend/server');

function cbHttp(portNum, method, route, body) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: portNum, path: route, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, res => { res.resume(); res.on('end', () => resolve({ ok: res.statusCode === 200 })); });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(900, () => { req.destroy(); resolve({ ok: false }); });
    if (data) req.write(data);
    req.end();
  });
}

async function runningPort() {
  let p = 0;
  try { p = Number(fs.readFileSync(path.join(defaultDataDir(), 'port'), 'utf8').trim()) || 0; } catch (e) { return 0; }
  if (!p) return 0;
  const r = await cbHttp(p, 'GET', '/api/health');
  return r.ok ? p : 0;
}

app.whenReady().then(async () => {
    if (Menu.setApplicationMenu) Menu.setApplicationMenu(null);
    initialFocus = parseInitialHash();

    const existing = await runningPort();
    if (existing) {
      // 已经开着：把定位交给那个窗口，然后本进程安静退出，不新开窗口。
      if (initialFocus) await cbHttp(existing, 'POST', '/api/focus', { path: initialFocus.path, line: initialFocus.line || 0 });
      log('已有实例在跑 port=' + existing + '，本次不开新窗口');
      app.quit();
      return;
    }

    try {
      backend = createApp({
        appRoot: APP_ROOT,
        webDir: path.join(APP_ROOT, 'web'),
        rootOverride: process.env.CB_ROOT || '',
        verbose: !!process.env.CB_VERBOSE,
        // 需求库由提词器独立客户端独占读写；这个进程只保留接口，不跑捕获轮询。
        enablePrompts: false,
        onExternalOpen: () => { try { if (mainWin && !mainWin.isDestroyed()) mainWin.focus(); } catch (e) {} },
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
      dialog.showErrorBox('命令方块启动失败', String(e && e.message || e));
      app.quit();
      return;
    }

    createMainWindow();

    // 首次由「看原文」唤起时，带上定位：等页面加载完再广播 focus。
    if (initialFocus && mainWin) {
      mainWin.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          try {
            const rel = String(initialFocus.path).replace(/\\/g, '/');
            const root = backend.repo.rootDisplay();
            const r = path.relative(root, path.resolve(root, rel));
            if (r && !r.startsWith('..') && !path.isAbsolute(r)) {
              backend.broadcast('focus', { path: r.split(path.sep).join('/'), line: initialFocus.line || 0 });
            }
          } catch (e) { log('初始定位失败：' + e.message); }
        }, 400);
      });
    }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});

app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
app.on('before-quit', () => {
  if (backend) { try { backend.close(); } catch (e) {} }
  log('客户端退出');
});
