# PinkRose 小程序（mini/）

「户外快速修图」微信原生小程序。**选照片 → 挑风格 / 说一句 → 按住对比 → 存相册。**
设计文档：`docs/superpowers/specs/2026-10-12-miniprogram-outdoor-quick-edit-design.md`。

## 怎么跑

1. 装好**微信开发者工具**（本机在 `D:\微信web开发者工具\`）。
2. 工具里：设置 → 安全设置 → **打开服务端口**（不开 CLI 用不了）。
3. 打开本目录作为项目（导入 `mini/`）。`project.config.json` 里那个
   `wx3222d31da4ec7edb` 是**暂时借的测试号**（等用户定正式号再换）。
   ⚠️ **开发者工具处在登录态时，用这个号打开会报「不存在此 AppID」**
   （登录态会拿 appid 去服务端校验，测试号没有正式号属性）。
   本机验证时走的是**游客态**：把工具缓存里这个项目的 appid 记成
   `touristappid`（`WeappLocalData/localstorage_*.json` 里三处）才打开成功。

命令行起（PowerShell，中文路径别走 Git Bash）：

```powershell
$d = (Get-ChildItem 'D:\' -Directory | Where-Object { $_.Name -match '开发者工具' }).FullName
& (Join-Path $d 'cli.bat') agent start --project 'D:\RuiXing\mini' --trust-project
```

自动化冒烟用 `miniprogram-automator` 连 `ws://127.0.0.1:9420`（`agent start` 会开这个端口）。

**2026-10-12 已验证整条回路跑通**：`agent start` → 等 ~30–60 秒 →
`automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })` → `mp.currentPage()`
（`pages/index/index`）、`page.data()`、`mp.screenshot({ path })` 全部可用，
截图落在 `.superpowers/mini/`（探针脚本 `probe-automator.cjs` 可照抄）。

## 类型检查

```bash
npx tsc -p mini --noEmit
```

`mini/types/`（官方 `miniprogram-api-typings` v5.2.3 的 .d.ts）**不随仓库走** ——
它是第三方包内容，别进 git 历史。每台机器跑一次：

```bat
mini\scripts\prepare-types.cmd
```

脚本会「包不存在就先 `npm i --no-save --no-package-lock miniprogram-api-typings`」
再拷进 `mini/types/`；**没有**构建 npm、**没有**动电脑版 `package.json`。
没生成时 `tsc` 会报 `Cannot find name 'wx'`，跑一遍脚本就好。

## API 地址怎么改

「说一句」走电脑版后端。地址在 `lib/config.ts`（后续任务加）——
电脑的**局域网 IP + vite 端口 5173**，例如 `http://192.168.1.6:5173`。
换网络（家里 / 公司）就改这一个常量；上云时也改它。

## 自动化通道用的是哪条

微信开发者工具 2.02.2608070 上**官方 `cli agent` 这套**（`agent start` 开常驻
自动化服务 + `miniprogram-automator` 连接），是 2026-09 探针验证过的
CLI + automator 路径的现役版本。⚠️ 本机的网络策略挡住了微信的部分服务域名
（`servicewechat.com` 等不通），工具里的一些在线功能（插件下载、正式号权限、
登录状态刷新）会超时——离线时用**游客态 + 本地编译**跑，不受影响的部分照常。

### 已知的坑（踩过）

- CLI 的 `auto` / `agent start` 是**常驻进程**：别同步等它返回，用
  `Start-Process` 之类的方式起；它自己要开 GUI 窗口。
- 起 CLI 的 PowerShell 脚本如果含中文，**必须带 UTF-8 BOM**，不然
  PowerShell 5.1 按 GBK 读会把脚本里的事件名读坏、解析报错。
- ⚠️ CLI 的 `open`/`agent start` **读的是工具缓存里的项目记录**（`WeappLocalData/`），
  不是磁盘上 `project.config.json` 的新值——改了文件里的 appid 不重启流程不生效。
- ⚠️ 探针里别用 `page.callMethod()` 等页面长任务（会超时）；用
  「点按钮 + 轮询 `page.data()`」的写法。
- 类型脚本（`.ts`）能编译，靠的是 `project.config.json` 里的
  `"useCompilerPlugins": ["typescript"]`——少了这一条，工具会把
  `pages/index/index.ts` 当空气、报「未找到 pages/index/index.js」。
- 电脑版改了 `src/styles.css` 的深色令牌时，`app.wxss` 里那份手工镜像
  要跟着看一眼（那边是 `light-dark(浅, 深)` 配对，这边只抄深色那半）。
