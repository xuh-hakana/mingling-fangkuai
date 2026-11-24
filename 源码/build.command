#!/bin/zsh
# 编译 命令方块.app · 双击运行
# 只在改过 launcher.m / Info.plist / 图标后需要跑一次；平时直接双击 命令方块.app。
set -e
cd "$(dirname "$0")" || exit 1

ROOT="$(cd .. && pwd)"
APP="$ROOT/命令方块.app"

if ! command -v clang >/dev/null 2>&1; then
  echo "没有找到 clang。先装 Xcode 命令行工具：xcode-select --install"
  read -r "?按回车关闭…"
  exit 1
fi

echo "→ 清理旧包"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "→ 编译原生窗口"
clang -fobjc-arc -O2 -framework Cocoa -framework WebKit launcher.m -o "$APP/Contents/MacOS/命令方块"
chmod +x "$APP/Contents/MacOS/命令方块"

echo "→ 写入 Info.plist"
cp Info.plist "$APP/Contents/Info.plist"

if [ -f "AppIcon.icns" ]; then
  echo "→ 写入图标"
  cp "AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
fi

echo "→ 本地签名"
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "  （签名跳过，不影响本机运行）"

touch "$APP"
echo ""
echo "完成：$APP"
echo "双击它就能开，不用终端。"
