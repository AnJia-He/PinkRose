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

**真机（Task 13b 验收）**：工具里「预览」→ 手机扫码。换正式 AppID、配后端
`WX_APPID`/`WX_SECRET`、`config.ts` 换 IP 这几步缺一不可 —— 照着文末
「验收记录」的**开工前四件事**走。

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

## 冒烟 + 全黑哨兵

```bash
node mini/scripts/smoke.cjs
```

**为什么有它**：GLSL 编不过 = **每张照片全黑**，而 typecheck / 构建 / 单测四样全瞎
（电脑版 2026-10-05 真机抓到过一次，来路写在 `src/render/shader.ts` 顶上）。
只有「真渲染 + 读像素数颜色」这条探针抓得到 —— 纯色画布就是静默失败。

先按上面「怎么跑」起好 CLI（它开 `ws://127.0.0.1:9420`），再跑脚本。它做四件事：

1. 先跑 `node scripts/sync-mini-shared.mjs --check` —— 镜像漂了直接失败退出（别测漂的镜像）；
2. 进主页面 → 点**仅开发版可见**的「载入测试照片」按钮（`dev` = `wx.getAccountInfoSync()
   .miniProgram.envVersion === 'develop'`，wxml `wx:if` 判的；照片是打进包的
   `assets/test-photo.jpg`，绕开系统选图弹窗）→ 等风格栏 13 格就绪；
3. 对 13 档（原图 + 12 预设）逐档：点那一格 → 轮询 `activeStyle` 确认 → 调页面上的
   `__probeColors()`（纯读、16×16 网格数颜色、同步返回 `{colors, first, err}`）；
4. 断言：每档 `colors > 1`（纯色 = 全黑/全白的静默失败）且 `err === 0`、
   「原图」与「黑白」两档 `first` 不相同。**失败会存截图**
   （`.superpowers/mini/smoke-fail-*.png`）并 exit 1；全过 exit 0。

⚠️ 测试图 `assets/test-photo.jpg`（159 KB）就放在包里 —— **别给它加
`packOptions.ignore`**（2026-10-12 试过、又撤了）：那条实测**连本地模拟器编译
也一起生效**，同一个包里徽章标读得到、它读不到（`getImageInfo` 报
`getImageInfo:fail file not found`、`statSync` 报 `permission denied`），
而冒烟恰恰要在模拟器里读它。不 ignore 也没事：整个小程序包（含这张图）才
334 KB，离 2 MB 主包上限远得很。
⚠️ 冒烟跑的是**模拟器**（电脑显卡）：它筛得掉编不过的着色器，答不了「真机跑不跑得动」。

## 「说一句」冒烟（Task 12）

```bash
node mini/scripts/smoke-say.cjs
```

同样是 CLI 起好、automator 连着跑，但**后端换成本地 mock**（`mini/scripts/mock-server.cjs`，
端口 4399，脚本会自己起、跑完自己杀；4399 上已有别人起着的就直接用）—— 真钱一分不花。
它把页面上的 API 地址**运行期**指到 mock（`__probeSetApiBase`，收尾指回 config），
然后跑六段：params（「亮一点」）/ generate（「把路人去掉」+ 撤销）/ both（「亮一点再去掉路人」）/
degraded（「随便修一下」）/ 拿不准（「把那个人去掉」）/ 停止 + 秒表（mock 延时改 20 秒，
点「停止」后靠 mock 的 `/mock/stats` 里 `editAborted` 计数证明确实掐断了连接）。
34 条断言，截图存 `.superpowers/mini/say-*.png`。
mock 的决策表在 `mock-server.cjs` 的 `decide()` 里，按关键词走；改它只影响冒烟。

## API 地址怎么改

「说一句」走电脑版后端。地址在 `lib/config.ts` 的 `API_BASE` ——
电脑的**局域网 IP + vite 端口 5173**（例如 `http://192.168.1.7:5173`）。
换网络（家里 / 公司）就改这一个常量；上云时也改它。

⚠️ **config.ts 里现在写的是 `http://192.168.1.6:5173`（旧网络的值）**；本机
2026-10-12 实测的 WLAN IP 是 **`192.168.1.7`** —— 真机验收前把这一个常量改过来
（见文末「验收记录」开工前第 3 条）。

怎么知道电脑的局域网 IP：PowerShell 里 `ipconfig` → 找正在用的网卡那一行
「IPv4 地址」（通常是 `192.168.x.x`；一台机器可能列出好几个 `192.168.x.1`
的**虚拟网卡**——挑手机所在 WiFi 的那块，别选错）。配套三件事缺一不可：

1. 电脑上跑着 `npm run dev`（vite 把 `/api` 代理给后端；后端自己只听 127.0.0.1）；
2. 手机和电脑**连同一个 WiFi**；
3. 电脑防火墙放行过 5173（首次可能要弹窗点允许）。

`API_BASE_OVERRIDE` 是调试 / 冒烟用的**临时覆盖**（api.ts 优先取它）：模拟器
跑在电脑上时填 `http://127.0.0.1:8787` 直连后端本体，比绕局域网稳。
⚠️ **验完改回空串** —— 留着它真机就会往一个跑不到的地方打，症状只有"一直连不上"。

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
- ⚠️ **`mockWxMethod` 的 mock 函数要「既回调、又返回结果对象」**（2026-10-12 反混淆
  devtools 的 shim 确认）：对**非 Sync** 的 API，shim 会把 options 里的
  `success/fail/complete` **剥掉**再喂给你的 mock，并拿 **mock 的返回值**当 API 结果
  （`errMsg` 不含 `:ok` → 走 fail，否则走 success）。只管回调、`return undefined`
  的 mock 在当前构建上会报 `Cannot read properties of undefined (reading 'errMsg')`
  且调用方 promise **永不 settle**（保存流程会卡死在"保存中"）。写法：
  `async function (opt) { …; if (opt.fail) opt.fail(res); return res }`。
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

## 全尺寸导出存相册（2026-10-12 模拟器验收）

顶栏「保存」= **全尺寸导出**（照片原尺寸，不是屏幕上缩过的那张小图）→ 写进手机相册。
实现在 `lib/image/export.ts`（`exportPhoto` + `saveToAlbum`），页面只管防重入和 toast。

- **导出**：画布 buffer 本来就是照片原尺寸（`resizeToImage` 设的），导出只是**按目标尺寸
  重画一帧** → `wx.canvasToTempFilePath({canvas: 画布节点, fileType:'jpg', quality:0.92})`。
  设备上限兜底 = `min(MAX_TEXTURE_SIZE, MAX_VIEWPORT_DIMS)`（管线新方法 `maxCanvasSide()`）+
  共享 `fitWithin` —— 模拟器 16384，基本不触发；真机老机器超上限时会缩并在控制台说清楚。
  导出完画布**还回屏幕**（resize 回原尺寸 + 当前参数重画，`finally` 里，失败也还）。
- **双路径（Ruling 5）**：① canvas 路（上面那条，**默认先走**）；①报错、**或①导出的
  文件是纯色**（下方防线②）才退 ② pixels 路：
  `readPixels()` → 翻行（`lib/image/pixels.ts`，风格栏拼图共用同一份）→ 离屏 2D 画布
  `putImageData` → 从那张 2D 画布导出。
  **实测（2026-10-12 模拟器）：① 就通，② 也通** —— webgl 画布认 `canvasToTempFilePath`
  （Ruling 5 担心的"不认"没出现）。两条路各跑一遍，画面逐格 diff = 0。
  **当前线上走的是 ①**；真机上 ① 若报错会自动落 ②，控制台依次能看到
  `[export] 画布直接导出不行，改走像素兜底：…` 和 `[export] 导出完成（pixels 路）`。
- **两道空白防线**（2026-10-12 审查 Critical 后补：「① 报错才退」防不住"没报错但导出的
  是空白"，黑图配「已存到相册」是这项目记过的最坏结果）：
  ① **buffer 断言（两路共用）**——渲染后、导出前，16×16 网格数颜色（照 `__probeColors`），
  纯色 = 这张图没画出来 → 抛人话 toast、**不进相册、也不落 ②**（两路都会是同一张纯色图）；
  ② **文件级空白检查（只保 ① 路）**——① 的回调"成功"了，也要把文件画进 64×64 离屏 2D
  画布采样（每通道极差 ≤ 8 视为纯色，JPEG 会压出几阶差），纯色就当 ① 失败自动落 ②。
  ① 的 success 回调给**空路径**也算失败。两条防线各有变异检查（见 `task-9-report.md`）。
- **实测数字**（模拟器，测试图套「黑白」；2026-10-12 补完两道防线后的数，含防线成本）：

  | 照片尺寸 | ① canvas | ② pixels | 导出的 JPG |
  |---|---|---|---|
  | 1080×2048 | 110–125ms | 146–182ms | 167 KB |
  | 4032×3024（12MP） | 470ms | 797ms | 1513 KB |

  两种尺寸导出后 `wx.getImageInfo` 的宽高都 == 照片原尺寸（探针断言过）。
- **授权**：第一次调 `saveImageToPhotosAlbum` 弹**系统框**（模拟器真机实测，截图在
  `.superpowers/mini/task9-real-save-*.png`）；被拒过一次后系统框不再弹，接口直接
  `auth deny` —— 这时弹人话 modal（「去设置 / 算了」）→ 点「去设置」才开
  `wx.openSetting` → 回来若已允许**自动重存一次**。三条路（拒了→开了→自动重存 /
  拒了→算了 / 去了设置但没开）探针都走通过。
- ⏳ **待真机**：真机导出耗时、相册里真的出现照片、首存的系统框样子。

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
  回复超时；automator 客户端本身没有超时设置）。1440×1152 / 1080×2048 截图正常；
  4032×3024（12MP）也会偶发超时（2026-10-12 Task 9 探针：同一张连报两次，重试
  仍超时就只记一笔接着跑）。渲染本身没问题（同屏 readPixels 249 色、`getError()`=0）
  —— 大图验收只信 readPixels，或先把画布换成小图再截图。
- **真·保存（未 mock）在模拟器里弹系统授权框**（`saveImageToPhotosAlbum`，
  文案是「…希望获取 saveImageToPhotosAlbum 的操作权限」+ 拒绝 / 允许）。⚠️ 这个框
  **不点掉会一直挂着**（`mp.native().cancelModal()` 收不掉它 —— 那是给 wx.showModal
  用的），而且它**不挡 automator 的 evaluate / callMethod**：2026-10-12 探针的
  12MP 那一批 + 后一趟冒烟 43/43 都是在框挂着的情况下跑完的。截图时它会占掉
  屏幕下半截（要拍底部的东西先手工把它点了）。
- **参数真的进管线**：readPixels 数颜色只是「画出来了」；探针还量了「参数生效」——
  `exposure 0 → 50` 重渲后 16×16 网格平均亮度 103.2 → 121.4（真照片 1080×2048）。
- **开发者工具网络栈会「重发」一次被半路杀掉的 POST**（2026-10-12 隔离实验钉死；
  症状很像"应用偷偷重试"，其实不是）：请求走在**复用中的 keep-alive 连接**上、
  还没收到任何响应字节就被对端杀掉时，工具层会自动换条新连接重发一次（POST 也发
  —— Chromium 的经典重试语义）；**全新连接**上同样被杀就**不重发**。证据
  `.superpowers/mini/probe-retry-isolation.cjs`：先一条 200 把连接养活着 → 断线请求
  同端口命中后 ~10ms 在新端口重发 = 服务端命中 2；对照组（新连接）= 1。
  失败注入探针里 `/api/edit` 命中翻倍就是这个 —— 应用侧给 `wx.request` 包一层打
  调用栈证明**每次只发一个**，mock 冒烟正常流程也从不翻倍（4 次生成 = 命中 4）。
  ⚠️ 待真机：真机客户端行不行为没验过；真后端只要正常应答就碰不到它
  （要"服务器把半路连接杀了"才触发）。

## 验收记录（Task 13b · 真机）

**这是真机验收的清单** —— 每跑完一条把「结果」填上（`✅` / `❌` + 一句话）；失败的话
把现场（机型 / 微信版本 / 截图 / 控制台那句原话）记在表下面。冒烟盖不到的东西全在这；
模拟器已绿的是风格逐档（`smoke.cjs` 43/43）和说一句六场景（`smoke-say.cjs` 34/34，
2026-10-12）—— 真机要的是"这些在手机上同样成立"。

**开工前四件事**（缺一件真机就连不上 / 进不去）：

1. **换正式 AppID**：`project.config.json` 里借的测试号 `wx3222d31da4ec7edb` 换成
   用户自己的正式号（工具里重新导入；工具缓存里的项目记录也要跟着走，见上面「已知的坑」）。
2. **后端配微信登录**：`.env` 里 `WX_APPID` / `WX_SECRET`（和上面是同一对号）——
   配不齐 `/api/wx-login` 直接回 503，「说一句」的全流程起不来。⚠️ 后端出站还要能到
   `api.weixin.qq.com`（本机网络策略此前挡过 `servicewechat.com` 等域名，这条当场验）。
3. **`mini/lib/config.ts` 的 `API_BASE` 换成电脑当前局域网 IP + 5173**。
   ⚠️ 现在写的是 `http://192.168.1.6:5173`（旧值）；本机 2026-10-12 实测 WLAN IP 是
   **`192.168.1.7`** —— 换网络后先用 `ipconfig` 重看（别选到 `192.168.x.1` 的虚拟网卡）。
   `API_BASE_OVERRIDE` 保持空串（它是模拟器 / 冒烟专用的临时覆盖）。
4. **电脑 `npm run dev` 起着 + 手机和电脑同一 WiFi + 防火墙放行 5173**（首次弹窗点允许）。

进真机：工具里「预览」→ 手机扫码（真机调试可选）。截图 / 探针照旧落 `.superpowers/mini/`。

| # | 验什么 | 怎么算过 | 结果 |
|---|---|---|---|
| 1 | 拍照进 | 系统相机拉得起来；拍完的照片进编辑台 | |
| 2 | 相册进 | 选的照片进编辑台，尺寸 / 方向正确 | |
| 3 | 换一张 | 左上角回空态、不残留上一张；再进一张正常 | |
| 4 | 风格每一档 | 13 格（原图 + 12 预设）逐档点，每档画面真有变化 | |
| 5 | 按住看原图 | 按住出现原图、松手回成片（有按压反馈） | |
| 6 | 说一句出图 | 「把路人去掉」→ 出图 + 浮条那句话 + 「撤销」亮 | |
| 7 | 等待秒数 | 秒表：开头「正在修…」不带数字，5 秒后「已经等了 N 秒」且 N 在走 | |
| 8 | 停止 | 生成中点「停止」→ 蒙层收、浮条「停了。」、画面和撤销都没动 | |
| 9 | 撤销 | 回到发前（画面 + 参数），按钮收掉 | |
| 10 | 存相册清晰度 | 「保存」进相册的是**全尺寸**（相册里放大看细节是清楚的） | |
| 11 | 30 秒线实测 | 真 API 全流程（路由 + 生成）出图秒数记下来 | |
| 12 | 授权往返 | 首存弹系统框；拒一次再存 → 弹人话框 → 「去设置」允许 → 自动重存 | |
| 13 | 胶囊让位 | 顶栏不被右上角胶囊压住；窄屏图标让位正常 | |
| 14 | API_BASE 改成实际 IP | 开工前第 3 条改完，真机能连上（连不上先查这条） | |
| 15 | 微信登录真 code | 不弹登录页、能出图；若蹦「微信登录没成功，再试一次」那类错 = 这条没通 | |
| 16 | 系统框 | 相机 / 相册 / 存相册三类系统框：文案与首拒后的行为对得上 | |

**失败现场**（机型 / 微信版本 / 截图路径 / 控制台原话）—— 13b 跑的时候往下写。
