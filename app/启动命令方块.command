#!/bin/bash
# 备用启动脚本（macOS）。主入口是双击 ../命令方块.app。
# 用途：在受限终端/沙箱环境下，双击 .app 若不出现窗口，用这个脚本启动；
#       它额外传了 --no-sandbox --disable-gpu，只影响本脚本这次启动。
# 这是干什么的：不加载面板、不改数据，只把原生客户端窗口叫起来。
cd "$(dirname "$0")" || exit 1
unset NODE_OPTIONS
unset ELECTRON_RUN_AS_NODE
BIN="$(cd .. && pwd)/命令方块.app/Contents/MacOS/命令方块"
if [ ! -x "$BIN" ]; then
  echo "找不到 命令方块.app，请确认它和 app/ 在同一个「命令方块」文件夹里。"
  read -r -p "按回车关闭" _
  exit 1
fi
exec "$BIN" --no-sandbox --disable-gpu
