@echo off
chcp 65001 >nul
rem 提词器独立客户端 · Windows 启动脚本。这是干什么的：单独启动提词器客户端窗口。
rem 与命令方块.bat 的区别：入口是 prompter-main.js，是另一个进程；需求库数据仍共用一份。
rem Windows 没有 .app 外壳，走 npm 里的 Electron，代码仍是同一份 app\ + web\。
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
start "" "node_modules\.bin\electron.cmd" prompter-main.js
exit /b 0
