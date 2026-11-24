@echo off
chcp 65001 >nul
rem 命令方块 · Windows 启动脚本。这是干什么的：装好 Electron 后启动同一个客户端窗口。
rem 与 macOS 的区别：Windows 没有 .app 外壳，走 npm 里的 Electron，代码仍是同一份 app\ + web\。
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 需要 Node.js 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\electron\package.json" (
  echo 首次运行，正在安装 Electron 45.2.1 ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE="
start "" "node_modules\.bin\electron.cmd" .
exit /b 0
