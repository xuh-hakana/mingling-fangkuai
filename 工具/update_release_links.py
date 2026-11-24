#!/usr/bin/env python3
"""Resolve release.json task links to current source line numbers.

Each link may contain an `anchor` (a short literal string). This script finds the
first matching line in the linked file and writes `line`. Re-run it after code
changes so the in-app release announcement always jumps to the right entry.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELEASE = ROOT / "版本公告.json"


def find_line(path: Path, anchor: str) -> int:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise SystemExit(f"无法读取 {path}: {exc}")
    for index, line in enumerate(lines, start=1):
        if anchor in line:
            return index
    raise SystemExit(f"在 {path} 中找不到锚点：{anchor}")


def main() -> int:
    release = json.loads(RELEASE.read_text(encoding="utf-8"))
    updated = 0
    errors = 0
    for section in release.get("sections", []):
        for item in section.get("items", []):
            link = item.get("link")
            if not link:
                continue
            rel = link.get("path", "")
            anchor = link.get("anchor", "")
            if not rel or not anchor:
                continue
            target = ROOT / rel
            try:
                line = find_line(target, anchor)
            except SystemExit as exc:
                print(exc, file=sys.stderr)
                errors += 1
                continue
            if link.get("line") != line:
                link["line"] = line
                updated += 1
            print(f"{item.get('task', '?'):5} {rel}:{line}")
    RELEASE.write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n已更新 {updated} 个链接；共 {errors} 个错误。")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
