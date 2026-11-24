'use strict';
/**
 * 只读扫描器 · 从 server/scanner.py 移植到 Node。
 *
 * 存在的理由：命令方块要同时跑在 win/mac。Python 版在 macOS 上要装 Xcode
 * 命令行工具、Windows 上根本没有 python3，所以数据层改用 Electron 自带的
 * Node。对外字段与 Python 版保持一致，前端 web/js/app.js 不用改。
 *
 * v2.5 起分两种模式：
 *   默认（只读镜像）：stat / readdir / readFile，一个字节都不写——文件树、索引、扇形图都走这里。
 *   显式编辑（web 端点「编辑→保存」才调用）：写之前先备份，原子替换，且只许改可编辑的文本文件。
 *   两条路共用同一套排除规则（密钥、二进制、构建目录一律不碰）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILES = 12000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const INDEX_FILE_LIMIT = 900;
const INDEX_FILE_BYTES = 384 * 1024;
const SYMBOL_LIMIT_PER_FILE = 500;
const INDEX_TRUNCATED_SYMBOLS = 6000;

const EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', '.idea', '.vscode', 'node_modules', '__pycache__',
  '.venv', 'venv', 'env', '.env', 'dist', 'build', 'out', 'target', 'coverage',
  '.coverage', '.next', '.nuxt', '.cache', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', '.turbo', '.parcel-cache', '.svelte-kit', '.dart_tool',
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.password-store',
  '.terraform', 'logs', 'log', '.DS_Store',
]);

const EXCLUDED_FILE_NAMES = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '.npmrc', '.pypirc', '.netrc',
  '.git-credentials', 'credentials.json', 'secrets.json', 'secret.json',
]);

const EXCLUDED_SUFFIXES = [
  '.log', '.pyc', '.pyo', '.class', '.o', '.a', '.so', '.dylib', '.dll', '.exe',
  '.bin', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.mp3', '.mp4',
  '.mov', '.wav', '.ttf', '.otf', '.woff', '.woff2', '.eot', '.sqlite',
  '.sqlite3', '.db', '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore',
];

/* 可编辑的文本后缀。白名单之外一律不给存（图片/二进制/密钥本来也不在文件树里）。 */
const EDITABLE_SUFFIXES = new Set([
  '.md', '.markdown', '.txt', '.rst', '.adoc', '.json', '.jsonl', '.jsonc',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.csv', '.tsv',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.css', '.scss', '.html', '.htm',
  '.py', '.sh', '.bash', '.zsh', '.command', '.bat', '.xml', '.svg', '.sql',
]);
/* 归属表从 归属表.json 读，只有这一份（功能页↔源文件对照 + 可编辑后缀）。 */
const OWNER_TABLE = path.join(__dirname, '..', '..', '归属表.json');

const LANGUAGE_BY_SUFFIX = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.pyw': 'python', '.json': 'json', '.jsonc': 'json',
  '.md': 'markdown', '.mdx': 'markdown', '.markdown': 'markdown',
  '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css',
  '.html': 'html', '.htm': 'html', '.vue': 'html', '.svelte': 'html',
  '.xml': 'xml', '.plist': 'xml', '.svg': 'xml',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml',
  '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.properties': 'ini',
  '.sql': 'sql', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
  '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.lua': 'lua',
  '.r': 'r', '.pl': 'perl', '.ex': 'elixir', '.exs': 'elixir',
  '.txt': 'text', '.rst': 'text', '.adoc': 'text', '.csv': 'csv', '.tsv': 'csv',
};

const LANGUAGE_BY_NAME = {
  dockerfile: 'docker', makefile: 'make', procfile: 'text',
  gemfile: 'ruby', rakefile: 'ruby',
};

const KIND_BY_LANGUAGE = {
  javascript: 'code', typescript: 'code', python: 'code', shell: 'code',
  sql: 'code', go: 'code', rust: 'code', java: 'code', c: 'code', cpp: 'code',
  csharp: 'code', ruby: 'code', php: 'code', swift: 'code', kotlin: 'code',
  scala: 'code', lua: 'code', r: 'code', perl: 'code', elixir: 'code',
  docker: 'code', make: 'code', css: 'code', html: 'code',
  markdown: 'docs', text: 'docs', json: 'config', yaml: 'config',
  toml: 'config', ini: 'config', xml: 'config', csv: 'data',
};

const METHOD_BLACKLIST = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'constructor',
]);

const JS_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.json'];
const JS_INDEX = ['/index.js', '/index.ts', '/index.jsx', '/index.tsx', '/index.mjs', '/index.cjs'];

function isSecretName(name) {
  const lower = String(name).toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (EXCLUDED_FILE_NAMES.has(lower)) return true;
  if (lower.startsWith('id_rsa') || lower.startsWith('id_ed25519')) return true;
  return EXCLUDED_SUFFIXES.some((s) => lower.endsWith(s));
}

function isIgnoredDir(name) {
  return EXCLUDED_DIRS.has(name) || EXCLUDED_DIRS.has(String(name).toLowerCase());
}

function languageFor(name, suffix) {
  const lower = String(name).toLowerCase();
  if (LANGUAGE_BY_NAME[lower]) return LANGUAGE_BY_NAME[lower];
  if (lower.startsWith('dockerfile')) return 'docker';
  return LANGUAGE_BY_SUFFIX[suffix] || (suffix ? 'other' : 'text');
}

function kindFor(language, suffix) {
  if (KIND_BY_LANGUAGE[language]) return KIND_BY_LANGUAGE[language];
  if (['.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf'].includes(suffix)) return 'config';
  return 'other';
}

function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

/** 扫描一棵目录树。返回结构与 Python 版 scan_tree 一致。 */
function scanTree(root, appRoot, ignoredPaths = []) {
  const absRoot = path.resolve(root);
  const absAppRoot = path.resolve(appRoot);
  const ignored = ignoredPaths.filter(Boolean).map((p) => path.resolve(p));
  const files = [];
  let excludedDirs = 0;
  let excludedFiles = 0;
  let skippedSymlinks = 0;
  let dirCount = 0;
  let truncated = false;
  const hash = crypto.createHash('sha1');
  const started = Date.now();

  const stack = [[absRoot, '']];
  while (stack.length && !truncated) {
    const [directory, relDir] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => {
      const da = a.isDirectory() ? 0 : 1;
      const db = b.isDirectory() ? 0 : 1;
      return da - db || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) { skippedSymlinks += 1; continue; }
      const rel = relDir ? relDir + '/' + entry.name : entry.name;
      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) { excludedDirs += 1; continue; }
        let resolved;
        try { resolved = fs.realpathSync(full); } catch { continue; }
        if (ignored.some((p) => resolved === p || isWithin(resolved, p))) {
          excludedDirs += 1;
          continue;
        }
        dirCount += 1;
        stack.push([full, rel]);
        continue;
      }

      if (isSecretName(entry.name)) { excludedFiles += 1; continue; }
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      const suffix = path.extname(entry.name).toLowerCase();
      const language = languageFor(entry.name, suffix);
      const kind = kindFor(language, suffix);
      const meta = {
        path: rel,
        name: entry.name,
        dir: relDir,
        ext: suffix,
        language,
        kind,
        size: st.size,
        // 保留亚毫秒精度：Python 版用 ns//1e6，Node 的 mtimeMs 是浮点毫秒。
        // 返回整数毫秒给前端，但签名用完整浮点，避免同毫秒内两次写入漏检。
        mtime: Math.floor(st.mtimeMs),
        mtimeExact: st.mtimeMs,
        self: isWithin(fs.realpathSync(full), absAppRoot) || fs.realpathSync(full) === absAppRoot,
      };
      delete meta.mtimeExact;
      files.push(meta);
      hash.update(`${rel}\0${meta.size}\0${st.mtimeMs}\0`, 'utf8');
      if (files.length >= MAX_FILES) { truncated = true; break; }
    }
  }

  files.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  hash.update(`dirs:${dirCount}\0excluded:${excludedDirs}:${excludedFiles}`, 'utf8');
  const selfCount = files.filter((f) => f.self).length;
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  return {
    root: absRoot,
    rootName: path.basename(absRoot) || absRoot,
    appRoot: absAppRoot,
    files,
    counts: {
      files: files.length,
      dirs: dirCount,
      bytes: totalBytes,
      self: selfCount,
      project: files.length - selfCount,
      code: files.filter((f) => f.kind === 'code').length,
      docs: files.filter((f) => f.kind === 'docs').length,
      config: files.filter((f) => f.kind === 'config').length,
      other: files.filter((f) => !['code', 'docs', 'config'].includes(f.kind)).length,
    },
    excluded: { dirs: excludedDirs, files: excludedFiles, symlinks: skippedSymlinks },
    truncated,
    signature: hash.digest('hex'),
    scanMs: Date.now() - started,
  };
}

/**
 * 符号正则。Python 的 \w 默认匹配 Unicode，JS 的 \w 只认 ASCII。
 * 取舍：这里统一用 [A-Za-z0-9_] 保持与 Python 对 ASCII 标识符的行为一致，
 * 中文标识符在本项目里不存在；若以后出现，再换成 /u + \p{L}\p{N}_。
 */
const SYMBOL_CACHE = new Map();
function symbolPatterns(language) {
  if (SYMBOL_CACHE.has(language)) return SYMBOL_CACHE.get(language);
  let list = [];
  const m = (source, kind) => [new RegExp(source), kind];
  if (language === 'python') {
    list = [
      m('^\\s*(?:async\\s+)?def\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(', 'function'),
      m('^\\s*class\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*[:\\(]', 'class'),
    ];
  } else if (language === 'javascript' || language === 'typescript') {
    list = [
      m('^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+([A-Za-z_$][A-Za-z0-9_$]*)', 'function'),
      m('^\\s*(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][A-Za-z0-9_$]*)\\s*=>', 'function'),
      m('^\\s*(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:async\\s*)?function\\b', 'function'),
      m('^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+([A-Za-z_$][A-Za-z0-9_$]*)', 'class'),
      m('^\\s{2,}(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|get\\s+|set\\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\([^)]*\\)\\s*\\{', 'method'),
    ];
  } else if (language === 'go') {
    list = [
      m('^\\s*func\\s+(?:\\([^)]*\\)\\s*)?([A-Za-z_][A-Za-z0-9_]*)\\s*\\(', 'function'),
      m('^\\s*type\\s+([A-Za-z_][A-Za-z0-9_]*)\\s+(?:struct|interface)\\b', 'type'),
    ];
  } else if (language === 'rust') {
    list = [
      m('^\\s*(?:pub\\s+)?(?:async\\s+)?(?:unsafe\\s+)?fn\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*[<(]', 'function'),
      m('^\\s*(?:pub\\s+)?(?:struct|enum|trait)\\s+([A-Za-z_][A-Za-z0-9_]*)', 'type'),
      m('^\\s*impl(?:<[^>]*>)?\\s+([A-Za-z_][A-Za-z0-9_]*)', 'impl'),
    ];
  } else if (['java', 'csharp', 'kotlin', 'scala'].includes(language)) {
    list = [
      m('^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+|final\\s+|abstract\\s+|async\\s+|override\\s+|suspend\\s+)*(?:class|interface|enum|record)\\s+([A-Za-z_][A-Za-z0-9_]*)', 'class'),
      m('^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+|final\\s+|abstract\\s+|async\\s+|override\\s+|suspend\\s+)*[A-Za-z_][A-Za-z0-9_<>\\[\\], ?]*\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\([^;]*\\)\\s*(?:\\{|throws\\b)', 'method'),
    ];
  } else if (language === 'ruby') {
    list = [
      m('^\\s*def\\s+(?:self\\.)?([A-Za-z_][A-Za-z0-9_]*[!?=]?)', 'function'),
      m('^\\s*(?:class|module)\\s+([A-Za-z_][A-Za-z0-9_]*)', 'class'),
    ];
  } else if (language === 'php') {
    list = [
      m('^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+|final\\s+|abstract\\s+)*function\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(', 'function'),
      m('^\\s*(?:final\\s+|abstract\\s+)?(?:class|interface|trait)\\s+([A-Za-z_][A-Za-z0-9_]*)', 'class'),
    ];
  } else if (language === 'shell') {
    list = [m('^\\s*(?:function\\s+)?([A-Za-z_][A-Za-z0-9_-]*)\\s*\\(\\)\\s*\\{?', 'function')];
  } else if (language === 'markdown') {
    list = [m('^(#{1,4})\\s+(.+?)\\s*$', 'section')];
  } else if (language === 'c' || language === 'cpp') {
    list = [
      m('^\\s*(?:static\\s+|inline\\s+|extern\\s+|const\\s+)*[A-Za-z_][A-Za-z0-9_ \\t*&:<>,]*\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\([^;]*\\)\\s*\\{?', 'function'),
      m('^\\s*(?:typedef\\s+)?(?:struct|class|enum|union)\\s+([A-Za-z_][A-Za-z0-9_]*)', 'type'),
    ];
  } else if (language === 'swift') {
    list = [
      m('^\\s*(?:public\\s+|private\\s+|internal\\s+|static\\s+|override\\s+|@\\w+\\s+)*func\\s+([A-Za-z_][A-Za-z0-9_]*)', 'function'),
      m('^\\s*(?:public\\s+|private\\s+|internal\\s+)*(?:class|struct|enum|protocol|extension)\\s+([A-Za-z_][A-Za-z0-9_]*)', 'type'),
    ];
  } else if (language === 'lua') {
    list = [m('^\\s*(?:local\\s+)?function\\s+([A-Za-z_][A-Za-z0-9_.:]*)', 'function')];
  }
  SYMBOL_CACHE.set(language, list);
  return list;
}

function extractSymbols(rel, language, text) {
  const symbols = [];
  const seen = new Set();
  const patterns = symbolPatterns(language);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineno = i + 1;
    for (const [pattern, kind] of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      let name = String(match[1] || '').trim();
      if (kind === 'section') {
        name = String(match[2] || '').trim().replace(/#/g, '').trim().slice(0, 80) || `第 ${lineno} 行`;
      }
      if (!name || METHOD_BLACKLIST.has(name)) continue;
      const key = `${name}:${lineno}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({
        id: crypto.createHash('sha1').update(`${rel}:${lineno}:${name}`).digest('hex').slice(0, 10),
        name,
        kind,
        file: rel,
        line: lineno,
        language,
        detail: line.trim().slice(0, 160),
      });
      if (symbols.length >= SYMBOL_LIMIT_PER_FILE) return symbols;
      break; // 每行只取第一个匹配的 pattern，与 Python 版 break 一致
    }
  }
  return symbols;
}

const JS_IMPORT_PATTERNS = [
  /^\s*import\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/,
  /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];
const PY_REL_IMPORT = /^\s*from\s+(\.+)([A-Za-z_][A-Za-z0-9_.]*)?\s+import\b/;

function resolveJs(rel, spec, relSet) {
  const dir = path.posix.dirname(rel);
  const base = path.posix.normalize(dir === '.' ? spec : path.posix.join(dir, spec));
  if (base.startsWith('../') || base === '..' || base.startsWith('/')) return null;
  const candidates = JS_SUFFIXES.map((s) => base + s).concat(JS_INDEX.map((s) => base + s));
  return candidates.find((c) => relSet.has(c)) || null;
}

function resolvePython(rel, dots, module, relSet) {
  const parts = path.posix.dirname(rel) ? path.posix.dirname(rel).split('/') : [];
  for (let i = 0; i < Math.max(0, dots.length - 1); i += 1) {
    if (!parts.length) return null;
    parts.pop();
  }
  const base = parts.join('/');
  if (!module) {
    const candidate = base ? base + '/__init__.py' : '__init__.py';
    return relSet.has(candidate) ? candidate : null;
  }
  const stem = base ? base + '/' + module.replace(/\./g, '/') : module.replace(/\./g, '/');
  return [stem + '.py', stem + '/__init__.py', stem + '.pyi'].find((c) => relSet.has(c)) || null;
}

function buildSymbolIndex(root, files) {
  const absRoot = path.resolve(root);
  const relSet = new Set(files.map((f) => String(f.path)));
  let codeFiles = files.filter(
    (f) => (f.kind === 'code' || f.language === 'markdown') && Number(f.size) <= INDEX_FILE_BYTES,
  );
  let truncated = codeFiles.length > INDEX_FILE_LIMIT;
  codeFiles = codeFiles.slice(0, INDEX_FILE_LIMIT);

  const symbols = [];
  let refsTotal = 0;
  let indexedFiles = 0;
  const missing = [];
  const missingSeen = new Set();

  for (const meta of codeFiles) {
    const rel = String(meta.path);
    const language = String(meta.language);
    let text;
    try {
      const buf = Buffer.alloc(INDEX_FILE_BYTES);
      const fd = fs.openSync(path.join(absRoot, rel), 'r');
      const n = fs.readSync(fd, buf, 0, INDEX_FILE_BYTES, 0);
      fs.closeSync(fd);
      text = buf.subarray(0, n).toString('utf8');
    } catch { continue; }
    if (!text) continue;
    indexedFiles += 1;

    for (const symbol of extractSymbols(rel, language, text)) {
      if (symbols.length >= INDEX_TRUNCATED_SYMBOLS) { truncated = true; break; }
      symbols.push(symbol);
    }
    if (symbols.length >= INDEX_TRUNCATED_SYMBOLS) break;

    const lines = text.split(/\r?\n/);
    if (language === 'javascript' || language === 'typescript') {
      for (let i = 0; i < lines.length; i += 1) {
        for (const pattern of JS_IMPORT_PATTERNS) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(lines[i])) !== null) {
            const spec = match[1];
            if (!spec.startsWith('.')) { if (!pattern.global) break; continue; }
            refsTotal += 1;
            const resolved = resolveJs(rel, spec, relSet);
            const key = `${rel}:${spec}:${i + 1}`;
            if (resolved === null && !missingSeen.has(key) && missing.length < 100) {
              missingSeen.add(key);
              missing.push({
                file: rel, line: i + 1, spec,
                target: path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)),
                language,
              });
            }
            if (!pattern.global) break;
          }
        }
      }
    } else if (language === 'python') {
      for (let i = 0; i < lines.length; i += 1) {
        const match = PY_REL_IMPORT.exec(lines[i]);
        if (!match) continue;
        refsTotal += 1;
        const dots = match[1];
        const module = match[2];
        const resolved = resolvePython(rel, dots, module, relSet);
        const key = `${rel}:${dots}${module || ''}:${i + 1}`;
        if (resolved === null && module && !missingSeen.has(key) && missing.length < 100) {
          missingSeen.add(key);
          missing.push({
            file: rel, line: i + 1, spec: dots + module,
            target: dots + module.replace(/\./g, '/'), language,
          });
        }
      }
    }
  }

  const priority = { function: 0, class: 1, method: 2, type: 3, impl: 4, section: 5 };
  symbols.sort((a, b) =>
    (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9)
    || String(a.file).localeCompare(String(b.file))
    || (a.line - b.line));
  return {
    symbols,
    symbolsTotal: symbols.length,
    filesIndexed: indexedFiles,
    refsTotal,
    missing,
    missingTotal: missing.length,
    truncated,
    limits: { files: INDEX_FILE_LIMIT, bytes: INDEX_FILE_BYTES },
  };
}

function readVisibleFile(root, rel, meta) {
  const absRoot = path.resolve(root);
  const candidate = path.resolve(absRoot, rel);
  if (!isWithin(candidate, absRoot) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new Error('ENOENT:' + rel);
  }
  const size = Number(meta.size || 0);
  let raw;
  const fd = fs.openSync(candidate, 'r');
  try {
    const buf = Buffer.alloc(Math.min(MAX_FILE_BYTES, Math.max(size, 0) || MAX_FILE_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    raw = buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
  const binary = raw.subarray(0, 8192).includes(0);
  const truncated = size > MAX_FILE_BYTES;
  let content = '';
  if (!binary) {
    content = raw.toString('utf8');
    if (content.startsWith('\ufeff')) content = content.slice(1);
  }
  return {
    path: rel,
    content,
    size,
    mtime: Math.floor(Number(meta.mtime || 0)),
    language: meta.language || 'text',
    kind: meta.kind || 'other',
    binary,
    truncated,
    lines: binary ? 0 : (content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length),
  };
}

// ---------------------------------------------------------------------------
// 编辑（v2.5）：只有界面上显式点「保存 / 新建 / 改名 / 删除」才会走到这里。
// 读文件树、功能索引、扇形图一律不碰这些函数。
// ---------------------------------------------------------------------------

function ownerTable() {
  try { return JSON.parse(fs.readFileSync(OWNER_TABLE, 'utf8')); }
  catch (e) { return { features: [] }; }
}

function editTarget(root, rel) {
  const p = String(rel || '').replace(/\\/g, '/');
  if (!p || p.startsWith('/') || path.posix.normalize(p).startsWith('..')) throw new Error('路径不对');
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, p);
  if (!isWithin(abs, absRoot)) throw new Error('路径越界');
  const parts = p.split('/');
  // .app 包、密钥目录、构建产物一律不给写（与只读扫描同一套排除规则）
  if (parts.some(seg => seg.endsWith('.app') || isIgnoredDir(seg))) throw new Error('这个目录不能改');
  if (isSecretName(parts[parts.length - 1])) throw new Error('这个文件不能改（密钥或二进制）');
  if (!EDITABLE_SUFFIXES.has(path.extname(p).toLowerCase())) throw new Error('这个类型不能改（只读白名单之外的文件）');
  return abs;
}

function validateText(rel, raw) {
  const text = String(raw == null ? '' : raw);
  const suffix = path.extname(rel).toLowerCase();
  if (suffix === '.json') {
    try { JSON.parse(text); } catch (e) { throw new Error('JSON 格式不对，没保存：' + e.message); }
  } else if (suffix === '.jsonl') {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].trim()) continue;
      try { JSON.parse(lines[i]); } catch (e) { throw new Error('第 ' + (i + 1) + ' 行不是合法 JSON，没保存'); }
    }
  }
  return text;
}

function backupBefore(abs, backupDir, rel) {
  if (!backupDir || !fs.existsSync(abs)) return '';
  const day = new Date().toISOString().slice(0, 10);
  const clean = String(rel).replace(/[\\/]+/g, '_');
  const dest = path.join(backupDir, day, clean + '.' + Date.now() + '.bak');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(abs, dest);
  return dest;
}

/* 原子写：先写临时文件再 rename，断电/中途失败都不会留下半截 JSON。 */
function atomicWrite(abs, text) {
  const tmp = abs + '.cb-tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, abs);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* rename 成功后临时文件已不存在 */ }
  }
}

function writeVisibleFile(root, rel, raw, backupDir) {
  const abs = editTarget(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('找不到这个文件：' + rel);
  const oldSize = fs.statSync(abs).size;
  // 读也只读前 2 MB：超过这个数还允许存，等于把后半截悄悄删掉，必须拦住。
  if (oldSize > MAX_FILE_BYTES) throw new Error('文件超过 2 MB，不许存（编辑器只读到前 2 MB，存回去会截掉后半截）');
  const text = validateText(rel, raw);
  if (!text.trim() && oldSize > 0) throw new Error('这次存的是空的，不给覆盖（原文件还有 ' + oldSize + ' 字节）');
  const backup = backupBefore(abs, backupDir, rel);
  atomicWrite(abs, text);
  return { ok: true, backup, size: Buffer.byteLength(text, 'utf8') };
}

function createVisibleFile(root, rel, raw) {
  const abs = editTarget(root, rel);
  if (fs.existsSync(abs)) throw new Error('已经有同名文件了');
  const text = validateText(rel, raw);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  atomicWrite(abs, text);
  return { ok: true, path: String(rel).replace(/\\/g, '/') };
}

function renameVisibleFile(root, rel, newRel, backupDir) {
  const abs = editTarget(root, rel);
  const dest = editTarget(root, newRel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('找不到这个文件：' + rel);
  if (fs.existsSync(dest)) throw new Error('已经有同名文件了');
  const backup = backupBefore(abs, backupDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(abs, dest);
  return { ok: true, path: String(newRel).replace(/\\/g, '/'), backup };
}

function deleteVisibleFile(root, rel, backupDir) {
  const abs = editTarget(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('找不到这个文件：' + rel);
  const backup = backupBefore(abs, backupDir, rel);
  fs.unlinkSync(abs);
  return { ok: true, backup };
}

module.exports = {
  isSecretName, isIgnoredDir, isWithin, ownerTable,
  EDITABLE_LIST: [...EDITABLE_SUFFIXES],
  scanTree, extractSymbols, buildSymbolIndex, readVisibleFile,
  writeVisibleFile, createVisibleFile, renameVisibleFile, deleteVisibleFile,
  MAX_FILE_BYTES,
};
