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
- ⚠️ **自动化会话「半死不活」的症状**：`mp.mockWxMethod('chooseMedia', …)` 报
  `wx.chooseMedia not exists`，而且从那以后 `wx.chooseMedia` 直接变成 `undefined`
  （那次失败的 mock 把 API 抹掉了）。这是**会话坏了，不是代码坏了** ——
  2026-10-12 撞上两次。处置：完整重启 —— `cli quit` → **等 61523 端口真的消失**
  → `cli auto`（旧的 `task4-restart.ps1` 是固定 sleep 15 秒，会抢跑留半截状态；
  `task5b-restart.ps1` 改成了等端口）。
- 类型脚本（`.ts`）能编译，靠的是 `project.config.json` 里的
  `"useCompilerPlugins": ["typescript"]`——少了这一条，工具会把
  `pages/index/index.ts` 当空气、报「未找到 pages/index/index.js」。
- 电脑版改了 `src/styles.css` 的深色令牌时，`app.wxss` 里那份手工镜像
  要跟着看一眼（那边是 `light-dark(浅, 深)` 配对，这边只抄深色那半）。

## 已知平台行为（2026-10-12 模拟器实测；标「待真机」的没验过）

探针：`.superpowers/mini/task5-probe.cjs` / `task5-followup.cjs`（真照片走
`lib/gl/tonePipeline.ts` 上屏，readPixels 数颜色 + 截图）。

- **texImage2D 上传（1281 的谜底）**：**不能把 `node.createImage()` 的 Image 对象
  直接交给 texImage2D** —— 2026-09 探针那样传，最大一档报 1281（`GL_INVALID_VALUE`）。
  正确姿势是先画进同尺寸**离屏 2D 画布**（`wx.createOffscreenCanvas({type:'2d',
  width, height})` + `drawImage`）再上传 —— `tonePipeline.ts` 的 `setImage` 就是这条。
  实测三档全过（模拟器 PC GPU，MAX_TEXTURE_SIZE=16384、MAX_VIEWPORT_DIMS=32767×32767）：
  1440×1152 / 1080×2048 / **4928×6560（32.3 MP）** 上传后 `getError()` 都是 0，
  **不需要任何降尺寸阶梯**。⚠️ 待真机：手机 GPU 的 MAX_TEXTURE_SIZE 可能小于 6560，
  真机上要么直接过、要么得缩到上限内再传（管线里出错会抛带尺寸的人话错误）。
- **texImage3D（Lut 的 3D 纹理）**：模拟器上 1×1×1 白点的 texImage3D 建得出来
  （`getError()`=0，`lutOk=true`）。代码仍留了降级：万一报错就整个关掉 Lut
  （不绑 3D 纹理、`lutOn` 恒 0、`setLut` 变 no-op + 控制台一句警告），照片照常渲染。
  ⚠️ 待真机：老机器/老基础库上 3D 纹理能不能建，真机验收时看 `lutOk`。
- **上下文属性认不认**：`node.getContext('webgl2', {alpha:false,
  premultipliedAlpha:false, preserveDrawingBuffer:true})` —— 第二参数 typings 里
  没写，但运行时会认：`getContextAttributes()` 实测回
  `{pdb:true, alpha:false, premul:false, aa:true}`。`preserveDrawingBuffer:true`
  是导出（保存相册）拍空图的解药之一（合成后缓冲随时可能被清）。
- **readPixels 的「保鲜」**：`gl.readPixels` 能正常读回；但探针里**读之前先重渲一帧**
  再读最稳（本仓库探针都这么做）。行序自下而上（GL 约定，同电脑版注释）。
- **`mp.screenshot` 在大画布上会超时**：画布是 4928×6560 时，
  `mp.screenshot` 报 `timeout waiting for automator response`（**开发者工具侧**的
  回复超时；automator 客户端本身没有超时设置）。1440×1152 / 1080×2048 截图正常。
  渲染本身没问题（同屏 readPixels 249 色、`getError()`=0）—— 大图验收只信
  readPixels，或先把画布换成小图再截图。
- **参数真的进管线**：readPixels 数颜色只是「画出来了」；探针还量了「参数生效」——
  `exposure 0 → 50` 重渲后 16×16 网格平均亮度 103.2 → 121.4（真照片 1080×2048）。
