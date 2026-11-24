#!/usr/bin/env python3
"""生成命令方块的应用图标（纯标准库，不依赖 Pillow）。

形状：深色圆角底 + 橙色实心方块 + 左上浅橙描边方块（镜像/复制的意思）。
输出 源码/AppIcon.icns，构建脚本会把它复制进 .app。
"""

from __future__ import annotations

import math
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path

SIZE = 1024
BG = (32, 36, 43)          # #20242b
ORANGE = (198, 79, 42)     # #c64f2a
ORANGE_LIGHT = (229, 141, 99)  # #e58d63


def sd_round_rect(px: float, py: float, cx: float, cy: float, hw: float, hh: float, r: float) -> float:
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ax = max(qx, 0.0)
    ay = max(qy, 0.0)
    return math.hypot(ax, ay) + min(max(qx, qy), 0.0) - r


def coverage(d: float) -> float:
    return max(0.0, min(1.0, 0.5 - d))


def blend(base, color, alpha: float):
    return tuple(int(round(base[i] * (1 - alpha) + color[i] * alpha)) for i in range(3))


def render() -> list[bytearray]:
    rows: list[bytearray] = []
    cx = cy = SIZE / 2
    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            px, py = x + 0.5, y + 0.5
            d_bg = sd_round_rect(px, py, cx, cy, 480, 480, 218)
            a_bg = coverage(d_bg)
            if a_bg <= 0:
                row += b"\x00\x00\x00\x00"
                continue
            color = BG
            # 左上描边方块（只留 26px 边）
            d_out = sd_round_rect(px, py, 476, 466, 214, 214, 40)
            if -26 < d_out <= 0.5:
                edge = min(coverage(d_out), coverage(-(d_out + 26)))
                if edge > 0:
                    color = blend(color, ORANGE_LIGHT, edge)
            # 实心橙块
            d_solid = sd_round_rect(px, py, 556, 566, 212, 212, 40)
            if d_solid <= 0:
                color = blend(color, ORANGE, coverage(d_solid))
            row += bytes((color[0], color[1], color[2], int(round(a_bg * 255))))
        rows.append(row)
    return rows


def write_png(path: Path, width: int, height: int, rows: list[bytearray]) -> None:
    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main() -> int:
    here = Path(__file__).resolve().parent
    master = here / "AppIcon-1024.png"
    print("正在画图标…")
    write_png(master, SIZE, SIZE, render())

    iconset = here / "AppIcon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()

    specs = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for size, name in specs:
        target = iconset / name
        subprocess.run(["sips", "-z", str(size), str(size), str(master), "--out", str(target)],
                       check=True, capture_output=True)
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(here / "AppIcon.icns")], check=True)
    print("图标完成：", here / "AppIcon.icns")
    return 0


if __name__ == "__main__":
    sys.exit(main())
