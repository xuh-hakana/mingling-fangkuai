"""提词器 · 需求库、提示词体检、剪贴板同步。

设计边界：
- 只写命令方块自己的配置目录，绝不碰被浏览的项目文件。
- 体检是本地规则匹配（数关键词、看结构），不联网、不调用模型，
  所以页面上的分数必须标成「规则体检」，不能当成 AI 判断。
- 剪贴板同步默认关闭，只有用户在面板里打开才会读。
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from store import Store, _atomic_json, _clean_text, normalize_rel_path

MAX_ITEMS = 600
MAX_TEXT = 80000
MAX_PENDING = 30
SCORE_MAX = 15

DIMS = [
    ("goal", "目标"),
    ("boundary", "边界"),
    ("acceptance", "可验收"),
    ("context", "上下文"),
    ("constraint", "约束"),
]

GOAL_RE = re.compile(r"目的|目标|需要|想要|做成|开发|实现|要求|希望")
BOUNDARY_RE = re.compile(r"不做|不要做|不实现|本轮不|后期|后续|暂不|排除|不属于")
ACCEPT_RE = re.compile(r"验收|完成标准|能做到|能用|可用|通过|落地|检查|测试|跑通|看见|看到")
CONSTRAINT_RE = re.compile(r"必须|不许|禁止|只读|不能改|不允许|规则|约束|限制|只能")
CONTEXT_RE = re.compile(r"(/[A-Za-z\u4e00-\u9fa5])|\.(py|js|ts|md|json|css|html|command)\b|文件夹|目录|项目|平台")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _fit(value: object, limit: int) -> str:
    return _clean_text(value, limit)


def _tag_list(value: object) -> List[str]:
    if isinstance(value, str):
        raw = re.split(r"[,，\s]+", value)
    elif isinstance(value, list):
        raw = [str(x) for x in value]
    else:
        raw = []
    out, seen = [], set()
    for item in raw:
        item = _clean_text(item, 20)
        if item and item not in seen:
            seen.add(item)
            out.append(item)
        if len(out) >= 12:
            break
    return out


def _file_list(value: object) -> List[str]:
    if not isinstance(value, list):
        return []
    out, seen = [], set()
    for item in value:
        try:
            rel = normalize_rel_path(item)
        except ValueError:
            continue
        if rel and rel not in seen:
            seen.add(rel)
            out.append(rel)
        if len(out) >= 40:
            break
    return out


def _score_entry(raw: object) -> Dict[str, int]:
    base = {key: 0 for key, _ in DIMS}
    if isinstance(raw, dict):
        for key, _ in DIMS:
            try:
                value = int(raw.get(key, 0))
            except (TypeError, ValueError):
                value = 0
            base[key] = max(0, min(3, value))
    return base


def health(text: str) -> Dict:
    """规则体检：只根据文本本身的结构打分，不做语义推断。"""
    body = text or ""
    dims: List[Dict] = []
    advice: List[str] = []

    goal = 0
    if GOAL_RE.search(body):
        goal = 2
        if re.search(r"^\s*(\d+[.、)]|【)", body, re.M):
            goal = 3
    if goal < 3:
        advice.append("把「要做什么」写成编号条目，每条一个动作，目标分才会满。")

    boundary = 0
    if BOUNDARY_RE.search(body):
        boundary = 3
    elif CONSTRAINT_RE.search(body):
        boundary = 1
    if boundary < 3:
        advice.append("写清「本轮不做」的清单，模型才不会顺手加功能。")

    acceptance = 0
    if ACCEPT_RE.search(body):
        acceptance = 2
        if re.search(r"验收|完成标准|判定", body):
            acceptance = 3
    if acceptance < 3:
        advice.append("给每条需求配一个「怎样算完成」的判定，最好能一眼看到结果。")

    context = 0
    size = len(body.strip())
    if size >= 800:
        context = 3
    elif size >= 300:
        context = 2
    elif size >= 80:
        context = 1
    if CONTEXT_RE.search(body) and context < 3:
        context += 1
    if context < 3:
        advice.append("补上项目路径、文件名和背景，模型不用猜你在说哪份代码。")

    constraint = 0
    if re.search(r"必须|不许|禁止|不允许|只能", body):
        constraint = 2
        if re.search(r"只读|不改|不修改|只写|规则", body):
            constraint = 3
    if constraint < 3:
        advice.append("补硬约束：能不能改用户文件、能不能联网、能不能装依赖。")

    values = {
        "goal": goal,
        "boundary": boundary,
        "acceptance": acceptance,
        "context": context,
        "constraint": constraint,
    }
    for key, label in DIMS:
        dims.append({"key": key, "label": label, "value": values[key], "max": 3})

    total = sum(values.values())
    if total >= 12:
        level, level_text = "good", "够用，可以直接发给 AI"
    elif total >= 8:
        level, level_text = "fair", "能用，但会被追问细节"
    else:
        level, level_text = "weak", "太薄，AI 只能靠猜"
    return {
        "total": total,
        "max": SCORE_MAX,
        "level": level,
        "levelText": level_text,
        "dims": dims,
        "advice": advice[:5],
    }


class PromptBook:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.path = data_dir / "prompts.json"
        self.lock = threading.RLock()
        self._clip_digest = ""
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.data = self._load()

    # -- persistence -----------------------------------------------------
    def _load(self) -> Dict:
        default = {
            "schema": 1,
            "items": [],
            "pending": [],
            "capture": {"enabled": False, "minLength": 40, "intervalSec": 3},
        }
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default
        if not isinstance(raw, dict):
            return default
        merged = default | raw
        merged["items"] = raw.get("items") if isinstance(raw.get("items"), list) else []
        merged["pending"] = raw.get("pending") if isinstance(raw.get("pending"), list) else []
        capture = raw.get("capture") if isinstance(raw.get("capture"), dict) else {}
        merged["capture"] = default["capture"] | capture
        return merged

    def _save(self) -> None:
        with self.lock:
            _atomic_json(self.path, self.data)

    # -- serialisation ---------------------------------------------------
    def _public(self, item: Dict) -> Dict:
        text = str(item.get("text") or "")
        scores = _score_entry(item.get("scores"))
        return {
            "id": item.get("id", ""),
            "title": item.get("title", ""),
            "text": text,
            "tags": item.get("tags", []),
            "scores": scores,
            "notes": item.get("notes", ""),
            "aiOutput": item.get("aiOutput", ""),
            "linkedFiles": item.get("linkedFiles", []),
            "source": item.get("source", "manual"),
            "archived": bool(item.get("archived", False)),
            "createdAt": item.get("createdAt", 0),
            "updatedAt": item.get("updatedAt", 0),
            "health": health(text),
        }

    def state(self) -> Dict:
        with self.lock:
            items = [self._public(item) for item in self.data["items"]]
            items.sort(key=lambda it: it.get("updatedAt") or 0, reverse=True)
            return {
                "items": items,
                "pending": list(self.data.get("pending", [])),
                "capture": dict(self.data.get("capture", {})),
                "health": health(""),
            }

    # -- CRUD ------------------------------------------------------------
    def upsert(self, payload: Dict) -> Dict:
        if not isinstance(payload, dict):
            raise ValueError("参数格式不正确")
        text = _fit(payload.get("text"), MAX_TEXT)
        title = _fit(payload.get("title"), 120)
        if not text:
            raise ValueError("需求原文不能为空")
        if not title:
            title = text.strip().splitlines()[0][:60] or "未命名需求"

        with self.lock:
            items = self.data["items"]
            item_id = _fit(payload.get("id"), 48)
            target = None
            if item_id:
                target = next((it for it in items if it.get("id") == item_id), None)
            now = _now_ms()
            if target is None:
                if len(items) >= MAX_ITEMS:
                    raise ValueError(f"需求条目已达上限 {MAX_ITEMS} 条")
                item_id = "p_" + uuid.uuid4().hex[:12]
                target = {"id": item_id, "createdAt": now, "source": "manual"}
                items.append(target)
            target.update(
                {
                    "title": title,
                    "text": text,
                    "tags": _tag_list(payload.get("tags", target.get("tags"))),
                    "scores": _score_entry(payload.get("scores", target.get("scores"))),
                    "notes": _fit(payload.get("notes", target.get("notes")), 8000),
                    "aiOutput": _fit(payload.get("aiOutput", target.get("aiOutput")), 40000),
                    "linkedFiles": _file_list(payload.get("linkedFiles", target.get("linkedFiles"))),
                    "archived": bool(payload.get("archived", target.get("archived", False))),
                    "updatedAt": now,
                }
            )
            self._save()
            return self._public(target)

    def delete(self, item_id: str) -> Dict:
        item_id = _fit(item_id, 48)
        with self.lock:
            before = len(self.data["items"])
            self.data["items"] = [it for it in self.data["items"] if it.get("id") != item_id]
            self._save()
            return {"deleted": before - len(self.data["items"])}

    # -- clipboard sync --------------------------------------------------
    def capture_config(self) -> Dict:
        with self.lock:
            return dict(self.data.get("capture", {}))

    def set_capture(self, payload: Dict) -> Dict:
        if not isinstance(payload, dict):
            raise ValueError("参数格式不正确")
        with self.lock:
            cfg = dict(self.data.get("capture", {}))
            if "enabled" in payload:
                cfg["enabled"] = bool(payload.get("enabled"))
            if "minLength" in payload:
                try:
                    cfg["minLength"] = max(10, min(2000, int(payload.get("minLength"))))
                except (TypeError, ValueError):
                    pass
            self.data["capture"] = cfg
            self._save()
            if cfg.get("enabled"):
                self.start()
            else:
                self._clip_digest = ""
            return cfg

    def _push_pending(self, text: str) -> None:
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        with self.lock:
            pending = self.data["pending"]
            if any(p.get("digest") == digest for p in pending):
                return
            existing = any(
                hashlib.sha256(str(it.get("text", "")).encode("utf-8")).hexdigest() == digest
                for it in self.data["items"]
            )
            if existing:
                return
            pending.insert(
                0,
                {
                    "id": "c_" + digest[:12],
                    "digest": digest,
                    "text": text[:MAX_TEXT],
                    "at": _now_ms(),
                    "length": len(text),
                },
            )
            del pending[MAX_PENDING:]
            self._save()

    def accept_pending(self, pending_id: str) -> Dict:
        pending_id = _fit(pending_id, 48)
        with self.lock:
            entry = next((p for p in self.data["pending"] if p.get("id") == pending_id), None)
            if entry is None:
                raise ValueError("这条候选已经不在列表里")
            self.data["pending"] = [p for p in self.data["pending"] if p.get("id") != pending_id]
            self._save()
        return self.upsert({"text": entry["text"], "source": "clipboard"})

    def dismiss_pending(self, pending_id: str) -> Dict:
        pending_id = _fit(pending_id, 48)
        with self.lock:
            before = len(self.data["pending"])
            self.data["pending"] = [p for p in self.data["pending"] if p.get("id") != pending_id]
            self._save()
            return {"removed": before - len(self.data["pending"])}

    # -- watcher ---------------------------------------------------------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="prompt-clip", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            cfg = self.capture_config()
            if not cfg.get("enabled"):
                self._stop.wait(2.0)
                continue
            try:
                text = self._read_clipboard()
                threshold = int(cfg.get("minLength") or 40)
                if text and len(text) >= threshold:
                    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
                    if digest != self._clip_digest:
                        self._clip_digest = digest
                        self._push_pending(text)
            except Exception:
                pass
            self._stop.wait(max(2, int(cfg.get("intervalSec") or 3)))

    @staticmethod
    def _read_clipboard() -> str:
        try:
            out = subprocess.run(
                ["/usr/bin/pbpaste"],
                capture_output=True,
                timeout=3,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        if out.returncode != 0:
            return ""
        return out.stdout.decode("utf-8", "replace").strip()
