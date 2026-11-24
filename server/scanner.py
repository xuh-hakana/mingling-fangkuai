"""Read-only project scanner, symbol index and local-reference checker.

The scanner never writes to the project being inspected. It walks the selected
folder without following symlinks, filters secrets/logs/build output, and keeps
enough metadata for the browser UI to render a live mirror.
"""

from __future__ import annotations

import hashlib
import os
import posixpath
import re
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

MAX_FILES = 12000
MAX_FILE_BYTES = 2 * 1024 * 1024
INDEX_FILE_LIMIT = 900
INDEX_FILE_BYTES = 384 * 1024

EXCLUDED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "env",
    ".env",
    "dist",
    "build",
    "out",
    "target",
    "coverage",
    ".coverage",
    ".next",
    ".nuxt",
    ".cache",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".turbo",
    ".parcel-cache",
    ".svelte-kit",
    ".dart_tool",
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".azure",
    ".password-store",
    ".terraform",
    "logs",
    "log",
    ".DS_Store",
}

EXCLUDED_FILE_NAMES = {
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
    "credentials.json",
    "secrets.json",
    "secret.json",
}

EXCLUDED_SUFFIXES = {
    ".log",
    ".pyc",
    ".pyo",
    ".class",
    ".o",
    ".a",
    ".so",
    ".dylib",
    ".dll",
    ".exe",
    ".bin",
    ".zip",
    ".tar",
    ".gz",
    ".tgz",
    ".bz2",
    ".xz",
    ".7z",
    ".rar",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".mp3",
    ".mp4",
    ".mov",
    ".wav",
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
    ".eot",
    ".sqlite",
    ".sqlite3",
    ".db",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".jks",
    ".keystore",
}

LANGUAGE_BY_SUFFIX = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "typescript",
    ".py": "python",
    ".pyw": "python",
    ".json": "json",
    ".jsonc": "json",
    ".md": "markdown",
    ".mdx": "markdown",
    ".markdown": "markdown",
    ".css": "css",
    ".scss": "css",
    ".sass": "css",
    ".less": "css",
    ".html": "html",
    ".htm": "html",
    ".vue": "html",
    ".svelte": "html",
    ".xml": "xml",
    ".plist": "xml",
    ".svg": "xml",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".fish": "shell",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".ini": "ini",
    ".cfg": "ini",
    ".conf": "ini",
    ".properties": "ini",
    ".sql": "sql",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".scala": "scala",
    ".lua": "lua",
    ".r": "r",
    ".pl": "perl",
    ".ex": "elixir",
    ".exs": "elixir",
    ".txt": "text",
    ".rst": "text",
    ".adoc": "text",
    ".csv": "csv",
    ".tsv": "csv",
}

LANGUAGE_BY_NAME = {
    "dockerfile": "docker",
    "makefile": "make",
    "procfile": "text",
    "gemfile": "ruby",
    "rakefile": "ruby",
}

KIND_BY_LANGUAGE = {
    "javascript": "code",
    "typescript": "code",
    "python": "code",
    "shell": "code",
    "sql": "code",
    "go": "code",
    "rust": "code",
    "java": "code",
    "c": "code",
    "cpp": "code",
    "csharp": "code",
    "ruby": "code",
    "php": "code",
    "swift": "code",
    "kotlin": "code",
    "scala": "code",
    "lua": "code",
    "r": "code",
    "perl": "code",
    "elixir": "code",
    "docker": "code",
    "make": "code",
    "css": "code",
    "html": "code",
    "markdown": "docs",
    "text": "docs",
    "json": "config",
    "yaml": "config",
    "toml": "config",
    "ini": "config",
    "xml": "config",
    "csv": "data",
}

CODE_LANGUAGES = {
    "javascript",
    "typescript",
    "python",
    "shell",
    "sql",
    "go",
    "rust",
    "java",
    "c",
    "cpp",
    "csharp",
    "ruby",
    "php",
    "swift",
    "kotlin",
    "scala",
    "lua",
    "r",
    "perl",
    "elixir",
}

SYMBOL_LIMIT_PER_FILE = 500
INDEX_TRUNCATED_SYMBOLS = 6000


def is_secret_name(name: str) -> bool:
    lower = name.lower()
    if lower == ".env" or lower.startswith(".env."):
        return True
    if lower in EXCLUDED_FILE_NAMES:
        return True
    if lower.startswith("id_rsa") or lower.startswith("id_ed25519"):
        return True
    if lower.endswith(tuple(EXCLUDED_SUFFIXES)):
        return True
    return False


def is_ignored_dir(name: str) -> bool:
    return name in EXCLUDED_DIRS or name.lower() in EXCLUDED_DIRS


def _language_for(name: str, suffix: str) -> str:
    lower = name.lower()
    if lower in LANGUAGE_BY_NAME:
        return LANGUAGE_BY_NAME[lower]
    if lower.startswith("dockerfile"):
        return "docker"
    return LANGUAGE_BY_SUFFIX.get(suffix, "text" if not suffix else "other")


def _kind_for(language: str, suffix: str) -> str:
    if language in KIND_BY_LANGUAGE:
        return KIND_BY_LANGUAGE[language]
    if suffix in {".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf"}:
        return "config"
    return "other"


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _safe_rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _entry_is_symlink(entry: os.DirEntry) -> bool:
    try:
        return entry.is_symlink()
    except OSError:
        return True


def scan_tree(
    root: Path,
    app_root: Path,
    ignored_paths: Optional[Iterable[Path]] = None,
) -> Dict[str, object]:
    """Walk *root* and return a serialisable, read-only file inventory."""
    root = root.resolve()
    app_root = app_root.resolve()
    ignored = {p.resolve() for p in (ignored_paths or []) if p}
    files: List[Dict[str, object]] = []
    excluded_dirs = 0
    excluded_files = 0
    skipped_symlinks = 0
    dir_count = 0
    truncated = False
    signature = hashlib.sha1()
    started = time.time()

    stack: List[Tuple[Path, str]] = [(root, "")]
    while stack:
        directory, rel_dir = stack.pop()
        try:
            with os.scandir(directory) as scan:
                entries = list(scan)

            def sort_key(entry: os.DirEntry) -> Tuple[int, str]:
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                except OSError:
                    is_dir = False
                return (0 if is_dir else 1, entry.name.lower())

            entries.sort(key=sort_key)
        except (OSError, PermissionError):
            continue

        for entry in entries:
            if _entry_is_symlink(entry):
                skipped_symlinks += 1
                continue
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            rel = posixpath.join(rel_dir, entry.name) if rel_dir else entry.name
            full = Path(entry.path)

            if is_dir:
                if is_ignored_dir(entry.name):
                    excluded_dirs += 1
                    continue
                try:
                    resolved = full.resolve()
                except OSError:
                    continue
                if any(_is_within(resolved, ignored_path) or resolved == ignored_path for ignored_path in ignored):
                    excluded_dirs += 1
                    continue
                dir_count += 1
                stack.append((full, rel))
                continue

            if is_secret_name(entry.name):
                excluded_files += 1
                continue
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if not os.path.isfile(entry.path):
                continue
            suffix = Path(entry.name).suffix.lower()
            language = _language_for(entry.name, suffix)
            kind = _kind_for(language, suffix)
            meta: Dict[str, object] = {
                "path": rel,
                "name": entry.name,
                "dir": rel_dir,
                "ext": suffix,
                "language": language,
                "kind": kind,
                "size": int(st.st_size),
                "mtime": int(st.st_mtime_ns // 1_000_000),
                "self": _is_within(full.resolve(), app_root),
            }
            files.append(meta)
            signature.update(
                f"{rel}\0{meta['size']}\0{meta['mtime']}\0".encode("utf-8", "replace")
            )
            if len(files) >= MAX_FILES:
                truncated = True
                stack.clear()
                break
        if truncated:
            break

    files.sort(key=lambda item: str(item["path"]).lower())
    signature.update(f"dirs:{dir_count}\0excluded:{excluded_dirs}:{excluded_files}".encode())
    self_count = sum(1 for f in files if f["self"])
    total_bytes = sum(int(f["size"]) for f in files)
    return {
        "root": str(root),
        "rootName": root.name or str(root),
        "appRoot": str(app_root),
        "files": files,
        "counts": {
            "files": len(files),
            "dirs": dir_count,
            "bytes": total_bytes,
            "self": self_count,
            "project": len(files) - self_count,
            "code": sum(1 for f in files if f["kind"] == "code"),
            "docs": sum(1 for f in files if f["kind"] == "docs"),
            "config": sum(1 for f in files if f["kind"] == "config"),
            "other": sum(1 for f in files if f["kind"] not in {"code", "docs", "config"}),
        },
        "excluded": {
            "dirs": excluded_dirs,
            "files": excluded_files,
            "symlinks": skipped_symlinks,
        },
        "truncated": truncated,
        "signature": signature.hexdigest(),
        "scanMs": int((time.time() - started) * 1000),
    }


# ---------------------------------------------------------------------------
# Symbols
# ---------------------------------------------------------------------------


def _symbol_patterns(language: str) -> List[Tuple[re.Pattern, str]]:
    if language == "python":
        return [
            (re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\("), "function"),
            (re.compile(r"^\s*class\s+([A-Za-z_]\w*)\s*[:\(]"), "class"),
        ]
    if language in {"javascript", "typescript"}:
        return [
            (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"), "function"),
            (re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>"), "function"),
            (re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b"), "function"),
            (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)"), "class"),
            (re.compile(r"^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{"), "method"),
        ]
    if language in {"go"}:
        return [
            (re.compile(r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\("), "function"),
            (re.compile(r"^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b"), "type"),
        ]
    if language == "rust":
        return [
            (re.compile(r"^\s*(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]"), "function"),
            (re.compile(r"^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)"), "type"),
            (re.compile(r"^\s*impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)"), "impl"),
        ]
    if language in {"java", "csharp", "kotlin", "scala"}:
        return [
            (re.compile(r"^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|async\s+|override\s+|suspend\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)"), "class"),
            (re.compile(r"^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|async\s+|override\s+|suspend\s+)*[A-Za-z_][\w<>\[\], ?]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|throws\b)"), "method"),
        ]
    if language in {"ruby"}:
        return [
            (re.compile(r"^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)"), "function"),
            (re.compile(r"^\s*(?:class|module)\s+([A-Za-z_]\w*)"), "class"),
        ]
    if language in {"php"}:
        return [
            (re.compile(r"^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+)*function\s+([A-Za-z_]\w*)\s*\("), "function"),
            (re.compile(r"^\s*(?:final\s+|abstract\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)"), "class"),
        ]
    if language in {"shell"}:
        return [
            (re.compile(r"^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?"), "function"),
        ]
    if language == "markdown":
        return [
            (re.compile(r"^(#{1,4})\s+(.+?)\s*$"), "section"),
        ]
    if language in {"c", "cpp"}:
        return [
            (re.compile(r"^\s*(?:static\s+|inline\s+|extern\s+|const\s+)*[A-Za-z_][\w \t\*&:<>,]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?"), "function"),
            (re.compile(r"^\s*(?:typedef\s+)?(?:struct|class|enum|union)\s+([A-Za-z_]\w*)"), "type"),
        ]
    if language == "swift":
        return [
            (re.compile(r"^\s*(?:public\s+|private\s+|internal\s+|static\s+|override\s+|@\w+\s+)*func\s+([A-Za-z_]\w*)"), "function"),
            (re.compile(r"^\s*(?:public\s+|private\s+|internal\s+)*(?:class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)"), "type"),
        ]
    if language == "lua":
        return [
            (re.compile(r"^\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)"), "function"),
        ]
    return []


METHOD_BLACKLIST = {
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "function",
    "return",
    "with",
    "constructor",
}


def extract_symbols(rel: str, language: str, text: str) -> List[Dict[str, object]]:
    symbols: List[Dict[str, object]] = []
    seen: Set[Tuple[str, int]] = set()
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.rstrip("\n")
        for pattern, kind in _symbol_patterns(language):
            match = pattern.match(line)
            if not match:
                continue
            name = match.group(1).strip()
            if kind == "section":
                content = match.group(2).strip().replace("#", "").strip()
                name = content[:80] or f"第 {lineno} 行"
                if not name:
                    continue
            if not name or name in METHOD_BLACKLIST:
                continue
            key = (name, lineno)
            if key in seen:
                continue
            seen.add(key)
            digest = hashlib.sha1(f"{rel}:{lineno}:{name}".encode()).hexdigest()[:10]
            symbols.append(
                {
                    "id": digest,
                    "name": name,
                    "kind": kind,
                    "file": rel,
                    "line": lineno,
                    "language": language,
                    "detail": line.strip()[:160],
                }
            )
            if len(symbols) >= SYMBOL_LIMIT_PER_FILE:
                return symbols
            break
    return symbols


# ---------------------------------------------------------------------------
# Relative imports
# ---------------------------------------------------------------------------

JS_IMPORT_PATTERNS = [
    re.compile(r"""^\s*import\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']"""),
    re.compile(r"""^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']"""),
    re.compile(r"""\brequire\s*\(\s*["']([^"']+)["']\s*\)"""),
    re.compile(r"""\bimport\s*\(\s*["']([^"']+)["']\s*\)"""),
]
PY_REL_IMPORT = re.compile(r"^\s*from\s+(\.+)([A-Za-z_][\w.]*)?\s+import\b")
JS_SUFFIXES = ["", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".json"]
JS_INDEX = ["/index.js", "/index.ts", "/index.jsx", "/index.tsx", "/index.mjs", "/index.cjs"]


def _read_for_index(path: Path) -> str:
    try:
        data = path.read_bytes()[:INDEX_FILE_BYTES]
        return data.decode("utf-8", "replace")
    except OSError:
        return ""


def _resolve_js(rel: str, spec: str, rel_set: Set[str]) -> Optional[str]:
    base = posixpath.normpath(posixpath.join(posixpath.dirname(rel), spec))
    if base.startswith("../") or base == ".." or base.startswith("/"):
        return None
    candidates = [base + suffix for suffix in JS_SUFFIXES]
    candidates.extend(base + index for index in JS_INDEX)
    for candidate in candidates:
        if candidate in rel_set:
            return candidate
    return None


def _resolve_python(rel: str, dots: str, module: Optional[str], rel_set: Set[str]) -> Optional[str]:
    level = len(dots)
    base_parts = posixpath.dirname(rel).split("/") if posixpath.dirname(rel) else []
    for _ in range(max(0, level - 1)):
        if not base_parts:
            return None
        base_parts.pop()
    base = "/".join(base_parts)
    if not module:
        # `from . import name` is valid for namespace packages even without
        # __init__.py, so only check when an __init__ file exists in view.
        candidate = posixpath.join(base, "__init__.py") if base else "__init__.py"
        return candidate if candidate in rel_set else None
    module_path = module.replace(".", "/")
    stem = posixpath.join(base, module_path) if base else module_path
    for candidate in (stem + ".py", stem + "/__init__.py", stem + ".pyi"):
        if candidate in rel_set:
            return candidate
    return None


def build_symbol_index(root: Path, files: Sequence[Dict[str, object]]) -> Dict[str, object]:
    """Read visible source files and build the function / reference index."""
    root = root.resolve()
    rel_set = {str(f["path"]) for f in files}
    code_files = [
        f
        for f in files
        if (f["kind"] == "code" or f["language"] == "markdown")
        and int(f["size"]) <= INDEX_FILE_BYTES
    ]
    truncated = len(code_files) > INDEX_FILE_LIMIT
    code_files = code_files[:INDEX_FILE_LIMIT]

    symbols: List[Dict[str, object]] = []
    refs_total = 0
    missing: List[Dict[str, object]] = []
    missing_seen: Set[Tuple[str, str, int]] = set()
    indexed_files = 0

    for meta in code_files:
        rel = str(meta["path"])
        language = str(meta["language"])
        text = _read_for_index(root / Path(rel))
        if not text:
            continue
        indexed_files += 1
        for symbol in extract_symbols(rel, language, text):
            if len(symbols) >= INDEX_TRUNCATED_SYMBOLS:
                truncated = True
                break
            symbols.append(symbol)
        if len(symbols) >= INDEX_TRUNCATED_SYMBOLS:
            break

        if language in {"javascript", "typescript"}:
            for lineno, line in enumerate(text.splitlines(), start=1):
                for pattern in JS_IMPORT_PATTERNS:
                    for match in pattern.finditer(line):
                        spec = match.group(1)
                        if not spec.startswith("."):
                            continue
                        refs_total += 1
                        resolved = _resolve_js(rel, spec, rel_set)
                        if resolved is None:
                            key = (rel, spec, lineno)
                            if key not in missing_seen and len(missing) < 100:
                                missing_seen.add(key)
                                missing.append(
                                    {
                                        "file": rel,
                                        "line": lineno,
                                        "spec": spec,
                                        "target": posixpath.normpath(
                                            posixpath.join(posixpath.dirname(rel), spec)
                                        ),
                                        "language": language,
                                    }
                                )
        elif language == "python":
            for lineno, line in enumerate(text.splitlines(), start=1):
                match = PY_REL_IMPORT.match(line)
                if not match:
                    continue
                refs_total += 1
                dots, module = match.group(1), match.group(2)
                resolved = _resolve_python(rel, dots, module, rel_set)
                if resolved is None and module:
                    key = (rel, dots + module, lineno)
                    if key not in missing_seen and len(missing) < 100:
                        missing_seen.add(key)
                        missing.append(
                            {
                                "file": rel,
                                "line": lineno,
                                "spec": dots + module,
                                "target": dots + module.replace(".", "/"),
                                "language": language,
                            }
                        )

    symbol_priority = {"function": 0, "class": 1, "method": 2, "type": 3, "impl": 4, "section": 5}
    symbols.sort(key=lambda item: (symbol_priority.get(str(item.get("kind")), 9), str(item.get("file")), int(item.get("line", 0))))
    return {
        "symbols": symbols,
        "symbolsTotal": len(symbols),
        "filesIndexed": indexed_files,
        "refsTotal": refs_total,
        "missing": missing,
        "missingTotal": len(missing),
        "truncated": truncated,
        "limits": {"files": INDEX_FILE_LIMIT, "bytes": INDEX_FILE_BYTES},
    }


def read_visible_file(root: Path, rel: str, meta: Dict[str, object]) -> Dict[str, object]:
    """Read one file already approved by the scan inventory."""
    root = root.resolve()
    candidate = (root / Path(rel)).resolve()
    if not _is_within(candidate, root) or not candidate.is_file():
        raise FileNotFoundError(rel)
    size = int(meta.get("size", 0))
    with candidate.open("rb") as handle:
        raw = handle.read(MAX_FILE_BYTES)
    truncated = size > MAX_FILE_BYTES
    binary = b"\x00" in raw[:8192]
    if binary:
        content = ""
    else:
        content = raw.decode("utf-8", "replace")
        if content.startswith("\ufeff"):
            content = content[1:]
    return {
        "path": rel,
        "content": content,
        "size": size,
        "mtime": int(meta.get("mtime", 0)),
        "language": meta.get("language", "text"),
        "kind": meta.get("kind", "other"),
        "binary": binary,
        "truncated": truncated,
        "lines": 0 if binary else content.count("\n") + (0 if content.endswith("\n") else 1),
    }
