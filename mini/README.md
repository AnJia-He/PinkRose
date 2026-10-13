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

## 页面结构 · 底部 tabBar（Task 16）

v1.1 起是三页 + 原生 tabBar（spec §13）：**修图**（`pages/index/index`，第一个 = 启动页）/
**作品**（`pages/works/works`，真页面 —— 存储见下面「本地作品集」那节）/ **我的**
（`pages/me/me`，真页面 —— 品牌区 + 本地作品统计 / 清空 + 版本页脚）。配置在 `app.json` 的 `tabBar` 段 —— ⚠️ **四个颜色值是 app.wxss
令牌的手抄**（json 写不了注释）：`color #b9b9c3` = `--muted` / `selectedColor #2dd4bf`
= `--accent-400` / `backgroundColor #151517` = `--bg` / `borderStyle black`（只有
black/white 两值）—— **改令牌时这里跟着改**。

图标 = `mini/assets/tab/{edit,works,me}{,-on}.png`（6 张 81×81 透明底，各 ~2KB）。
源 SVG（lucide 线性语言，线宽 1.5@24，和全站图标同一套规矩）在 `mini/scripts/tab-icons/`，
**改了源就跑**（出图 = Playwright + 系统 Edge，同 logo 徽章那条管线）：

```bash
node mini/scripts/build-tab-icons.mjs
```

⚠️ 图标 PNG 会被根 `.gitignore` 的 `*.png` 吃掉 —— 已放行（`mini/.gitignore` 的
`!assets/tab/*.png`），别删那条（少了它们 tabBar 图标位是**空的**，不报错、静默少一块）。

**真机看什么**：三 tab 来回切、选中变色；**切走再回修图页，现场还在**（tab 页不销毁，
模拟器已验：切回后 stage/照片盒子逐项一致）；tabBar 和底部 home indicator 不打架；
照片仍然完整、不被 tabBar 压住（tabBar 占掉屏底一条、窗口矮了 82px —— 布局是按实测
算的自适应，模拟器已量过：间隙 23.8rpx×2、`.page` 高 = 视口高，真机再眼睛过一遍）。

⚠️ 对修图页的**唯一触碰**（Task 16）：`index.wxss` 两处撤掉 `env(safe-area-inset-bottom)`
（`.empty` / `.say-bar` 的底部 padding）—— 底部安全区归 tabBar 管了，页面再补就是往
tabBar 上方多留 34px 死区（实测：say-bar 高 94.6→60.6、照片因此 +34px 高）。逐行理由
在 `task-16-report.md`。

## 本地作品集 · 「作品」页（Task 17）

**存哪**：手机本地 —— `wx.env.USER_DATA_PATH/works/` 目录（每张两个文件：全尺寸
`w<id>.jpg` + 缩略图 `w<id>t.jpg`，缩略图长边 ~256px 从导出的全尺寸缩出来）＋ storage
一份清单（key `works:v1`，JSON 数组、新的在前，一条 `{ id, file, thumb, w, h, bytes, at }`）。
**不传服务器**；⚠️ 已知边界（spec §13.2）：**删小程序 / 换手机即失**，不做清单自愈
（读到坏文件自然裂图，「清空」兜底）。实现在 `mini/lib/works.ts`（list / add / remove /
clear / usage 五个出口）。

**保存怎么进作品**：修图页「保存」在存相册**成功之后**顺带 `works.add`（`onSave` 里
火忘，不 await）—— **相册是主承诺**：写作品失败只打控制台，界面上照旧只有「已存到相册」。
**唯一例外**：总占用到 **150MB 上限**（本机文件系统总盘 200MB 留余量）时补一条
`作品放满了，去「我的」清一清`（会把「已存到相册」顶掉 —— 有意：相册里确实有图）。
清空入口在「我的」页（品牌区 + 「N 张 · X MB」数字卡 + 清空按钮 —— Task 18）。

**页面行为**（`pages/works/`）：两列缩略图网格（flex wrap；格 333rpx 见 wxss 里的
「三个数一套账」）；`onShow` 重新 list（切 tab 回来要看到新作品）；点格 →
`wx.previewImage` 原生大图（左右滑、保存/转发白拿）；**长按格** → 「删除这张作品吗？」
确认框（modal 一步到位，不走 ActionSheet）→ 删文件 + 刷清单；空态 = 「还没有作品」+
「去修一张」（`switchTab` 回修图页）。冒烟入口 = `index.ts` 的 `__probeSaveWork()`
（真导出 + 收作品，**不碰相册**；结果挂实例字段，探针专用）。

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
而冒烟恰恰要在模拟器里读它。不 ignore 也没事：mini/ 全部文件加起来（不含本机生成的
`types/`）才 ~590 KB —— 其中测试图 159 KB + 本轮内嵌字体 119 KB —— 离 2 MB 主包上限远得很。
⚠️ **发布前要摘掉 dev 通道的两样**：包里的测试图 `assets/test-photo.jpg`、和
「载入测试照片」那颗按钮（wxml `.dev-btn` + onLoad 算的 `dev` 判据 + index.ts 的
`DEV_PHOTO` / `onDevPhoto`）—— **只能改代码 / 删文件**（给图加 `packOptions.ignore`
上面试过：连模拟器一起剥，不可行）。三个冒烟都靠这颗按钮进编辑态，留到验收后再摘。
⚠️ 冒烟跑的是**模拟器**（电脑显卡）：它筛得掉编不过的着色器，答不了「真机跑不跑得动」。

## 「说一句」冒烟（Task 12；**Task 14 起按「对话留痕」重写**）

```bash
node mini/scripts/smoke-say.cjs
```

同样是从 CLI 起好、automator 连着跑，但**后端换成本地 mock**（`mini/scripts/mock-server.cjs`，
端口 4399，脚本会自己起、跑完自己杀；4399 上已有别人起着的就直接用）—— 真钱一分不花。
它把页面上的 API 地址**运行期**指到 mock（`__probeSetApiBase`，收尾指回 config），
然后跑七段（断言大多从 `page.data().msgs` 读对话区，四处读元素盒子）：
params（「亮一点」——发送那一刻就出两条留痕，**再等 6.5 秒那条回复仍在**，浮条时代
这里必然已淡出；点「我说的」气泡把原文回填输入框）/ generate（「把路人去掉」+ 撤销，
且撤销把那次的两条对话一起收走；**「停止」「撤销」两颗都量过盒子 ≥39px**）/ both
（「亮一点再去掉路人」）/ degraded（「随便修一下」）/ 拿不准（「把那个人去掉」——
多行回复落地后**尾巴在折叠线之上**，修复轮 F1 的看家断言）/ 停止 + 秒表（mock 延时改
20 秒，点**生成那颗气泡里**的「停止」后靠 mock 的 `/mock/stats` 里 `editAborted`
计数证明确实掐断了连接）/ 系统小字 + 换照片清空（点一格风格出「套用了「…」」，
连点同档 0 条；点「换一张」`msgs` 清空）。
48 条断言，截图存 `.superpowers/mini/say-*.png`。
mock 的决策表在 `mock-server.cjs` 的 `decide()` 里，按关键词走；改它只影响冒烟。

## 「作品 / 我的」冒烟（Task 17 + Task 18）

```bash
node mini/scripts/smoke-works.cjs
```

同样 CLI 起好、automator 连着跑，但**零网络请求、不起 mock 后端**（这条也一分钱不花）。
保存那一点走页面上的 `__probeSaveWork()`（**真跑一遍全尺寸导出 + 收进本地作品集，
不碰相册**）。⚠️ 它开场会**清空模拟器本地作品**（删 works 目录 + 清单，别赌上一趟
留下的东西）—— 只动模拟器的，真机数据不受影响。跑十二段（[0]~[11]）：
清场（起点干净）/ 空态（items 0、文案、没格子、有「去修一张」）/ 载入测试照片 +
探针 / **落盘事实**（清单 +1、字段齐、宽高 = 照片实测、两个文件都在且缩略图长边
≤256 真缩过、目录里恰好两个文件）/ 作品页（1 格、格子 173px 正方形、点格 →
`previewImage` 收到全部全尺寸路径 + current —— mock 记的账；再塞第 2 条夹具量两列：
两格 top 相等 ±1px、left 不同，量完清夹具）/ **「我的」页**（1 张时
数值行含「1 张」与「MB」、页面 data 对清单现算对得上；点「清空」→ mock `showModal`
自动确认 → 清单 / 目录 / 数字全归零、0 张的置灰数据标记 `canClear=false`）/ 重存一张
→ **长按删**（上段清空后重存当靶子；mock `showModal` 自动确认——⚠️「既回调又返回
结果对象」那条铁律——清单 0、两个文件都没了、空态回来）/ **cap 拒绝**（往清单灌一条
「快满」夹具，别真存 150MB：`add` 拒绝、文案就是那条专属 toast 的原话、目录没被写半张）/
**清单写失败**（mock `setStorageSync` 抛一次：`add` 拒绝 + 人话文案、刚 copy 的孤儿
文件被清掉、清单没留半条）。
**41 条断言**，截图存 `.superpowers/mini/works-*.png` 和 `me-*.png`（空态 / 1 张 /
删后 / 我的页 1 张 / 我的页 0 张）。

## API 地址怎么改

「说一句」走电脑版后端。地址在 `lib/config.ts` 的 `API_BASE` ——
电脑的**局域网 IP + vite 端口 5173**（现在是 `http://192.168.20.245:5173`）。
换网络（家里 / 公司）就改这一个常量；上云时也改它。

⚠️ **config.ts 里现在写的是 `http://192.168.20.245:5173`（2026-10-13 当前 WLAN 的
值）** —— 换网络 / 换机器后先 `ipconfig` 重看，把这一个常量改过来（见文末
「验收记录」开工前第 3 条）。

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

## 已知平台行为（2026-10-12 模拟器实测 + 2026-10-13 真机补一条；标「待真机」的没验过）

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
- **真机上可点控件不许叠在 webgl canvas 上**（2026-10-13 真机验收抓到的 bug；
  **模拟器不复现**，两条冒烟当时全绿也照样漏）：叠在画布**之上**的 view **真机上
  收不到点击** —— 触摸被画布吃掉（业界同款报告：wxopen.club「真机点击在canvas
  之上的view,canvas会接收到事件」）。症状很好认：**按钮看得见、按下去状态一动
  不动**（当时受害的是「停止」＝生成蒙层上、「撤销」＝照片右下角；画布外的一切
  正常）。修法 = **可点控件一律放画布外**：现在「撤销」在输入条那行
  （`.say-act-undo`）、「停止」跟着生成那颗气泡走（对话区 `.msg-stop`）。
  ★ **2026-10-13（Task 14）起画布上没有任何蒙层/浮层**：`.gen-mask` / `.stage-wrap`
  整个删了，生成的过程（转圈 / 秒表 / 停止）搬进了对话区 —— 对话区是**正常排版流
  里**的一条（风格栏下面），**以后别把它做成浮在照片上的层**，也别再往画布上放
  可点控件。真机那侧的兜底一条：`onPhotoTouchStart` 生成中直接 return
  （「按住看原图」生成中无效）—— 那条防的是手势，不是点击。

## 验收记录（Task 13b · 真机）

**这是真机验收的清单** —— 每跑完一条把「结果」填上（`✅` / `❌` + 一句话）；失败的话
把现场（机型 / 微信版本 / 截图 / 控制台那句原话）记在表下面。冒烟盖不到的东西全在这；
模拟器已绿的是风格逐档（`smoke.cjs` 43/43）、说一句七段（`smoke-say.cjs` 48/48，
2026-10-13 对话留痕重写 + 修复轮加固）和作品 + 我的全流程（`smoke-works.cjs` 41/41）——
真机要的是"这些在手机上同样成立"。

**开工前四件事**（缺一件真机就连不上 / 进不去）：

1. **换正式 AppID**：`project.config.json` 里借的测试号 `wx3222d31da4ec7edb` 换成
   用户自己的正式号（工具里重新导入；工具缓存里的项目记录也要跟着走，见上面「已知的坑」）。
2. **后端配微信登录**：`.env` 里 `WX_APPID` / `WX_SECRET`（和上面是同一对号）——
   配不齐 `/api/wx-login` 直接回 503，「说一句」的全流程起不来。⚠️ 后端出站还要能到
   `api.weixin.qq.com`（本机网络策略此前挡过 `servicewechat.com` 等域名，这条当场验）。
3. **`mini/lib/config.ts` 的 `API_BASE` 换成电脑当前局域网 IP + 5173**。
   ⚠️ 现在写的是 `http://192.168.20.245:5173`（2026-10-13 的 WLAN 值）—— 换网络后
   先用 `ipconfig` 重看（别选到 `192.168.x.1` 的虚拟网卡），把这一个常量改过来。
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
| 6 | 说一句出图 | 「把路人去掉」→ 出图 + 回复留在对话区（**不自动消失**）+ 「撤销」亮 | |
| 7 | 等待秒数 | 秒表在生成那颗气泡里：开头「正在修…」不带数字，5 秒后「已经等了 N 秒」且 N 在走 | |
| 8 | 停止 | 生成中点**气泡里**的「停止」→ 转圈收、那行落「停了。」、画面和撤销都没动 | |
| 9 | 撤销 | 回到发前（画面 + 参数），按钮收掉 + **那次生成的两条对话一起收走** | |
| 10 | 存相册清晰度 | 「保存」进相册的是**全尺寸**（相册里放大看细节是清楚的） | |
| 11 | 30 秒线实测 | 真 API 全流程（路由 + 生成）出图秒数记下来 | |
| 12 | 授权往返 | 首存弹系统框；拒一次再存 → 弹人话框 → 「去设置」允许 → 自动重存 | |
| 13 | 胶囊让位 | 顶栏不被右上角胶囊压住；窄屏图标让位正常 | |
| 14 | API_BASE 改成实际 IP | 开工前第 3 条改完，真机能连上（连不上先查这条） | |
| 15 | 微信登录真 code | 不弹登录页、能出图；若蹦「微信登录没成功，再试一次」那类错 = 这条没通 | |
| 16 | 系统框 | 相机 / 相册 / 存相册三类系统框：文案与首拒后的行为对得上 | |
| 17 | 对话留痕 | 说两句 → 两条问答都在屏上、6 秒后不消失；点风格有系统小字；上滑能看更早的；**上滑时目验对话区右侧有没有一条不该有的竖线**（模拟器那条已钉死=滚动条，Task 15 用 `enhanced` + `show-scrollbar` 收掉 —— 真机只看「还在不在」，在就记一笔）；**回复落地那一刻看一眼有没有闪一下**（补滚是"先清再指"两步做的，一闪就是有问题，记一笔） | |
| 18 | 三 tab 切换 | 修图/作品/我的来回切正常、选中变色；**切走再回修图页，编辑现场（照片/对话）还在**（tab 页不销毁） | |
| 19 | tabBar 让位 | 修图页照片仍完整、不被底部 tabBar 压住（tabBar 占掉屏底一条后窗口矮了 82px；★ Task 16 把原来给 home indicator 的底部安全区 padding 让给了 tabBar —— 输入条就贴在它上方 20rpx，看这个间距自不自然）；tabBar 不与 home indicator 打架 | |
| 20 | 作品真能看到 | 「保存」一张（相册 toast 照旧）→ 切「作品」tab：缩略图就在、新的在最前；再存一张看到两张（切 tab 回来要有） | |
| 21 | 点开大图 | 点格出原生大图、能左右滑；右上角「⋯」能保存 / 转发（微信白拿的） | |
| 22 | 长按删 | 长按格 → 「删除这张作品吗？」→ 确认后格子和本地文件都没了；点取消不动任何东西 | |
| 23 | 存满时的提示 | 到 150MB 上限时补一句「作品放满了，去「我的」清一清」（相册那份照存成功）。⚠️ 真机不好真存满 —— 模拟器夹具已盖（`smoke-works.cjs` 的 cap 段），真机抽验即可 | |
| 24 | 「我的」页数字 | 存 1~2 张后切「我的」：数字卡 = 作品墙的 N 张 · X MB（对得上）；点「清空本地作品」→ 二次确认 → 作品墙真空了（回作品 tab 看）、数字回「0 张」、toast「清好了」 | |
| 25 | 置灰态 | 0 张时「清空本地作品」是灰的（灰描边 + 灰字）且点了没反应；有作品后自动恢复可点 | |

**失败现场**（机型 / 微信版本 / 截图路径 / 控制台原话）—— 13b 跑的时候往下写。

## 设计打磨轮（Task 15）· 这轮改了什么 + 真机看这几样

2026-10-13。七件：照片舞台感（圆角 + 相纸边 + 上下呼吸 / F1）/ MiSans 子集 + 字标（F2）/
对话节奏与字号对齐电脑版尺子（F3 F4）/ 对话区滚动条收口（F5）/ 空态两处间距（F6）。
模拟器已验完（两个冒烟 43/43 + 48/48、照片上下间隙实测 24.4rpx、截图像素级前后对比）；
逐条数值与证据在 `.superpowers/sdd/2026-10-12-miniprogram-outdoor-quick-edit/task-15-report.md`。

**字体是内嵌的（`mini/styles/fonts.wxss`，自动生成物、勿手改）** —— MiSans 静态子集
400/600 + Playfair 的「PinkRose」字标，全部 base64 进包（wxss 的 @font-face 不吃本地
文件 url，只认 base64 / https）。重建命令：

```bash
C:\Users\Administrator\anaconda3\python.exe mini/scripts/build-font-subset.py
```

⚠️ 必须用**带 brotli 的 python**（anaconda 那份；`D:\python314` 那份 fontTools 读写
woff2 会 ImportError）。字符集 = mini/ 全部 ts+wxml 剥注释后取唯一字符（快照
`mini/scripts/font-subset-chars.txt`）——**改了固定文案（按钮 / 顶栏 / 风格名 / 系统
小字…）就要重跑**，否则新字掉系统字体。woff2 原件**不进 mini/**（只落系统 temp）。
唯一已知缺口：「？」（U+FF1F）与「删」（U+5220）不在 MiSans 任何切片里（电脑版 MiSans
同样缺这两个）。「？」在界面上有两三处，掉系统字体；「删」只出现在原生 modal 的文案里
（清空确认 / 删除确认 —— modal 本来就渲染系统字体），**无可见影响**。

**滚动条那条值得单独记一笔**（F5）：`show-scrollbar` **单独写不生效** —— 官方文档原文
「滚动条显隐控制 **(同时开启 enhanced 属性后生效)**」（开发者工具自带的属性元数据同句）。
2026-10-13 实测：只加 show-scrollbar 时像素扫描前后**完全一致**（竖线还在），补上
`enhanced="{{true}}"` 后同一位置竖线消失。所以对话区那条 scroll-view 开了 enhanced；
滚到底的两步 `scroll-into-view` 照常（冒烟 E4「尾巴在折叠线之上」盯着）。

**真机看这几样**（前两条是模拟器看不准的）：

1. 照片的**圆角**裁不裁得动（webgl2 画布上的 `border-radius`）—— 不裁就撤 radius、
   只留相纸边 + 影子；
2. 同一张照片的 **`box-shadow`**（相纸影）真机生不生效 —— 和 1 一起构成「相纸边 +
   影子」；模拟器上 computed 已是 `0 0 0 1px + 0 4px 14px`；
3. 字体形状：按钮 / 风格名 / 顶栏动作是 MiSans、顶栏和空态的「PinkRose」是衬线
   （Playfair）—— base64 woff2 在老 iOS 微信上若不生效，备胎是 TTF 子集
   （构建脚本把 `--flavor=woff2` 换掉重出）；
4. 对话上滑时右侧**不再有竖线**（靠上面那条 enhanced 组合）—— 若某机型还露，
   记机型 + 微信版本；
5. 对话变长、照片缩到 ~278px 的手感（满对话时照片仍是屏上最大单块）—— 真机嫌挤的
   后手是 `max-height` 从 400rpx 收到 320rpx，不是改结构；
6. 「？」掉系统字体那两三处（如「…再试一次？」）真机不显眼就行。
