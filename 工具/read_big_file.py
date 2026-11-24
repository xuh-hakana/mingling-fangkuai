#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
read_big_file.py — 专为"大文件"设计的流式读取工具（零依赖，Python 3）。

用途：日志 / 数据 dump / 大 JSON / 大 CSV 等超大文本文件。
目标：① 避免一次性把整文件载入内存或灌回 LLM 上下文（防 token 爆炸）；
      ② 提供行号定位、区间、关键词检索、抽样等按需读取能力。
原则：只读不写，绝不修改原文件。

子命令：
  info    PATH                  文件规模：行数 / 字节 / 最大行宽 / 是否二进制
  head    PATH [N=50]           前 N 行
  tail    PATH [N=50]           后 N 行
  range   PATH START END        行范围（1-based，闭区间，如 range x.json 1000 1500）
  grep    PATH PATTERN ...      正则搜索，带上下文
  between PATH START END ...    抽取 START..END 模式之间的块
  sample  PATH [STEP=100]       等间隔抽样（行号 % STEP == 0）

通用选项：
  --max-line-len LEN   单行超长截断阈值（默认 2000 字符），防单条消息爆 token
  -i                   忽略大小写（grep / between）
  -c CTX               上下文行数（grep，默认 2）
  -m MAX               最多输出多少命中 / 块（默认 20，0 = 不限制）
  -n                   在 grep / between 里也显示"非命中"行的行号（默认只标命中行）

示例：
  python3 read_big_file.py info   "/path/大日志.log"
  python3 read_big_file.py grep   "/path/大日志.log" "ERROR|Traceback" -c 3 -m 30
  python3 read_big_file.py range  "/path/big.json" 12000 12100
"""
import sys
import os
import re
import argparse

DEFAULT_MAX_LINE = 2000


def die(msg, code=2):
    sys.stderr.write("ERROR: " + msg + "\n")
    sys.exit(code)


def open_text(path):
    # UTF-8 优先；解码失败用 replace 兜底，绝不让整命令崩。
    return open(path, "r", encoding="utf-8", errors="replace")


def is_binary(path, sample_bytes=8192):
    try:
        with open(path, "rb") as f:
            chunk = f.read(sample_bytes)
        return b"\x00" in chunk
    except OSError as e:
        die("无法打开文件: %s" % e)


def truncate(line, maxlen):
    if len(line) > maxlen:
        return line[:maxlen] + " …(truncated %d chars)" % (len(line) - maxlen)
    return line


def line_prefix(lineno, marker=""):
    if marker:
        return "%sL%d: " % (marker, lineno)
    return "L%d: " % lineno


# ---------- 子命令实现 ----------

def cmd_info(args):
    path = args.path
    if not os.path.isfile(path):
        die("文件不存在: %s" % path)
    binary = is_binary(path)
    total_bytes = os.path.getsize(path)
    total_lines = 0
    max_width = 0
    # 逐行流式统计，不一次性载入
    with open_text(path) as f:
        for line in f:
            total_lines += 1
            w = len(line.rstrip("\n").rstrip("\r"))
            if w > max_width:
                max_width = w
    print("path        : %s" % path)
    print("exists      : yes")
    print("bytes       : %d" % total_bytes)
    print("lines       : %d" % total_lines)
    print("max_line_width: %d" % max_width)
    print("encoding    : utf-8 (errors=replace)")
    print("binary      : %s" % ("YES — 不建议当文本读，请用 hex/专用工具" if binary else "no"))
    if max_width > args.max_line_len:
        print("note        : 存在超长行(>%d)，读取时会被自动截断" % args.max_line_len)


def cmd_head(args):
    n = args.n
    count = 0
    with open_text(args.path) as f:
        for line in f:
            if count >= n:
                break
            count += 1
            print(line_prefix(count) + truncate(line.rstrip("\n").rstrip("\r"), args.max_line_len))
    if count == 0:
        print("(empty file)")


def cmd_tail(args):
    n = args.n
    from collections import deque
    buf = deque(maxlen=n)
    idx = 0
    with open_text(args.path) as f:
        for line in f:
            idx += 1
            buf.append((idx, line.rstrip("\n").rstrip("\r")))
    if idx == 0:
        print("(empty file)")
        return
    for lineno, content in buf:
        print(line_prefix(lineno) + truncate(content, args.max_line_len))


def cmd_range(args):
    start = args.start
    end = args.end
    if start < 1 or end < start:
        die("range 需要 1 <= START <= END")
    lineno = 0
    printed = 0
    with open_text(args.path) as f:
        for line in f:
            lineno += 1
            if lineno < start:
                continue
            if lineno > end:
                break
            printed += 1
            print(line_prefix(lineno) + truncate(line.rstrip("\n").rstrip("\r"), args.max_line_len))
    if printed == 0:
        print("(该区间无内容)")


def cmd_grep(args):
    try:
        flags = re.IGNORECASE if args.i else 0
        pat = re.compile(args.pattern, flags)
    except re.error as e:
        die("正则错误: %s" % e)
    ctx = max(0, args.c)
    max_hits = args.m
    lineno = 0
    # 保留最近 ctx 行作为上下文缓冲
    recent = []  # list of (lineno, content)，窗口大小 = ctx+1（含命中行自身）
    hits = 0
    pending_ctx = 0  # 命中后还需输出的上下文行数

    def flush_held(held_lines):
        for ln, ct in held_lines:
            mark = ">> " if ct[1] else "   "
            print(line_prefix(ln, mark) + truncate(ct[0], args.max_line_len))

    with open_text(args.path) as f:
        for line in f:
            lineno += 1
            content = line.rstrip("\n").rstrip("\r")
            is_hit = bool(pat.search(content))
            recent.append((lineno, content))
            if len(recent) > ctx + 1:
                recent.pop(0)
            if is_hit:
                # 输出前文上下文 + 命中行
                block = list(recent)
                recent.clear()
                # 标记命中行
                block = [(ln, (ct, ln == lineno)) for ln, ct in block]
                flush_held(block)
                pending_ctx = ctx
                hits += 1
                if max_hits and hits >= max_hits:
                    print("…(已达 -m %d 上限，停止；如需更多请加大 -m)" % max_hits)
                    return
            elif pending_ctx > 0:
                print(line_prefix(lineno, "   ") + truncate(content, args.max_line_len))
                pending_ctx -= 1
    if hits == 0:
        print("(无命中)")


def cmd_between(args):
    try:
        flags = re.IGNORECASE if args.i else 0
        start_pat = re.compile(args.start_pat, flags)
        end_pat = re.compile(args.end_pat, flags)
    except re.error as e:
        die("正则错误: %s" % e)
    max_blocks = args.m
    lineno = 0
    in_block = False
    blocks = 0
    warned = False
    with open_text(args.path) as f:
        for line in f:
            lineno += 1
            content = line.rstrip("\n").rstrip("\r")
            if not in_block:
                if start_pat.search(content):
                    blocks += 1
                    if max_blocks and blocks > max_blocks:
                        if not warned:
                            print("…(已达 -m %d 上限，停止)" % max_blocks)
                            warned = True
                        continue
                    in_block = True
                    print("=== block %d starts at L%d ===" % (blocks, lineno))
                    print(line_prefix(lineno, ">> ") + truncate(content, args.max_line_len))
            else:
                print(line_prefix(lineno) + truncate(content, args.max_line_len))
                if end_pat.search(content):
                    print("=== block %d ends at L%d ===" % (blocks, lineno))
                    in_block = False
    if blocks == 0:
        print("(未找到匹配的起止块)")


def cmd_sample(args):
    step = max(1, args.step)
    lineno = 0
    with open_text(args.path) as f:
        for line in f:
            lineno += 1
            if lineno % step == 0:
                print(line_prefix(lineno) + truncate(line.rstrip("\n").rstrip("\r"), args.max_line_len))
    if lineno == 0:
        print("(empty file)")


def build_parser():
    p = argparse.ArgumentParser(
        description="大文件流式读取工具（只读不写）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--max-line-len", type=int, default=DEFAULT_MAX_LINE,
                   help="单行超长截断阈值（默认 %d）" % DEFAULT_MAX_LINE)
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("info", help="文件规模统计")
    pi.add_argument("path")
    pi.set_defaults(func=cmd_info)

    ph = sub.add_parser("head", help="前 N 行")
    ph.add_argument("path")
    ph.add_argument("n", type=int, nargs="?", default=50)
    ph.set_defaults(func=cmd_head)

    pt = sub.add_parser("tail", help="后 N 行")
    pt.add_argument("path")
    pt.add_argument("n", type=int, nargs="?", default=50)
    pt.set_defaults(func=cmd_tail)

    pr = sub.add_parser("range", help="行范围 START END（含端点）")
    pr.add_argument("path")
    pr.add_argument("start", type=int)
    pr.add_argument("end", type=int)
    pr.set_defaults(func=cmd_range)

    pg = sub.add_parser("grep", help="正则搜索 + 上下文")
    pg.add_argument("path")
    pg.add_argument("pattern")
    pg.add_argument("-i", action="store_true", help="忽略大小写")
    pg.add_argument("-c", type=int, default=2, help="上下文行数（默认 2）")
    pg.add_argument("-m", type=int, default=20, help="最多命中块数（默认 20，0=不限）")
    pg.set_defaults(func=cmd_grep)

    pb = sub.add_parser("between", help="抽取 START..END 之间的块")
    pb.add_argument("path")
    pb.add_argument("start_pat")
    pb.add_argument("end_pat")
    pb.add_argument("-i", action="store_true", help="忽略大小写")
    pb.add_argument("-m", type=int, default=20, help="最多块数（默认 20，0=不限）")
    pb.set_defaults(func=cmd_between)

    ps = sub.add_parser("sample", help="等间隔抽样")
    ps.add_argument("path")
    ps.add_argument("step", type=int, nargs="?", default=100)
    ps.set_defaults(func=cmd_sample)
    return p


def main():
    parser = build_parser()
    args = parser.parse_args()
    if not os.path.isfile(args.path) and args.cmd != "info":
        die("文件不存在: %s" % args.path)
    args.func(args)


if __name__ == "__main__":
    main()
