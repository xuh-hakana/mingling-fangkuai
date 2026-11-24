"""Small, dependency-free persistence layer for Command Block.

Only settings and favourites live here. Project files are never written to.
API keys are kept in a separate 0600 file and are never included in a public
state response.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

DEFAULT_API = {
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "autoCheck": True,
}

MAX_CATEGORIES = 60
MAX_ITEMS_PER_CATEGORY = 300
MAX_FAVORITES = 1500
MAX_ROOTS = 12
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,48}$")


def _atomic_json(path: Path, payload: Dict, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_name, mode)
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            try:
                os.unlink(tmp_name)
            except OSError:
                pass


def _clean_text(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.replace("\x00", "").strip()[:limit]


def validate_base_url(value: object) -> str:
    url = _clean_text(value, 500)
    if not url:
        return ""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("API 地址必须是 http(s) 网址")
    if parsed.username or parsed.password:
        raise ValueError("API 地址不能包含账号密码")
    if parsed.query or parsed.fragment:
        raise ValueError("API 地址不能包含查询参数或锚点")
    return url.rstrip("/")


def normalize_rel_path(value: object) -> str:
    rel = _clean_text(value, 900).replace("\\", "/")
    if rel.startswith("/") or rel.startswith("../") or "/../" in rel or rel in {"..", "."}:
        raise ValueError("路径越界")
    while rel.startswith("./"):
        rel = rel[2:]
    return rel


class Store:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.state_path = data_dir / "state.json"
        self.secret_path = data_dir / "secrets.json"
        self.lock = threading.RLock()
        self.state = self._load_state()
        self.secret = self._load_secret()

    # -- persistence -----------------------------------------------------
    def _load_state(self) -> Dict:
        default = {
            "schema": 1,
            "currentRoot": "",
            "recentRoots": [],
            "roots": {},
            "api": dict(DEFAULT_API),
        }
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default
        if not isinstance(raw, dict):
            return default
        merged = default | raw
        merged["api"] = default["api"] | (raw.get("api") if isinstance(raw.get("api"), dict) else {})
        merged["roots"] = raw.get("roots") if isinstance(raw.get("roots"), dict) else {}
        merged["recentRoots"] = raw.get("recentRoots") if isinstance(raw.get("recentRoots"), list) else []
        return merged

    def _load_secret(self) -> Dict:
        try:
            raw = json.loads(self.secret_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def save(self) -> None:
        with self.lock:
            _atomic_json(self.state_path, self.state)

    def _save_secret(self) -> None:
        _atomic_json(self.secret_path, self.secret)
        try:
            os.chmod(self.secret_path, 0o600)
        except OSError:
            pass

    # -- roots -----------------------------------------------------------
    def current_root(self) -> str:
        with self.lock:
            return str(self.state.get("currentRoot") or "")

    def set_current_root(self, path: str) -> None:
        with self.lock:
            self.state["currentRoot"] = path
            recent = [r for r in self.state.get("recentRoots", []) if isinstance(r, dict) and r.get("path") != path]
            recent.insert(0, {"path": path, "at": int(time.time() * 1000)})
            self.state["recentRoots"] = recent[:MAX_ROOTS]
            self.state.setdefault("roots", {}).setdefault(path, {"favorites": []})
            self.save()

    def recent_roots(self) -> List[Dict]:
        with self.lock:
            return list(self.state.get("recentRoots", []))

    def root_state(self, root: str) -> Dict:
        with self.lock:
            roots = self.state.setdefault("roots", {})
            entry = roots.setdefault(root, {"favorites": []})
            if not isinstance(entry.get("favorites"), list):
                entry["favorites"] = []
            return entry

    def favorites(self, root: str) -> List[Dict]:
        with self.lock:
            entry = self.root_state(root)
            return json.loads(json.dumps(entry.get("favorites", []), ensure_ascii=False))

    def save_favorites(self, root: str, categories: object) -> List[Dict]:
        clean = self._validate_categories(categories, root)
        with self.lock:
            self.root_state(root)["favorites"] = clean
            self.save()
        return clean

    def _validate_categories(self, categories: object, root: str) -> List[Dict]:
        if not isinstance(categories, list):
            raise ValueError("收藏夹格式不正确")
        if len(categories) > MAX_CATEGORIES:
            raise ValueError(f"分类不能超过 {MAX_CATEGORIES} 个")
        result: List[Dict] = []
        seen_ids = set()
        total = 0
        for raw_category in categories:
            if not isinstance(raw_category, dict):
                raise ValueError("分类格式不正确")
            name = _clean_text(raw_category.get("name"), 40)
            if not name:
                raise ValueError("分类名称不能为空")
            category_id = _clean_text(raw_category.get("id"), 48)
            if not ID_RE.match(category_id):
                category_id = uuid.uuid4().hex[:12]
            if category_id in seen_ids:
                category_id = uuid.uuid4().hex[:12]
            seen_ids.add(category_id)
            items = []
            seen_paths = set()
            raw_items = raw_category.get("items")
            if not isinstance(raw_items, list):
                raw_items = []
            if len(raw_items) > MAX_ITEMS_PER_CATEGORY:
                raise ValueError(f"单个分类不能超过 {MAX_ITEMS_PER_CATEGORY} 项")
            for raw_item in raw_items:
                if not isinstance(raw_item, dict):
                    continue
                try:
                    rel = normalize_rel_path(raw_item.get("path"))
                except ValueError:
                    continue
                if not rel or rel in seen_paths:
                    continue
                seen_paths.add(rel)
                kind = "folder" if raw_item.get("kind") == "folder" else "file"
                items.append({"path": rel, "kind": kind, "name": rel.rsplit("/", 1)[-1]})
                total += 1
                if total >= MAX_FAVORITES:
                    break
            result.append({"id": category_id, "name": name, "items": items})
            if total >= MAX_FAVORITES:
                break
        return result

    # -- file notes ------------------------------------------------------
    def notes(self, root: str) -> Dict:
        with self.lock:
            entry = self.root_state(root)
            notes = entry.get("notes")
            if not isinstance(notes, dict):
                return {}
            return json.loads(json.dumps(notes, ensure_ascii=False))

    def save_note(self, root: str, rel: str, text: str) -> Dict:
        rel = normalize_rel_path(rel)
        if not rel:
            raise ValueError("缺少文件路径")
        text = _clean_text(text, 2000)
        with self.lock:
            entry = self.root_state(root)
            notes = entry.get("notes")
            if not isinstance(notes, dict):
                notes = {}
                entry["notes"] = notes
            if text:
                if len(notes) >= 4000 and rel not in notes:
                    raise ValueError("文件用途说明已达上限 4000 条")
                notes[rel] = {"text": text, "at": int(time.time() * 1000)}
            else:
                notes.pop(rel, None)
            self.save()
            return json.loads(json.dumps(notes, ensure_ascii=False))

    # -- API config ------------------------------------------------------
    def api_config(self) -> Dict:
        with self.lock:
            api = dict(DEFAULT_API)
            api.update(self.state.get("api") or {})
            return {
                "baseUrl": str(api.get("baseUrl") or ""),
                "model": str(api.get("model") or ""),
                "autoCheck": bool(api.get("autoCheck", True)),
            }

    def public_api_config(self) -> Dict:
        cfg = self.api_config()
        key = str(self.secret.get("apiKey") or "")
        hint = key[-4:] if len(key) >= 4 else ""
        return {
            **cfg,
            "hasKey": bool(key),
            "keyHint": hint,
            "maskedKey": ("••••" + hint) if key else "",
        }

    def api_key(self) -> str:
        with self.lock:
            return str(self.secret.get("apiKey") or "")

    def update_api_config(self, payload: Dict) -> Dict:
        if not isinstance(payload, dict):
            raise ValueError("参数格式不正确")
        base = validate_base_url(payload.get("baseUrl", ""))
        model = _clean_text(payload.get("model"), 120) or DEFAULT_API["model"]
        auto_check = bool(payload.get("autoCheck", True))
        clear_key = bool(payload.get("clearKey", False))
        new_key = payload.get("apiKey")
        key_to_save = ""
        if not clear_key and isinstance(new_key, str) and new_key.strip():
            key_to_save = new_key.strip()
            if len(key_to_save) > 800 or "\n" in key_to_save or "\r" in key_to_save:
                raise ValueError("API Key 格式不正确")
        with self.lock:
            self.state["api"] = {"baseUrl": base, "model": model, "autoCheck": auto_check}
            if clear_key:
                self.secret.pop("apiKey", None)
                self._save_secret()
            elif key_to_save:
                self.secret["apiKey"] = key_to_save
                self._save_secret()
            self.save()
        return self.public_api_config()

    def data_dir_display(self) -> str:
        return str(self.data_dir)
