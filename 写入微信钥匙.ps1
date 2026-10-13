# PinkRose 小程序 —— 把剪贴板里的 AppSecret 写进 .env
# 用法:先在微信后台复制好 AppSecret,再双击「写入微信钥匙.cmd」
$ErrorActionPreference = 'Stop'
$envFile = 'D:\RuiXing\.env'
$appid = 'wx268e2cf86a5b1c4c'

Write-Host ''
Write-Host '=== PinkRose 小程序:写入微信钥匙 ===' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path $envFile)) {
  Write-Host '找不到 .env 文件。先双击「启动.cmd」让项目跑过一次,再回来双击本文件。' -ForegroundColor Yellow
  Read-Host '按回车关闭'
  exit 1
}

$secret = (Get-Clipboard -Raw).Trim()
if ($secret -notmatch '^[0-9a-fA-F]{32}$') {
  Write-Host '剪贴板里没找到钥匙(应为 32 位字母数字)。' -ForegroundColor Yellow
  Write-Host '请先在微信后台「开发管理 - 开发设置」里生成并复制 AppSecret(只复制那一串),再双击本文件。'
  Read-Host '按回车关闭'
  exit 1
}

# 首次 = 纯追加(不动原文,零风险);已有旧钥匙行 = 先备份再重写
$existing = Get-Content $envFile -ErrorAction SilentlyContinue
$hasOld = $existing | Where-Object { $_ -match '^\s*WX_(APPID|SECRET)\s*=' }

if ($hasOld) {
  $bak = "$envFile.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item $envFile $bak
  Write-Host ("旧钥匙行已备份到: " + $bak)
  $kept = @($existing | Where-Object { $_ -notmatch '^\s*WX_(APPID|SECRET)\s*=' })
  $kept += "WX_APPID=$appid"
  $kept += "WX_SECRET=$secret"
  [System.IO.File]::WriteAllLines($envFile, [string[]]$kept, (New-Object System.Text.UTF8Encoding($false)))
} else {
  Add-Content -Path $envFile -Value @("WX_APPID=$appid", "WX_SECRET=$secret") -Encoding UTF8
}

Write-Host ''
Write-Host 'OK - 钥匙已写入。' -ForegroundColor Green
Write-Host ''
Write-Host '最后一步:重启服务 —— 关掉原来跑着服务的黑色窗口,再双击一次「启动.cmd」。'
Read-Host '按回车关闭'
