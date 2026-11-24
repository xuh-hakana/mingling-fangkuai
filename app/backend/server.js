'use strict';
/**
 * 命令方块 · Node 本地服务层
 *
 * 从 server/server.py 移植而来（路由、返回结构、SSE 事件名逐条对齐），
 * 目的是让客户端在 Windows / macOS 上都不依赖 Python。
 * 前端 web/js/app.js 不需要任何改动即可直接连这套接口。
 *
 * 对外：createApp(options) -> App 实例；app.listen(port) -> Promise<port>
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const scanner = require('./scanner');
const { Store } = require('./store');
const { PromptBook, health } = require('./promptbook');

const VERSION_FALLBACK = '0.1.0';
const MAX_BODY_BYTES = 6_000_000;   // v2.5：编辑器要能存回 2 MB 以内的整份文件
const API_PROBE_TIMEOUT = 8000;

function defaultDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'CommandBlock');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'CommandBlock');
  }
  return path.join(os.homedir(), '.config', 'CommandBlock');
}

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function posixNorm(rel) {
  const p = path.posix.normalize(String(rel || '').replace(/\\/g, '/'));
  return p;
}

/**
 * 两次扫描之间「内容变了」的文件。
 * 判据用 mtime + size：内容改动这两个至少变一个，比逐字节比对便宜。
 * 只报旧索引里也有的文件——纯新增文件由「新」标记负责，不重复打点。
 * 上限 200 条，防止一次批量操作把 SSE 帧撑大（前端只用来点小圆点，不需要全量）。
 */
function diffFileState(before, after) {
  const out = [];
  if (!before || !after) return out;
  for (const [rel, meta] of after) {
    const old = before.get(rel);
    if (!old) continue;
    if (old.mtime !== meta.mtime || old.size !== meta.size) {
      out.push(rel);
      if (out.length >= 200) break;
    }
  }
  return out;
}

function loadRelease(appRoot) {
  // 命令方块只发用户向的大更新公告；带需求原文的自动总结公告只在提词器。
  const raw = { version: VERSION_FALLBACK, releases: [] };
  try {
    Object.assign(raw, JSON.parse(fs.readFileSync(path.join(appRoot, '版本公告.json'), 'utf8')));
  } catch (e) { /* 没有公告文件：用兜底 */ }
  return raw;
}

/* 功能↔文件对照：只有 归属表.json 一份，两个客户端都读它。
 * 以 / 结尾的目录前缀在这里展开成真实存在的文件，前端拿到的就是可点开的路径。 */
function ownerPayload(tree) {
  const table = scanner.ownerTable();
  const files = (tree && tree.files) || [];
  const exists = new Set(files.map((f) => String(f.path)));
  const expand = (list) => {
    const out = [];
    for (const item of list || []) {
      const s = String(item || '');
      if (s.endsWith('/')) {
        for (const f of files) if (String(f.path).startsWith(s)) out.push(String(f.path));
      } else if (exists.has(s)) out.push(s);
    }
    return [...new Set(out)];
  };
  return {
    features: (table.features || []).map((f) => Object.assign({}, f, { files: expand(f.files) })),
    editable: scanner.EDITABLE_LIST || [],
  };
}

// ---------------------------------------------------------------------------
// RepoService：当前打开的只读根目录 + 内存扫描状态
// ---------------------------------------------------------------------------
class RepoService {
  constructor(appRoot, dataDir) {
    this.appRoot = path.resolve(appRoot);
    this.dataDir = path.resolve(dataDir);
    this.root = '';
    this.tree = null;
    this.filesByRel = new Map();
    this.baseNames = new Set();
    this.newPaths = new Set();
    this.indexCache = null;
    this.indexSignature = '';
  }

  validateRoot(raw) {
    let text = String(raw == null ? '' : raw).trim();
    if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[0] === text[text.length - 1]) {
      text = text.slice(1, -1);
    }
    if (!text) throw new Error('请填写文件夹路径');
    let expanded = text;
    if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
      expanded = path.join(os.homedir(), text.slice(2));
    }
    let resolved;
    try {
      resolved = fs.realpathSync(expanded);
    } catch (e) {
      throw new Error('文件夹不存在或无权访问');
    }
    if (!fs.statSync(resolved).isDirectory()) throw new Error('这个路径不是文件夹');
    if (path.resolve(resolved) === this.dataDir || inside(resolved, this.dataDir)) {
      throw new Error('命令方块的配置目录含密钥，不能作为浏览根目录');
    }
    return resolved;
  }

  hasRoot() { return !!this.root; }
  rootDisplay() { return this.root || ''; }

  ignoredPaths() {
    const list = [this.dataDir];
    for (const name of ['.data', 'data']) {
      const candidate = path.join(this.appRoot, name);
      try {
        if (fs.existsSync(candidate) && fs.realpathSync(candidate) !== this.dataDir) list.push(fs.realpathSync(candidate));
      } catch (e) { /* 忽略无权访问的目录 */ }
    }
    return list;
  }

  scanLocked() {
    if (!this.root) throw new Error('尚未打开文件夹');
    const result = scanner.scanTree(this.root, this.appRoot, this.ignoredPaths());
    const map = new Map();
    for (const item of result.files) {
      item.new = false;
      map.set(String(item.path), item);
    }
    this.filesByRel = map;
    if (this.baseNames.size) {
      for (const k of [...this.newPaths]) if (!map.has(k)) this.newPaths.delete(k);
      for (const k of map.keys()) if (!this.baseNames.has(k)) this.newPaths.add(k);
    }
    for (const rel of this.newPaths) if (map.has(rel)) map.get(rel).new = true;
    result.files = [...map.keys()].sort().map(k => map.get(k));
    result.newFiles = [...this.newPaths].sort();
    result.newCount = this.newPaths.size;
    result.indexedAt = Date.now();
    return result;
  }

  setRoot(rootPath) {
    this.root = rootPath;
    this.tree = null;
    this.filesByRel = new Map();
    this.baseNames = new Set();
    this.newPaths = new Set();
    this.indexCache = null;
    this.indexSignature = '';
    const result = this.scanLocked();
    this.baseNames = new Set(this.filesByRel.keys());
    this.newPaths = new Set();
    result.newFiles = [];
    result.newCount = 0;
    for (const item of result.files) item.new = false;
    this.tree = result;
    return result;
  }

  getTree(force) {
    if (!this.root) throw new Error('尚未打开文件夹');
    if (force || !this.tree) this.tree = this.scanLocked();
    return this.tree;
  }

  refreshIfChanged() {
    if (!this.root) return { changed: false, tree: null };
    const previous = this.tree ? this.tree.signature : '';
    // 旧索引必须在 scanLocked 覆盖 filesByRel 之前留住，否则没得比。
    const before = this.filesByRel;
    const fresh = this.scanLocked();
    this.tree = fresh;
    if (fresh.signature === previous) return { changed: false, tree: null };
    this.indexCache = null;
    this.indexSignature = '';
    return { changed: true, tree: fresh, changedPaths: diffFileState(before, this.filesByRel) };
  }

  readFile(rel) {
    const norm = posixNorm(rel);
    if (norm === '..' || norm.startsWith('../') || norm.startsWith('/')) {
      const e = new Error('路径越界'); e.code = 'EACCES'; throw e;
    }
    if (!this.filesByRel.has(norm)) {
      if (!this.root) { const e = new Error(norm); e.code = 'ENOENT'; throw e; }
      this.tree = this.scanLocked();
      if (!this.filesByRel.has(norm)) { const e = new Error(norm); e.code = 'ENOENT'; throw e; }
    }
    const meta = this.filesByRel.get(norm);
    const data = scanner.readVisibleFile(this.root, norm, meta);
    data.new = this.newPaths.has(norm);
    return data;
  }

  buildIndex(force) {
    if (!this.root) throw new Error('尚未打开文件夹');
    if (!this.tree) this.tree = this.scanLocked();
    const signature = this.tree.signature;
    if (!force && this.indexCache && this.indexSignature === signature) return this.indexCache;
    const root = this.root;
    const files = [...this.tree.files];
    const result = scanner.buildSymbolIndex(root, files);
    result.signature = signature;
    if (this.root !== root) throw new Error('工作区已切换，请重新加载索引');
    this.indexCache = result;
    this.indexSignature = signature;
    return result;
  }

  acknowledgeNew() {
    this.newPaths = new Set();
    this.baseNames = new Set(this.filesByRel.keys());
    for (const item of this.filesByRel.values()) item.new = false;
    if (this.tree) {
      this.tree.newCount = 0;
      this.tree.newFiles = [];
      for (const item of this.tree.files) item.new = false;
    }
    return { newCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// App：状态容器 + watcher + SSE 广播
// ---------------------------------------------------------------------------
class App {
  constructor(options) {
    const opts = options || {};
    this.verbose = !!opts.verbose;
    this.appRoot = path.resolve(opts.appRoot || path.join(__dirname, '..', '..'));
    this.webDir = path.resolve(opts.webDir || path.join(this.appRoot, 'web'));
    this.dataDir = path.resolve(opts.dataDir || defaultDataDir());
    fs.mkdirSync(this.dataDir, { recursive: true });
    // 两个客户端各自写自己的端口文件：命令方块写 port（虚幻客户端「看原文」靠它），
    // 提词器独立客户端写 port-prompter，互不覆盖。数据目录仍是同一个，需求库共用一份。
    this.portFileName = opts.portFile || 'port';
    // 剪贴板捕获会写需求库，只让提词器那个进程跑，避免两个进程同时写同一份 json。
    this.enablePrompts = opts.enablePrompts !== false;

    this.store = new Store(this.dataDir);
    this.prompts = new PromptBook(this.dataDir, {
      readClipboard: opts.readClipboard,
    });
    this.repo = new RepoService(this.appRoot, this.dataDir);
    this.release = loadRelease(this.appRoot);
    this.sseClients = new Set();
    this.apiStatus = { state: 'unchecked', latency: null, checkedAt: null, message: '尚未检测' };
    this.pickFolder = opts.pickFolder || null;      // Electron 注入：async () => string
    this.onExternalOpen = opts.onExternalOpen || null; // 外部文件被打开时，让主窗口置顶
    this.watcherTimer = null;
    this.server = null;
    this.port = 0;

    this.openInitialRoot(opts.rootOverride);
  }

  openInitialRoot(rootOverride) {
    const candidates = [];
    if (rootOverride) candidates.push(rootOverride);
    const saved = this.store.currentRoot();
    if (saved) candidates.push(saved);
    candidates.push(path.dirname(this.appRoot), this.appRoot);
    for (const candidate of candidates) {
      try {
        const valid = this.repo.validateRoot(candidate);
        this.repo.setRoot(valid);
        this.store.setCurrentRoot(valid);
        return;
      } catch (e) {
        if (this.verbose) console.error('[command-block] 根目录不可用', candidate, e.message);
      }
    }
    if (this.verbose) console.error('[command-block] 没有可读的初始根目录');
  }

  // -- SSE -----------------------------------------------------------------
  broadcast(event, payload) {
    const line = 'event: ' + event + '\ndata: ' + JSON.stringify(payload || {}) + '\n\n';
    for (const res of this.sseClients) {
      try { res.write(line); } catch (e) { /* 客户端断开，下方 close 会清掉 */ }
    }
  }

  startWatcher() {
    const tick = () => {
      const delay = this.sseClients.size ? 2000 : 10000;
      this.watcherTimer = setTimeout(() => {
        try {
          if (this.sseClients.size && this.repo.hasRoot()) {
            const r = this.repo.refreshIfChanged();
            if (r.changed && r.tree) {
              this.broadcast('tree', {
                at: Date.now(),
                signature: r.tree.signature,
                counts: r.tree.counts,
                newCount: r.tree.newCount,
                changed: r.changedPaths || [],
              });
            }
          }
        } catch (e) {
          if (this.verbose) console.error('[command-block] watch', e);
        }
        tick();
      }, delay);
      if (this.watcherTimer.unref) this.watcherTimer.unref();
    };
    tick();
  }

  stop() {
    if (this.watcherTimer) clearTimeout(this.watcherTimer);
    this.watcherTimer = null;
    if (this.enablePrompts) { try { this.prompts.stop(); } catch (e) { /* 忽略 */ } }
    for (const res of this.sseClients) { try { res.end(); } catch (e) {} }
    this.sseClients.clear();
  }

  publicApi() { return Object.assign({}, this.store.publicApiConfig(), { status: Object.assign({}, this.apiStatus) }); }

  async testApi() {
    const cfg = this.store.apiConfig();
    if (!cfg.baseUrl) {
      this.apiStatus = { state: 'unconfigured', latency: null, checkedAt: Date.now(), message: '请先填写 API 地址' };
      return Object.assign({}, this.apiStatus);
    }
    const started = Date.now();
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/models';
    const key = this.store.apiKey();
    const result = { state: 'error', latency: null, checkedAt: Date.now(), message: '' };
    try {
      const target = new URL(url);
      const mod = target.protocol === 'https:' ? https : http;
      await new Promise((resolve, reject) => {
        const req = mod.request(target, {
          method: 'GET',
          headers: Object.assign({ Accept: 'application/json', 'User-Agent': 'CommandBlock/0.1' }, key ? { Authorization: 'Bearer ' + key } : {}),
        }, res => {
          let body = '';
          res.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
          res.on('end', () => {
            const ms = Date.now() - started;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              result.state = 'ok'; result.latency = ms; result.message = '连接正常';
            } else if (res.statusCode === 401 || res.statusCode === 403) {
              result.state = 'unauthorized'; result.latency = ms; result.message = '密钥无效或权限不足';
            } else {
              result.state = 'error'; result.latency = ms; result.message = 'HTTP ' + res.statusCode;
            }
            resolve();
          });
        });
        req.on('error', reject);
        req.setTimeout(API_PROBE_TIMEOUT, () => { const e = new Error('连接超时'); req.destroy(e); });
        req.end();
      });
    } catch (e) {
      result.latency = Date.now() - started;
      result.message = e && e.message ? e.message : '连接失败';
    }
    result.checkedAt = Date.now();
    this.apiStatus = Object.assign({}, result);
    return Object.assign({}, result);
  }

  statePayload() {
    const root = this.repo.rootDisplay();
    const exists = !!(root && fs.existsSync(root) && fs.statSync(root).isDirectory());
    return {
      version: this.release.version || VERSION_FALLBACK,
      appRoot: this.appRoot,
      root: {
        path: root,
        name: root ? path.basename(root) : '',
        exists,
        isAppRoot: !!(root && path.resolve(root) === this.appRoot),
      },
      favorites: root ? this.store.favorites(root) : [],
      notes: root ? this.store.notes(root) : {},
      recent: this.store.recentRoots(),
      api: this.publicApi(),
      safety: {
        readOnly: true,
        excluded: ['.env / 密钥 / 证书', '日志与缓存', '构建产物与依赖目录', '符号链接不跟随', '插件配置数据'],
        dataDir: this.store.dataDirDisplay(),
      },
    };
  }

  treePayload(tree) {
    return Object.assign({}, tree, {
      files: [...(tree.files || [])],
      newFiles: [...(tree.newFiles || [])],
      newCount: Number(tree.newCount || 0),
      rootName: tree.rootName || path.basename(String(tree.root || '')),
    });
  }

  /* 写过文件之后：立刻重扫，并把新树广播出去，文件树/扇形图/计数当场跟上。 */
  afterWrite(res, result, changed) {
    const tree = this.repo.getTree(true);
    this.broadcast('tree', {
      at: Date.now(),
      signature: tree.signature,
      counts: tree.counts,
      newCount: tree.newCount,
      changed: Array.isArray(changed) ? changed : [],
    });
    return this.sendJson(res, Object.assign({ ok: true, owner: ownerPayload(tree) }, result));
  }

  editRoot() {
    if (!this.repo.hasRoot()) throw new Error('尚未打开文件夹');
    return this.repo.root;
  }

  editBackupDir() {
    return path.join(this.dataDir, '编辑备份');
  }

  // -- HTTP ----------------------------------------------------------------
  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', reject);
      server.listen(port || 0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        try { fs.writeFileSync(path.join(this.dataDir, this.portFileName), String(this.port), 'utf8'); } catch (e) {}
        this.startWatcher();
        if (this.enablePrompts) this.prompts.start();
        resolve(this.port);
      });
    });
  }

  close() {
    this.stop();
    try { fs.unlinkSync(path.join(this.dataDir, this.portFileName)); } catch (e) {}
    if (this.server) { try { this.server.close(); } catch (e) {} }
  }

  sendJson(res, payload, status) {
    const body = Buffer.from(JSON.stringify(payload === undefined ? {} : payload), 'utf8');
    res.writeHead(status || 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(reqMethod(res) === 'HEAD' ? undefined : body);
  }

  sendError(res, status, message, code) {
    this.sendJson(res, { error: message, code: code || 'error' }, status);
  }

  hostOk(req) {
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  }

  mutationOk(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const u = new URL(origin);
      return ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
    } catch (e) { return false; }
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { reject(new Error('请求体过大')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 格式不正确')); }
      });
      req.on('error', reject);
    });
  }

  async handle(req, res) {
    if (!this.hostOk(req)) return this.sendError(res, 403, '只允许通过 127.0.0.1 或 localhost 访问', 'host');
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return this.sendError(res, 400, '地址不正确', 'bad_request'); }
    const p = url.pathname;
    const q = url.searchParams;
    try {
      if (req.method === 'GET') return await this.handleGet(req, res, p, q);
      if (req.method === 'HEAD') return await this.handleGet(req, res, p, q, true);
      // PUT / PATCH 与 POST 同义：网页端保存收藏夹用的是 PUT，早期只放行 POST，
      // 结果「保存收藏」一律 405，收藏夹看起来完全不可用。三条一起放行。
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        if (!this.mutationOk(req)) return this.sendError(res, 403, '来源不被允许', 'origin');
        return await this.handlePost(req, res, p);
      }
      return this.sendError(res, 405, '不支持的请求方法', 'method');
    } catch (e) {
      if (this.verbose) console.error('[command-block]', e);
      const msg = e && e.message || '服务器内部错误';
      const known = /格式不正确|路径越界|不正确|不对|不能|上限|请填写|不存在|找不到|同名|超过|空的|不是合法|这个类型|这个目录|不是文件夹|未打开|已切换/.test(msg);
      return this.sendError(res, known ? 400 : 500, known ? msg : '服务器内部错误', known ? 'bad_request' : 'internal');
    }
  }

  async handleGet(req, res, p, q, headOnly) {
    res.__headOnly = !!headOnly;
    if (p === '/api/health') return this.sendJson(res, { ok: true, version: this.release.version || VERSION_FALLBACK, appRoot: this.appRoot, root: this.repo.rootDisplay() });
    if (p === '/api/state') return this.sendJson(res, this.statePayload());
    if (p === '/api/tree') return this.sendJson(res, this.treePayload(this.repo.getTree(q.get('refresh') === '1')));
    if (p === '/api/file') {
      const rel = q.get('path') || '';
      if (!rel) return this.sendError(res, 400, '缺少文件路径', 'missing_path');
      try { return this.sendJson(res, this.repo.readFile(rel)); }
      catch (e) {
        if (e.code === 'EACCES') return this.sendError(res, 403, '路径不在当前文件夹内', 'forbidden');
        return this.sendError(res, 404, '文件不在当前只读镜像中，或已被排除', 'not_found');
      }
    }
    if (p === '/api/index') return this.sendJson(res, this.repo.buildIndex(q.get('refresh') === '1'));
    if (p === '/api/favorites') {
      const root = this.repo.rootDisplay();
      return this.sendJson(res, { root, categories: this.store.favorites(root) });
    }
    if (p === '/api/prompts') return this.sendJson(res, this.prompts.state());
    if (p === '/api/api') return this.sendJson(res, this.publicApi());
    if (p === '/api/new/ack') return this.sendError(res, 405, '请使用 POST', 'method');
    if (p === '/api/release') return this.sendJson(res, this.release);
    if (p === '/api/file-func') return this.sendJson(res, ownerPayload(this.repo.hasRoot() ? this.repo.getTree(false) : null));
    if (p === '/api/events') return this.serveEvents(req, res);
    if (p.startsWith('/api/')) return this.sendError(res, 404, '接口不存在', 'no_route');
    return this.serveStatic(res, p);
  }

  async handlePost(req, res, p) {
    const body = await this.readBody(req);
    if (p === '/api/root') {
      let valid;
      try { valid = this.repo.validateRoot(body.path); }
      catch (e) { return this.sendError(res, 400, e.message, 'invalid_root'); }
      const tree = this.repo.setRoot(valid);
      this.store.setCurrentRoot(valid);
      return this.sendJson(res, { root: valid, tree: this.treePayload(tree), state: this.statePayload() });
    }
    if (p === '/api/rescan') return this.sendJson(res, this.treePayload(this.repo.getTree(true)));
    if (p === '/api/new/ack') return this.sendJson(res, this.repo.acknowledgeNew());
    if (p === '/api/favorites') {
      const root = this.repo.rootDisplay();
      if (!root) return this.sendError(res, 409, '尚未打开文件夹', 'no_root');
      if (body.root && body.root !== root) return this.sendError(res, 409, '工作区已切换，请重新操作收藏夹', 'root_changed');
      const categories = this.store.saveFavorites(root, body.categories);
      return this.sendJson(res, { root, categories });
    }
    if (p === '/api/api') {
      const config = this.store.updateApiConfig(body);
      this.apiStatus = { state: 'unchecked', latency: null, checkedAt: null, message: '配置已保存，等待检测' };
      this.broadcast('api-status', { state: 'unchecked', message: '配置已保存' });
      return this.sendJson(res, Object.assign({}, config, { status: this.publicApi().status }));
    }
    if (p === '/api/api/test') {
      const result = await this.testApi();
      this.broadcast('api-status', result);
      return this.sendJson(res, result);
    }
    if (p === '/api/prompts') return this.sendJson(res, this.prompts.upsert(body));
    if (p === '/api/prompts/check') return this.sendJson(res, { health: health(typeof body.text === 'string' ? body.text : '') });
    if (p === '/api/prompts/delete') return this.sendJson(res, this.prompts.delete(String(body.id || '')));
    if (p === '/api/prompts/accept') return this.sendJson(res, this.prompts.acceptPending(String(body.id || '')));
    if (p === '/api/prompts/dismiss') return this.sendJson(res, this.prompts.dismissPending(String(body.id || '')));
    if (p === '/api/prompts/capture') return this.sendJson(res, { capture: this.prompts.setCapture(body) });
    if (p === '/api/notes') {
      const root = this.repo.rootDisplay();
      if (!root) return this.sendError(res, 409, '尚未打开文件夹', 'no_root');
      return this.sendJson(res, { notes: this.store.saveNote(root, String(body.path || ''), String(body.text || '')) });
    }
    /* ---- v2.5 编辑：保存 / 新建 / 改名 / 删除。四条都走 scanner 的白名单 + 原子写 ---- */
    if (p === '/api/write') {
      const rel = String(body.path || '');
      const r = scanner.writeVisibleFile(this.editRoot(), rel, body.text, this.editBackupDir());
      return this.afterWrite(res, r, [rel]);
    }
    if (p === '/api/create') {
      const dir = String(body.dir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const name = String(body.name || '').trim();
      const ext = String(body.ext || '.md');
      if (!name || !/^[^\\/:*?"<>|]{1,60}$/.test(name)) throw new Error('名字不对：不能带 \\ / : * ? " < > |，60 字以内');
      if (!['.md', '.txt', '.json', '.jsonl'].includes(ext)) throw new Error('只能新建 md / txt / json / jsonl');
      const rel = (dir ? dir + '/' : '') + name + ext;
      const seed = ext === '.json' ? '{}\n' : ext === '.jsonl' ? '' : '# ' + name + '\n';
      const r = scanner.createVisibleFile(this.editRoot(), rel, seed);
      return this.afterWrite(res, r, [rel]);
    }
    if (p === '/api/rename') {
      const rel = String(body.path || '');
      const name = String(body.name || '').trim();
      if (!name || !/^[^\\/:*?"<>|]{1,60}$/.test(name)) throw new Error('名字不对：不能带 \\ / : * ? " < > |，60 字以内');
      const ext = path.posix.extname(rel);
      const dir = path.posix.dirname(rel);
      const newRel = (dir === '.' ? '' : dir + '/') + name + ext;
      const r = scanner.renameVisibleFile(this.editRoot(), rel, newRel, this.editBackupDir());
      return this.afterWrite(res, r, [rel, newRel]);
    }
    if (p === '/api/delete') {
      const rel = String(body.path || '');
      const r = scanner.deleteVisibleFile(this.editRoot(), rel, this.editBackupDir());
      return this.afterWrite(res, r, [rel]);
    }
    if (p === '/api/pick-folder') {
      if (!this.pickFolder) return this.sendJson(res, { cancelled: true, path: '', unsupported: true });
      const picked = await this.pickFolder();
      return this.sendJson(res, picked ? { cancelled: false, path: picked } : { cancelled: true, path: '' });
    }
    if (p === '/api/folder-stats') {
      // 扇形图「可直接拖入」用的：扫描任意外部文件夹，只回文件清单（相对路径 + 字节数）。
      // 只读、排除规则与文件树完全一致，不写、不改、不外传。
      let dir;
      try { dir = fs.realpathSync(String(body.path || '').trim() || '\u0000'); }
      catch (e) { return this.sendError(res, 400, '文件夹不存在或无权访问', 'invalid_folder'); }
      if (!fs.statSync(dir).isDirectory()) return this.sendError(res, 400, '这个路径不是文件夹', 'invalid_folder');
      if (dir === this.dataDir) return this.sendError(res, 400, '命令方块的配置目录含密钥，不能统计', 'forbidden_dir');
      let result;
      try { result = scanner.scanTree(dir, this.appRoot, [this.dataDir]); }
      catch (e) { return this.sendError(res, 400, '这个文件夹读不了：' + (e.message || '无权访问'), 'scan_failed'); }
      let total = 0;
      const files = [];
      for (const item of result.files) {
        total += Number(item.size) || 0;
        files.push({ path: String(item.path), size: Number(item.size) || 0 });
      }
      return this.sendJson(res, {
        path: dir,
        name: path.basename(dir),
        files,
        total,
        count: files.length,
        counts: result.counts,
        excluded: result.excluded,
        truncated: !!result.truncated,
        signature: result.signature,
      });
    }
    /* ---- 外部文件：打开任意本地文件（不限于当前只读根目录），仅读取、不写不改 ---- */
    if (p === '/api/open-external') {
      const abs = String(body.path || '').trim();
      if (!abs) return this.sendError(res, 400, '缺少文件路径', 'missing_path');
      let full;
      try { full = fs.realpathSync(abs); } catch (e) { return this.sendError(res, 400, '文件不存在或无权访问', 'invalid_path'); }
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return this.sendError(res, 404, '这不是一个可读文件', 'not_file');
      if (inside(full, this.dataDir)) return this.sendError(res, 403, '配置目录里的文件不能打开', 'forbidden');
      // dataDir 可能是软链（如 /tmp → /private/tmp），realpath 后再比一次，确保配置目录里的密钥不被打开
      let dataDirReal = this.dataDir;
      try { dataDirReal = fs.realpathSync(this.dataDir); } catch (e) {}
      if (inside(full, dataDirReal)) return this.sendError(res, 403, '配置目录里的文件不能打开', 'forbidden');
      const size = fs.statSync(full).size;
      // 只读预览的体量上限要比「编辑保存」宽得多：WorkBuddy 会话 .jsonl 动辄 10MB+。
      // 先用 64MB 兜底；超过 12MB 只读头部 12MB（按整行截断）并标记 truncated，避免整文件进内存。
      const MAX_PREVIEW = 64 * 1024 * 1024;
      const PREVIEW_HEAD = 12 * 1024 * 1024;
      if (size > MAX_PREVIEW) return this.sendError(res, 413, '文件超过 ' + (MAX_PREVIEW / 1e6) + ' MB，命令方块不预览这么大的文件', 'too_large');
      const ext = path.extname(full).toLowerCase();
      const langMap = { '.md': 'markdown', '.markdown': 'markdown', '.txt': 'text', '.rst': 'text', '.json': 'json', '.jsonl': 'json', '.jsonc': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.ini': 'ini', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript', '.py': 'python', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.html': 'html', '.css': 'css', '.xml': 'xml', '.sql': 'sql', '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.lua': 'lua' };
      const language = langMap[ext] || 'text';
      let content = '', binary = false, truncated = false;
      try {
        if (size > PREVIEW_HEAD) {
          const fd = fs.openSync(full, 'r');
          const buf = Buffer.alloc(PREVIEW_HEAD);
          const n = fs.readSync(fd, buf, 0, PREVIEW_HEAD, 0);
          fs.closeSync(fd);
          content = buf.slice(0, n).toString('utf8');
          const cut = content.lastIndexOf('\n');       // 砍掉半行，避免最后一行是残句
          if (cut > 0) content = content.slice(0, cut + 1);
          truncated = true;
        } else {
          content = fs.readFileSync(full, 'utf8');
        }
      } catch (e) { binary = true; }
      if (!binary && content.includes(' ')) binary = true;
      const lines = binary ? 0 : content.split('\n').length;
      const payload = { ok: true, path: full, name: path.basename(full), size, language, lines, binary, external: true, truncated, content: binary ? '' : content, mtime: fs.statSync(full).mtimeMs || 0 };
      this.broadcast('external-open', payload);
      if (this.onExternalOpen) { try { this.onExternalOpen(); } catch (e) {} }
      return this.sendJson(res, payload);
    }
    if (p === '/api/focus') {
      // 虚幻客户端「看原文」复用窗口的入口，语义与 Python 版一致。
      let rel = String(body.path || '').trim();
      if (!rel) return this.sendError(res, 400, '缺少文件路径', 'missing_path');
      rel = posixNorm(rel);
      if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) return this.sendError(res, 400, '路径越界', 'bad_path');
      const root = this.repo.root;
      if (!root) return this.sendError(res, 409, '尚未打开文件夹', 'no_root');
      let full;
      try { full = fs.realpathSync(path.join(root, rel)); } catch (e) { full = ''; }
      if (!full || full === root || !inside(full, root) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return this.sendError(res, 404, '文件不在当前根目录内或不存在', 'not_found');
      }
      let line = 0;
      try { line = Math.floor(Number(body.line || 0)) || 0; } catch (e) { line = 0; }
      this.broadcast('focus', { path: rel, line });
      return this.sendJson(res, { ok: true, path: rel, line });
    }
    return this.sendError(res, 404, '接口不存在', 'no_route');
  }

  serveEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2500\n\n');
    res.write('event: hello\ndata: {"ok":true}\n\n');
    this.sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    if (ping.unref) ping.unref();
    req.on('close', () => { clearInterval(ping); this.sseClients.delete(res); });
  }

  serveStatic(res, urlPath) {
    let rel;
    try { rel = decodeURIComponent(urlPath.replace(/^\/+/, '')); } catch (e) { rel = ''; }
    if (!rel) rel = 'index.html';
    if (rel.indexOf('\0') !== -1) return this.sendError(res, 400, '非法路径', 'bad_path');
    const candidate = path.resolve(this.webDir, rel);
    if (!inside(candidate, this.webDir) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      return this.sendError(res, 404, '页面不存在', 'not_found');
    }
    const ext = path.extname(candidate).toLowerCase();
    const mimeMap = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
      '.md': 'text/markdown; charset=utf-8',
    };
    const body = fs.readFileSync(candidate);
    res.writeHead(200, {
      'Content-Type': mimeMap[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // img-src 允许 blob:：raindrop-fx 用 URL.createObjectURL 载入内嵌雨滴法线纹理，
      // 缺这一项会让图片 onload 永不触发、雨效动画永远起不来。
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(res.__headOnly ? undefined : body);
  }
}

function reqMethod(res) { return res.req ? res.req.method : 'GET'; }

function createApp(options) { return new App(options); }

module.exports = { createApp, App, RepoService, defaultDataDir, VERSION_FALLBACK };

// 允许 `node app/backend/server.js --port 8809 --root <dir>` 独立跑（验证/调试用）。
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const app = createApp({
    rootOverride: get('--root', ''),
    dataDir: get('--data-dir', '') || undefined,
    portFile: get('--port-file', '') || undefined,
    verbose: argv.includes('--verbose'),
  });
  app.listen(Number(get('--port', 0)) || 0).then(port => {
    console.log('[command-block] http://127.0.0.1:' + port + '  root=' + app.repo.rootDisplay());
  }).catch(e => { console.error('启动失败：' + e.message); process.exit(1); });
}
