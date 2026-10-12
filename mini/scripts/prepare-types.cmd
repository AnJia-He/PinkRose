@echo off
rem =====================================================================
rem  prepare-types.cmd —— 重建 mini\types\（官方 typing，不随仓库走）
rem
rem  为什么要跑：mini\types\ 是第三方包 miniprogram-api-typings 的 .d.ts，
rem  没有进 git（太重）。新克隆下来的仓库里没有它，tsc 会报
rem  Cannot find name 'wx' —— 跑一遍本脚本就好。
rem  用法：资源管理器里双击，或在任意终端直接运行本文件。
rem
rem  注意：本文件是 GBK 编码（中文 Windows 的 cmd 就按 GBK 读）。
rem  别把它存成 UTF-8：那样中文会让 cmd 的行切分错位、报怪错。
rem =====================================================================
setlocal
pushd "%~dp0..\.."
if errorlevel 1 (
  echo [types] 没找到仓库根目录 —— 请确认本脚本还在 mini\scripts\ 里。& exit /b 1
)

if exist "node_modules\miniprogram-api-typings\types\index.d.ts" (
  echo [types] 本机已有 miniprogram-api-typings，直接拷。
) else (
  echo [types] 本机还没有 miniprogram-api-typings，先装一份（--no-save，不动 package.json）...
  call npm i --no-save --no-package-lock miniprogram-api-typings
  if errorlevel 1 (
    echo [types] npm 安装失败 —— 检查网络后重跑本脚本。& exit /b 1
  )
)

if not exist "mini\types" mkdir "mini\types"
xcopy /s /y /q "node_modules\miniprogram-api-typings\types\*" "mini\types\" >nul
if errorlevel 1 (
  echo [types] 拷贝失败 —— 看看 node_modules\miniprogram-api-typings\types\ 是否完整。& exit /b 1
)

echo [types] 完成！mini\types\ 已就绪（它不随仓库走，每台机器跑一次即可）。
echo [types] 类型检查：npx tsc -p mini --noEmit
popd
endlocal
