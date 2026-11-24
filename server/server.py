#!/usr/bin/env python3
"""命令方块 · Command Block — local, read-only code mirror.

A dependency-free macOS/Linux local web app. Bind address is always loopback.
No project file is ever written to; only the private data directory is used for
favourites and API settings.
"""

from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
import os
import posixpath
import queue
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

import scanner
from promptbook import PromptBook, health
from store import Store

APP_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = APP_ROOT / "web"
RELEASE_PATH = APP_ROOT / "版本公告.json"
REQUIREMENT_PATH = APP_ROOT / "docs" / "用户需求-本轮.md"
DEFAULT_DATA_DIR = Path.home() / "Library" / "Application Support" / "CommandBlock"
VERSION_FALLBACK = "0.1.0"
MAX_BODY_BYTES = 1_500_000
API_PROBE_TIMEOUT = 8


def _load_release() -> Dict:
    try:
        raw = json.loads(RELEASE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": VERSION_FALLBACK, "sections": [], "candidates": []}
    try:
        raw["requirement"] = REQUIREMENT_PATH.read_text(encoding="utf-8")
    except OSError:
        raw["requirement"] = ""
    return raw


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


class RepoService:
    """Owns the currently opened root and its in-memory scan state."""

    def __init__(self, app_root: Path, data_dir: Path):
        self.app_root = app_root.resolve()
        self.data_dir = data_dir.resolve()
        self.lock = threading.RLock()
        self.root: Optional[Path] = None
        self.tree: Optional[Dict] = None
        self.files_by_rel: Dict[str, Dict] = {}
        self.base_names: set = set()
        self.new_paths: set = set()
        self.index_cache: Optional[Dict] = None
        self.index_signature: str = ""
        self.changed_at = time.time()

    # -- root ------------------------------------------------------------
    def validate_root(self, raw_path: str) -> Path:
        text = (raw_path or "").strip()
        if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
            text = text[1:-1]
        if not text:
            raise ValueError("请填写文件夹路径")
        expanded = Path(os.path.expanduser(text))
        try:
            resolved = expanded.resolve(strict=True)
        except OSError:
            raise ValueError("文件夹不存在或无权访问")
        if not resolved.is_dir():
            raise ValueError("这个路径不是文件夹")
        if resolved == self.data_dir or _inside(resolved, self.data_dir):
            raise ValueError("命令方块的配置目录含密钥，不能作为浏览根目录")
        return resolved

    def set_root(self, path: Path) -> Dict:
        with self.lock:
            self.root = path
            self.tree = None
            self.files_by_rel = {}
            self.base_names = set()
            self.new_paths = set()
            self.index_cache = None
            self.index_signature = ""
            result = self._scan_locked()
            self.base_names = set(self.files_by_rel)
            self.new_paths = set()
            self.tree = result
            self.changed_at = time.time()
            return result

    def has_root(self) -> bool:
        with self.lock:
            return self.root is not None

    def root_display(self) -> str:
        with self.lock:
            return str(self.root) if self.root else ""

    # -- scan ------------------------------------------------------------
    def _ignored_paths(self) -> List[Path]:
        ignored = [self.data_dir]
        # The private runtime folder is excluded even if someone changes the
        # data directory location in a future build.
        for name in (".data", "data"):
            candidate = self.app_root / name
            if candidate.exists() and candidate.resolve() != self.data_dir:
                ignored.append(candidate.resolve())
        return ignored

    def _scan_locked(self) -> Dict:
        if self.root is None:
            raise RuntimeError("尚未打开文件夹")
        result = scanner.scan_tree(self.root, self.app_root, self._ignored_paths())
        files = list(result["files"])
        for item in files:
            item["new"] = False
        self.files_by_rel = {str(item["path"]): item for item in files}
        if self.base_names:
            self.new_paths &= set(self.files_by_rel)
            self.new_paths |= set(self.files_by_rel) - self.base_names
        for rel in self.new_paths:
            if rel in self.files_by_rel:
                self.files_by_rel[rel]["new"] = True
        result["files"] = [self.files_by_rel[key] for key in sorted(self.files_by_rel)]
        result["newFiles"] = sorted(self.new_paths)
        result["newCount"] = len(self.new_paths)
        result["indexedAt"] = int(time.time() * 1000)
        self.changed_at = time.time()
        return result

    def get_tree(self, force: bool = False) -> Dict:
        with self.lock:
            if self.root is None:
                raise RuntimeError("尚未打开文件夹")
            if force or self.tree is None:
                self.tree = self._scan_locked()
            return self.tree

    def refresh_if_changed(self) -> Tuple[bool, Optional[Dict]]:
        with self.lock:
            if self.root is None:
                return False, None
            previous = self.tree["signature"] if self.tree else ""
            fresh = self._scan_locked()
            self.tree = fresh
            if fresh["signature"] == previous:
                return False, None
            self.index_cache = None
            self.index_signature = ""
            return True, fresh

    def read_file(self, rel: str) -> Dict:
        rel = posixpath.normpath(rel.replace("\\", "/"))
        if rel.startswith("../") or rel == ".." or rel.startswith("/"):
            raise PermissionError("路径越界")
        with self.lock:
            if rel not in self.files_by_rel:
                # A just-created file may arrive between the watcher ticks.
                if self.root is None:
                    raise FileNotFoundError(rel)
                self.tree = self._scan_locked()
                if rel not in self.files_by_rel:
                    raise FileNotFoundError(rel)
            meta = self.files_by_rel[rel]
            root = self.root
        assert root is not None
        data = scanner.read_visible_file(root, rel, meta)
        data["new"] = rel in self.new_paths
        return data

    def build_index(self, force: bool = False) -> Dict:
        with self.lock:
            if self.root is None:
                raise RuntimeError("尚未打开文件夹")
            if self.tree is None:
                self.tree = self._scan_locked()
            signature = self.tree["signature"]
            if not force and self.index_cache is not None and self.index_signature == signature:
                return self.index_cache
            root = self.root
            files = list(self.tree["files"])
        result = scanner.build_symbol_index(root, files)
        result["signature"] = signature
        with self.lock:
            if self.root != root:
                raise RuntimeError("工作区已切换，请重新加载索引")
            self.index_cache = result
            self.index_signature = signature
        return result

    def acknowledge_new(self) -> Dict:
        with self.lock:
            self.new_paths = set()
            self.base_names = set(self.files_by_rel)
            for item in self.files_by_rel.values():
                item["new"] = False
            if self.tree is not None:
                self.tree["newCount"] = 0
                self.tree["newFiles"] = []
                for item in self.tree["files"]:
                    item["new"] = False
            return {"newCount": 0}


class App:
    def __init__(self, data_dir: Path, root_override: Optional[str] = None, verbose: bool = False):
        self.verbose = verbose
        self.data_dir = data_dir
        self.store = Store(data_dir)
        self.prompts = PromptBook(data_dir)
        self.repo = RepoService(APP_ROOT, data_dir)
        self.release = _load_release()
        self.sse_clients: List[queue.Queue] = []
        self.sse_lock = threading.Lock()
        self.api_status: Dict = {
            "state": "unchecked",
            "latency": None,
            "checkedAt": None,
            "message": "尚未检测",
        }
        self.api_status_lock = threading.Lock()
        self.watcher_stop = threading.Event()
        self.watcher_thread: Optional[threading.Thread] = None
        self.initial_root = ""
        self._open_initial_root(root_override)

    def _open_initial_root(self, root_override: Optional[str]) -> None:
        candidates: List[str] = []
        if root_override:
            candidates.append(root_override)
        saved = self.store.current_root()
        if saved:
            candidates.append(saved)
        candidates.append(str(APP_ROOT.parent))
        candidates.append(str(APP_ROOT))
        for candidate in candidates:
            try:
                path = self.repo.validate_root(candidate)
            except ValueError:
                continue
            try:
                self.repo.set_root(path)
            except Exception:
                if self.verbose:
                    traceback.print_exc()
                continue
            self.initial_root = str(path)
            self.store.set_current_root(str(path))
            return
        # The app must still boot if its own folder cannot be scanned.
        self.initial_root = ""
        if self.verbose:
            print("[command-block] no readable initial root", file=sys.stderr)

    # -- watcher ---------------------------------------------------------
    def start_watcher(self) -> None:
        self.watcher_thread = threading.Thread(target=self._watch_loop, name="command-block-watch", daemon=True)
        self.watcher_thread.start()

    def stop(self) -> None:
        self.watcher_stop.set()
        try:
            self.prompts.stop()
        except Exception:
            pass

    def _watch_loop(self) -> None:
        while not self.watcher_stop.is_set():
            delay = 2.0 if self.has_sse_clients() else 10.0
            if self.watcher_stop.wait(delay):
                return
            if not self.has_sse_clients() or not self.repo.has_root():
                continue
            try:
                changed, tree = self.repo.refresh_if_changed()
            except Exception:
                if self.verbose:
                    traceback.print_exc()
                continue
            if changed and tree:
                self.broadcast(
                    "tree",
                    {
                        "at": int(time.time() * 1000),
                        "signature": tree["signature"],
                        "counts": tree["counts"],
                        "newCount": tree["newCount"],
                    },
                )

    def has_sse_clients(self) -> bool:
        with self.sse_lock:
            return bool(self.sse_clients)

    def add_sse(self) -> queue.Queue:
        client: queue.Queue = queue.Queue(maxsize=64)
        with self.sse_lock:
            self.sse_clients.append(client)
        return client

    def remove_sse(self, client: queue.Queue) -> None:
        with self.sse_lock:
            try:
                self.sse_clients.remove(client)
            except ValueError:
                pass

    def broadcast(self, event: str, payload: Dict) -> None:
        with self.sse_lock:
            clients = list(self.sse_clients)
        for client in clients:
            try:
                client.put_nowait({"event": event, "data": payload})
            except queue.Full:
                pass

    # -- api status ------------------------------------------------------
    def public_api(self) -> Dict:
        config = self.store.public_api_config()
        with self.api_status_lock:
            status = dict(self.api_status)
        return {**config, "status": status}

    def test_api(self, force: bool = True) -> Dict:
        config = self.store.api_config()
        if not config["baseUrl"]:
            with self.api_status_lock:
                self.api_status = {
                    "state": "unconfigured",
                    "latency": None,
                    "checkedAt": int(time.time() * 1000),
                    "message": "请先填写 API 地址",
                }
                return dict(self.api_status)
        now = int(time.time() * 1000)
        with self.api_status_lock:
            cached = dict(self.api_status)
            if not force and cached.get("checkedAt") and now - int(cached["checkedAt"]) < 30_000:
                return cached
            self.api_status = {
                "state": "checking",
                "latency": None,
                "checkedAt": now,
                "message": "正在连接…",
            }
        key = self.store.api_key()
        base = config["baseUrl"]
        model = config["model"]
        started = time.time()
        url = base.rstrip("/") + "/models"
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "CommandBlock/0.1"})
        if key:
            request.add_header("Authorization", "Bearer " + key)
        result: Dict = {
            "state": "error",
            "latency": None,
            "checkedAt": int(time.time() * 1000),
            "message": "",
            "httpStatus": None,
            "model": model,
            "modelFound": None,
        }
        try:
            with urllib.request.urlopen(request, timeout=API_PROBE_TIMEOUT) as response:
                body = response.read(1_000_000)
                result["httpStatus"] = getattr(response, "status", 200)
                latency = int((time.time() - started) * 1000)
                result["latency"] = latency
                result["state"] = "ok"
                result["message"] = f"连接正常 · {latency} ms"
                try:
                    payload = json.loads(body.decode("utf-8", "replace"))
                    models = payload.get("data") if isinstance(payload, dict) else None
                    if isinstance(models, list) and model:
                        ids = {
                            str(item.get("id"))
                            for item in models
                            if isinstance(item, dict) and item.get("id")
                        }
                        result["modelFound"] = model in ids
                        if ids and model not in ids:
                            result["message"] = f"连接正常，但未在模型列表中发现 {model}"
                except (ValueError, UnicodeDecodeError):
                    pass
        except urllib.error.HTTPError as exc:
            latency = int((time.time() - started) * 1000)
            result["latency"] = latency
            result["httpStatus"] = exc.code
            if exc.code in (401, 403):
                result["state"] = "auth"
                result["message"] = f"认证失败（HTTP {exc.code}），请检查 API Key"
            elif exc.code == 404:
                result["state"] = "endpoint"
                result["message"] = "接口可达，但 /models 不存在；请检查 Base URL"
            else:
                result["state"] = "error"
                result["message"] = f"接口返回 HTTP {exc.code}"
        except urllib.error.URLError as exc:
            result["latency"] = int((time.time() - started) * 1000)
            reason = getattr(exc, "reason", exc)
            result["state"] = "offline"
            result["message"] = f"无法连接：{str(reason)[:140]}"
        except (TimeoutError, socket.timeout):
            result["latency"] = int((time.time() - started) * 1000)
            result["state"] = "offline"
            result["message"] = "连接超时"
        except Exception as exc:  # never leak credentials in messages
            result["state"] = "error"
            result["message"] = f"检测失败：{type(exc).__name__}"
        with self.api_status_lock:
            self.api_status = result
        return result


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CommandBlock/0.1"
    app: App = None  # type: ignore

    # -- helpers ---------------------------------------------------------
    def log_message(self, fmt: str, *args) -> None:
        if getattr(self.app, "verbose", False):
            sys.stderr.write("[command-block] " + (fmt % args) + "\n")

    def _host_ok(self) -> bool:
        """Reject DNS-rebinding style Host headers before serving anything."""
        host = self.headers.get("Host", "")
        if not host:
            return False
        parsed = urlparse("//" + host)
        return parsed.hostname in {"127.0.0.1", "localhost", "::1"}

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        if parsed.scheme != "http":
            return False
        host = self.headers.get("Host", "")
        return parsed.netloc == host and parsed.hostname in {"127.0.0.1", "localhost", "::1"}

    def _send_json(self, payload: Dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        encoding = None
        if len(body) > 1024 and "gzip" in self.headers.get("Accept-Encoding", "").lower():
            body = gzip.compress(body, 5)
            encoding = "gzip"
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str, code: str = "error") -> None:
        self._send_json({"error": {"code": code, "message": message}}, status)

    def _read_json(self) -> Dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ValueError("JSON 格式不正确")
        if not isinstance(data, dict):
            raise ValueError("请求体必须是对象")
        return data

    def _check_mutation(self) -> bool:
        if not self._origin_ok():
            self._error(403, "跨站请求已被拒绝", "origin")
            return False
        return True

    # -- HTTP ------------------------------------------------------------
    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        if not self._host_ok():
            self._error(403, "只允许通过 127.0.0.1 或 localhost 访问", "host")
            return
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path == "/api/health":
                self._send_json(
                    {
                        "ok": True,
                        "version": self.app.release.get("version", VERSION_FALLBACK),
                        "appRoot": str(APP_ROOT),
                        "root": self.app.repo.root_display(),
                    }
                )
                return
            if path == "/api/state":
                self._send_json(self._state_payload())
                return
            if path == "/api/tree":
                force = query.get("refresh", ["0"])[0] == "1"
                tree = self.app.repo.get_tree(force=force)
                self._send_json(self._tree_payload(tree))
                return
            if path == "/api/file":
                rel = query.get("path", [""])[0]
                if not rel:
                    self._error(400, "缺少文件路径", "missing_path")
                    return
                try:
                    data = self.app.repo.read_file(rel)
                except FileNotFoundError:
                    self._error(404, "文件不在当前只读镜像中，或已被排除", "not_found")
                    return
                except PermissionError:
                    self._error(403, "路径不在当前文件夹内", "forbidden")
                    return
                self._send_json(data)
                return
            if path == "/api/index":
                force = query.get("refresh", ["0"])[0] == "1"
                data = self.app.repo.build_index(force=force)
                self._send_json(data)
                return
            if path == "/api/favorites":
                root = self.app.repo.root_display()
                self._send_json({"root": root, "categories": self.app.store.favorites(root)})
                return
            if path == "/api/prompts":
                self._send_json(self.app.prompts.state())
                return
            if path == "/api/api":
                self._send_json(self.app.public_api())
                return
            if path == "/api/new/ack":
                self._error(405, "请使用 POST", "method")
                return
            if path == "/api/release":
                self._send_json(self.app.release)
                return
            if path == "/api/events":
                self._serve_events()
                return
            if path.startswith("/api/"):
                self._error(404, "接口不存在", "no_route")
                return
            self._serve_static(path)
        except BrokenPipeError:
            return
        except Exception as exc:
            if self.app.verbose:
                traceback.print_exc()
            try:
                self._error(500, f"服务器内部错误：{type(exc).__name__}", "internal")
            except Exception:
                pass

    def do_POST(self) -> None:
        if not self._host_ok():
            self._error(403, "只允许通过 127.0.0.1 或 localhost 访问", "host")
            return
        path = urlparse(self.path).path
        if not self._check_mutation():
            return
        try:
            payload = self._read_json()
            if path == "/api/root":
                raw = str(payload.get("path", ""))
                try:
                    root = self.app.repo.validate_root(raw)
                except ValueError as exc:
                    self._error(400, str(exc), "invalid_root")
                    return
                tree = self.app.repo.set_root(root)
                self.app.store.set_current_root(str(root))
                self._send_json({"root": str(root), "tree": self._tree_payload(tree), "state": self._state_payload()})
                return
            if path == "/api/rescan":
                tree = self.app.repo.get_tree(force=True)
                self._send_json(self._tree_payload(tree))
                return
            if path == "/api/new/ack":
                self._send_json(self.app.repo.acknowledge_new())
                return
            if path == "/api/favorites":
                root = self.app.repo.root_display()
                if not root:
                    self._error(409, "尚未打开文件夹", "no_root")
                    return
                if payload.get("root") and payload.get("root") != root:
                    self._error(409, "工作区已切换，请重新操作收藏夹", "root_changed")
                    return
                categories = self.app.store.save_favorites(root, payload.get("categories"))
                self._send_json({"root": root, "categories": categories})
                return
            if path == "/api/api":
                config = self.app.store.update_api_config(payload)
                with self.app.api_status_lock:
                    self.app.api_status = {
                        "state": "unchecked",
                        "latency": None,
                        "checkedAt": None,
                        "message": "配置已保存，等待检测",
                    }
                self.app.broadcast("api-status", {"state": "unchecked", "message": "配置已保存"})
                self._send_json({**config, "status": self.app.public_api()["status"]})
                return
            if path == "/api/api/test":
                result = self.app.test_api(force=True)
                self.app.broadcast("api-status", result)
                self._send_json(result)
                return
            if path == "/api/prompts":
                self._send_json(self.app.prompts.upsert(payload))
                return
            if path == "/api/prompts/check":
                text = payload.get("text")
                self._send_json({"health": health(str(text) if isinstance(text, str) else "")})
                return
            if path == "/api/prompts/delete":
                self._send_json(self.app.prompts.delete(str(payload.get("id", ""))))
                return
            if path == "/api/prompts/accept":
                self._send_json(self.app.prompts.accept_pending(str(payload.get("id", ""))))
                return
            if path == "/api/prompts/dismiss":
                self._send_json(self.app.prompts.dismiss_pending(str(payload.get("id", ""))))
                return
            if path == "/api/prompts/capture":
                self._send_json({"capture": self.app.prompts.set_capture(payload)})
                return
            if path == "/api/notes":
                root = self.app.repo.root_display()
                if not root:
                    self._error(409, "尚未打开文件夹", "no_root")
                    return
                notes = self.app.store.save_note(
                    root,
                    str(payload.get("path", "")),
                    str(payload.get("text", "")),
                )
                self._send_json({"notes": notes})
                return
            if path == "/api/pick-folder":
                self._pick_folder()
                return
            if path == "/api/focus":
                # 让已经在运行的命令方块窗口跳转到某个文件（复用同一窗口，不再开第二个）。
                rel = str(payload.get("path", "")).strip()
                if not rel:
                    self._error(400, "缺少文件路径", "missing_path")
                    return
                rel = posixpath.normpath(rel.replace("\\", "/"))
                if not rel or rel == ".." or rel.startswith("../") or rel.startswith("/"):
                    self._error(400, "路径越界", "bad_path")
                    return
                root = self.app.repo.root
                if not root:
                    self._error(409, "尚未打开文件夹", "no_root")
                    return
                full = (root / rel).resolve()
                if full == root or not _inside(full, root) or not full.is_file():
                    self._error(404, "文件不在当前根目录内或不存在", "not_found")
                    return
                try:
                    line = int(payload.get("line", 0) or 0)
                except (TypeError, ValueError):
                    line = 0
                self.app.broadcast("focus", {"path": rel, "line": line})
                self._send_json({"ok": True, "path": rel, "line": line})
                return
            self._error(404, "接口不存在", "no_route")
        except ValueError as exc:
            self._error(400, str(exc), "bad_request")
        except BrokenPipeError:
            return
        except Exception as exc:
            if self.app.verbose:
                traceback.print_exc()
            try:
                self._error(500, f"服务器内部错误：{type(exc).__name__}", "internal")
            except Exception:
                pass

    def do_PUT(self) -> None:
        # The only mutating endpoint accepting PUT is favourites, for a tidy
        # REST shape. Everything else is POST.
        if not self._host_ok():
            self._error(403, "只允许通过 127.0.0.1 或 localhost 访问", "host")
            return
        path = urlparse(self.path).path
        if path != "/api/favorites":
            self._error(405, "不支持的方法", "method")
            return
        if not self._check_mutation():
            return
        try:
            payload = self._read_json()
            root = self.app.repo.root_display()
            if not root:
                self._error(409, "尚未打开文件夹", "no_root")
                return
            if payload.get("root") and payload.get("root") != root:
                self._error(409, "工作区已切换，请重新操作收藏夹", "root_changed")
                return
            categories = self.app.store.save_favorites(root, payload.get("categories"))
            self._send_json({"root": root, "categories": categories})
        except ValueError as exc:
            self._error(400, str(exc), "bad_request")
        except Exception:
            self._error(500, "保存收藏夹失败", "internal")

    def do_DELETE(self) -> None:
        if not self._host_ok():
            self._error(403, "只允许通过 127.0.0.1 或 localhost 访问", "host")
            return
        self._error(405, "不支持的方法", "method")

    # -- payloads --------------------------------------------------------
    def _state_payload(self) -> Dict:
        root = self.app.repo.root_display()
        root_exists = bool(root and Path(root).is_dir())
        return {
            "version": self.app.release.get("version", VERSION_FALLBACK),
            "appRoot": str(APP_ROOT),
            "root": {
                "path": root,
                "name": Path(root).name if root else "",
                "exists": root_exists,
                "isAppRoot": bool(root and Path(root).resolve() == APP_ROOT),
            },
            "favorites": self.app.store.favorites(root) if root else [],
            "notes": self.app.store.notes(root) if root else {},
            "recent": self.app.store.recent_roots(),
            "api": self.app.public_api(),
            "safety": {
                "readOnly": True,
                "excluded": [
                    ".env / 密钥 / 证书",
                    "日志与缓存",
                    "构建产物与依赖目录",
                    "符号链接不跟随",
                    "插件配置数据",
                ],
                "dataDir": self.app.store.data_dir_display(),
            },
        }

    def _tree_payload(self, tree: Dict) -> Dict:
        payload = dict(tree)
        payload["files"] = list(tree["files"])
        payload["newFiles"] = list(tree.get("newFiles", []))
        payload["newCount"] = int(tree.get("newCount", 0))
        payload["rootName"] = tree.get("rootName") or Path(str(tree.get("root", ""))).name
        return payload

    # -- SSE -------------------------------------------------------------
    def _serve_events(self) -> None:
        client = self.app.add_sse()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(b"retry: 2500\n\n")
            self.wfile.write(b"event: hello\ndata: {\"ok\":true}\n\n")
            self.wfile.flush()
            while True:
                try:
                    message = client.get(timeout=20)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                data = json.dumps(message.get("data", {}), ensure_ascii=False, separators=(",", ":"))
                event = message.get("event", "message")
                self.wfile.write(f"event: {event}\ndata: {data}\n\n".encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.app.remove_sse(client)

    # -- static ----------------------------------------------------------
    def _serve_static(self, path: str) -> None:
        if path in {"", "/"}:
            rel = "index.html"
        else:
            rel = unquote(path.lstrip("/"))
        if "\x00" in rel:
            self._error(400, "非法路径", "bad_path")
            return
        candidate = (WEB_DIR / rel).resolve()
        if not _inside(candidate, WEB_DIR.resolve()) or not candidate.is_file():
            self._error(404, "页面不存在", "not_found")
            return
        try:
            body = candidate.read_bytes()
        except OSError:
            self._error(404, "页面不存在", "not_found")
            return
        mime, _ = mimetypes.guess_type(str(candidate))
        if candidate.suffix == ".js":
            mime = "text/javascript"
        elif candidate.suffix == ".css":
            mime = "text/css"
        elif candidate.suffix == ".svg":
            mime = "image/svg+xml"
        mime = mime or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", f"{mime}; charset=utf-8" if mime.startswith("text/") or mime in {"application/javascript", "application/json", "image/svg+xml"} else mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        )
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # -- native picker ---------------------------------------------------
    def _pick_folder(self) -> None:
        if sys.platform != "darwin":
            self._send_json({"cancelled": True, "path": "", "unsupported": True})
            return
        script = 'POSIX path of (choose folder with prompt "选择要只读浏览的文件夹")'
        try:
            proc = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=180,
            )
        except (OSError, subprocess.TimeoutExpired):
            self._send_json({"cancelled": True, "path": "", "error": "无法打开系统文件夹选择器"})
            return
        if proc.returncode != 0 or not proc.stdout.strip():
            self._send_json({"cancelled": True, "path": ""})
            return
        path = proc.stdout.strip().rstrip("/")
        if not path:
            self._send_json({"cancelled": True, "path": ""})
            return
        try:
            resolved = str(Path(path).resolve(strict=True))
        except OSError:
            self._send_json({"cancelled": True, "path": "", "error": "无法读取所选文件夹"})
            return
        self._send_json({"cancelled": False, "path": resolved})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _choose_port(start: int) -> int:
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("找不到可用端口")


def main() -> int:
    parser = argparse.ArgumentParser(description="命令方块 · 本地只读代码镜像")
    parser.add_argument("--port", type=int, default=8765, help="本地端口（默认 8765，被占用时自动顺延）")
    parser.add_argument("--data-dir", type=str, default="", help="配置目录（默认 ~/Library/Application Support/CommandBlock）")
    parser.add_argument("--root", type=str, default="", help="启动时打开的文件夹")
    parser.add_argument("--no-open", action="store_true", help="不要自动打开浏览器")
    parser.add_argument("--open", action="store_true", help="自动打开浏览器（默认行为）")
    parser.add_argument("--verbose", action="store_true", help="输出请求日志")
    parser.add_argument("--parent-pid", type=int, default=0, help="父进程 PID；父进程消失后自动退出，避免留下孤儿服务")
    args = parser.parse_args()

    data_dir = Path(os.path.expanduser(args.data_dir)).resolve() if args.data_dir else DEFAULT_DATA_DIR
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(data_dir, 0o700)
    except OSError as exc:
        print(f"无法创建配置目录 {data_dir}: {exc}", file=sys.stderr)
        return 1

    version = _load_release().get("version", VERSION_FALLBACK)
    app = App(data_dir, root_override=args.root or None, verbose=args.verbose)
    Handler.app = app

    try:
        port = _choose_port(args.port)
        server = Server(("127.0.0.1", port), Handler)
    except Exception as exc:
        print(f"启动失败：{exc}", file=sys.stderr)
        return 1

    # 把当前端口写进配置目录，方便外部程序（如虚幻客户端）发现已在运行的服务，
    # 从而复用同一个窗口而不是再开一个。
    try:
        (data_dir / "port").write_text(str(port), encoding="utf-8")
    except OSError:
        pass

    app.start_watcher()
    url = f"http://127.0.0.1:{port}/"
    print("")
    print("  命令方块 · Command Block  v" + str(version))
    print("  只读镜像已就绪  " + url)
    print("  浏览根目录  " + (app.repo.root_display() or "（未打开）"))
    print("  配置目录    " + str(data_dir))
    print("  按 Ctrl+C 停止")
    print("")

    if not args.no_open:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    def _stop(_signum, _frame):
        app.stop()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    if args.parent_pid > 1:
        def _watch_parent() -> None:
            while True:
                time.sleep(3.0)
                try:
                    os.kill(args.parent_pid, 0)
                except OSError:
                    _stop(signal.SIGTERM, None)
                    return
        threading.Thread(target=_watch_parent, daemon=True).start()

    try:
        server.serve_forever(poll_interval=0.4)
    finally:
        app.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
