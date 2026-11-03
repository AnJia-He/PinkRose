# PinkRose · 对话修图

用聊天的方式修照片的 Web / PWA / 桌面应用（原名 RuiXing）。

**桌面版**：从 [GitHub Releases](https://github.com/AnJia-He/PinkRose/releases) 下载对应系统的安装包，安装后直接打开 `PinkRose`。Windows 提供安装版和免安装版，macOS 提供 Intel / Apple 芯片安装包，Linux 提供 AppImage / deb。桌面版不需要登录，作品、会话、偏好和模型配置只放进你选择的本机数据文件夹；每份安装和数据目录彼此独立，软件不会替维护者收集或汇总这些资料。首次启动会询问专用数据文件夹；以后可在「个人设置 → 文件保存位置」查看、打开或更换。构建、数据目录、安全边界和发布步骤见 [桌面版说明](docs/desktop-release.md)。

桌面版不内置共享模型密钥。AI 对话和生成式改图需要在「个人设置 → 模型配置」接入你自己的模型服务；本地调色、裁剪、超清放大和导出不需要模型。具体的数据去向写在「个人设置 → AI 与数据说明」。

**想启动它**：双击 `启动.cmd`，浏览器打开 http://localhost:5173

**长期记忆**：当前会话会记住最近修改、审美方向和未解决事项；历史较长时，服务端在内部自动整理上下文，用户的对话里不会出现摘要或“正在压缩”之类的提示。跨会话只记录你明确要求以后长期遵守的稳定偏好，可在「个人设置 → 长期偏好」查看、关闭或清除。设计与实现边界见 [长期记忆设计](docs/superpowers/specs/2026-11-02-agent-memory-design.md)。

**创作搭子**：PinkRose 会先看照片里的主体、光线、构图、色彩、质感和真实性边界，再决定怎么改。直接指令会优先用免费、可逆的本地调整；需要去物、换天或换背景时才调用图片生成，而且每轮只生成一版。用户没想好时，会给两条方向清楚、能直接执行的修图思路；用户只是想聊聊照片时，也会根据画面里真实成立的地方接话，不套固定安慰句。内部能力清单、价格与隐私边界、验收集见 [审美创作 Agent 设计](docs/superpowers/specs/2026-11-02-aesthetic-agent-design.md)。

**联网搜索 MCP**：遇到照片之外、可能变化或无法确认的事实时，会通过与官方 MCP TypeScript SDK 连接的内置 `pinkrose_web_search` 工具搜索公开资料；照片、账号和长期偏好不会发给搜索源。搜到结果时附来源链接；搜不到时仍以摄影搭子的正常身份，根据当前照片、会话和已有修改继续处理，不解释搜索失败或内部步骤，也不要求用户自行核实或补充资料。设计见 [内置搜索 MCP](docs/superpowers/specs/2026-11-02-search-mcp-design.md)。

**Apple / Safari**：首次先装 WebKit（`npx playwright install webkit`），起开发服务器后跑 `npm run check:safari`；它会用 iPhone 390px 的 WebKit 走一遍上传、调色、直方图、文字，以及真实正脸的人像磨皮 / 去斑控件。磨皮本身另有一条像素级验收 `npm run check:smooth`：在 WebKit 里把全局磨皮推到 100，比对脸颊纹理是否下降、虹膜 / 睫毛边缘是否保住，再走一遍「磨皮」画笔的涂抹和提交。色彩分级与色调跑 `npm run check:grading`：确认冷暖和绿—洋红两条白平衡轴、三段分级和归零复原。自动透视跑 `npm run check:perspective`：用合成透视建筑图确认识别、四角预览、应用换图和 390px 布局，再用真实正脸照确认不会误判。移轴虚化跑 `npm run check:tilt-shift`：在 WebKit 里切到移轴，确认带外纹理下降、清晰带中心保持、角度真的旋转，并检查 390px 布局。裁切警告跑 `npm run check:clipping`：确认高光变红、暗部变蓝、关闭恢复，且提示层不会污染导出字节。相连区域选择跑 `npm run check:connected-select`：确认点左侧红块只改左侧，右侧同色但不相连的块保持不变。作品页连拍组跑 `npm run check:bursts`：真实创建 5 张相邻作品，确认作品接口保存原文件名与拍摄时间、连拍收起和展开、整组多选，以及 390px 不溢出。合影与手动圈脸跑 `npm run check:portrait`：合成双人测试图，确认识别出两张脸、「全部」同时标出两张脸框、直接点照片里的脸框可选中「脸 2」、预览与成片跟随；再用无肤色噪声图验证自动失败后手动拖脸框仍能完成磨皮，并检查 390px 布局。HEIC 导出跑 `npm run check:heic`：先问服务端真实编码器能力，再确认网页只展示可用的 HEIC 选项。HEIC / RAW / TIFF 上传兜底跑 `npm run check:import`：在 Chromium 里验证原生解码失败后确实请求本机转换器，Mac 上还会生成真实 HEIC 并确认能进入编辑器；RAW 预览兜底另跑 `npm run check:raw-preview`，在 WebKit 390px 里确认真实 DNG 容器能提取内嵌 JPEG 并说明不是完整解档。实况照片配对跑 `npm run check:live-photo`：在 390px WebKit 里选择同名 JPG + MOV，确认出现“修照片 / 调动作”选择并继续进入编辑器。镜头配置另跑 `npm run check:lens`：上传一张带 Sony EXIF 的 JPEG，确认镜头被认出、三根校正滑杆写入配置值、画面真的变化，并检查 390px 布局。LUT 导出另跑 `npm run check:lut-export`：在 WebKit 里生成、下载并解析 `.cube`，确认恒等、色温和色调三种结果都对。ICC 色彩配置跑 `npm run check:color`：生成 JPG / PNG / WebP，并用 Pillow / LittleCMS 独立解析内嵌 profile；源照片色域另跑 `npm run check:source-profile`，确认 WebKit 能识别 Display P3 并明确提示转成 sRGB。iPad 竖屏 / 横屏再跑 `npm run check:tablet`，会在 768 / 834 / 1024 / 1194 宽度下确认照片、预设条、调色面板和磨皮工具都不被挤没。

**加到主屏幕**：iPhone / iPad / Mac 的 Safari 可用「分享 → 加到主屏幕」；产品提供 standalone 启动配置、稳定主屏图标和 `PinkRose` 主屏名称，不依赖浏览器标签栏。页面使用 `viewport-fit=cover` 并避开刘海、灵动岛、侧边安全区和底部 Home Indicator。

**离线应用壳**：生产构建会注册 Service Worker，缓存页面和静态资源，断网重开时至少能加载应用界面；`/api/` 账号、照片和会话请求不进缓存。已经打开的页面里，本地调色 / 人像 / 裁剪等计算本身不依赖网络。生产构建把 React / Base UI、图标和 EXIF 依赖拆成稳定缓存块，实时相机和相机桥也只在用户打开时加载；构建后跑 `npm run check:bundle`，当前主包预算不超过 1 MB。

**触控**：照片区支持 iPhone / iPad 双指缩放、双指同向拖动；单指拖动看细节、双击 100% 定位，工具开着时手势自动停用。触控手势与桌面滚轮 / 缩放按钮共用同一套边界和锚点算法。照片右上角的「专注看图」会把当前照片区临时铺满屏幕，不依赖系统 Fullscreen API，现有缩放、对比和原图预览继续可用，再点一次或按 Esc 退出。Apple Pencil 在涂鸦、点修、磨皮、局部调整和克隆等画笔工具中按压力度控制笔刷粗细，鼠标与手指保持原尺寸。

**手机调色**：iPhone Safari 内容区高度不超过 760px 时，进入「调色」会先收起参数面板，把空间还给照片；点面板标题右侧的箭头可展开参数，调完再收起查看大图。高视口手机和桌面仍默认展开，桌面不显示这颗移动端按钮。

> 上传支持 JPG / PNG / WebP / HEIC / HEIF / TIFF，以及 DNG / CR2 / CR3 / NEF / ARW / RAF / ORF / RW2 等常见 RAW 后缀；`createImageBitmap` 解不开时会先走 `<img>` 解码兜底，仍然打不开的 HEIC / RAW / TIFF 再交给本机转换器。服务端会按格式自动选择 macOS `sips`、ImageMagick、RawTherapee CLI、darktable CLI 或 LibRaw `dcraw_emu`；LibRaw 输出的 TIFF 会再交给本机 JPEG 编码器，前一个转换器失败时会继续尝试下一个，并校验结果确实是 JPEG。RAW 的本机转换器不可用时，还会扫描容器里相机写入的最大 JPEG 预览（要求长边至少 640px）并进入修图；界面明确说明这是内嵌预览，不是完整 RAW 解档，原始位深和完整高光 / 阴影仍需厂商软件或 RAW 解码器。TIFF / DNG / 常见 TIFF-based RAW 里的机型、镜头、焦距、曝光、光圈、日期和 ISO 会通过轻量 IFD 解析读出，参与照片信息和批量自动镜头校正。源文件带 ICC / HEIF `nclx` 时会识别 sRGB、Display P3、Adobe RGB、ProPhoto RGB、BT.2020；广色域照片会明确提示当前编辑和导出先转 sRGB，照片信息里也能看到源配置。服务端和预览都没有时会明确提示 Mac / iPhone 用 Safari、相机厂商软件导出 JPG / TIFF，或先转 JPG / PNG，不再只回一句「这张图打不开」。
> 主上传、批量、相机桥、焦点堆栈和照片电影共用同一份 **26 种 RAW 后缀**清单，新增覆盖 NRW / PEF / SRW / X3F / 3FR / IIQ / GPR 等 Pentax、Samsung、Sigma、Hasselblad、Phase One 和 GoPro 相机格式；RAW 在选片列表里会先生成解码预览，最终处理仍用原文件。
> 普通文件夹导入也会识别同目录同名的 RAW + JPG / HEIC：这一对只保留 RAW 原始数据，避免同一张照片处理两次；界面会说明合并了几组。不同目录、多个 RAW 或多个预览无法确定对应关系时不猜。
> HEIC / RAW / TIFF 的本机转换兜底现在直接上传二进制文件，不再先做 base64（体积会多约 33%）；单张上限提升到 **128MB**，覆盖常见 iPhone 48MP ProRAW DNG，旧 JSON 调用仍保留兼容。
> 选择 RAW 时会先查询本机转换能力；没有 RawTherapee / darktable / LibRaw 时不再白传整份原文件，而是直接尝试相机内嵌 JPEG 预览，并继续明确标注“不是完整 RAW 解档”。
> Apple 实况照片导出成文件后通常是一张同名照片加一个 MOV。网页会按同名文件认出一对，并继续读取 MOV 的 `com.apple.quicktime.content.identifier` 和静帧里的 Apple 实况标识：文本 UUID 或 MakerNote 的 16 字节原值一致时标成「已核对」，同名但标识不同会明确警告，普通同名文件只标「仅同名」；一次选择多组时也会逐组列出，可以只打开其中一组的静帧或动作，也可以把全部静帧送进批量处理。进入静帧编辑器后，导出设置会显示「照片 + 动作兼容包」：只对 ID 已核对的一对开放，把当前 JPG 成片和原始 MOV 按同一文件名词干装进 ZIP，原动作不转码；设备支持文件分享时还可以把 ZIP 直接交给 iPhone / iPad 的系统分享面板。它仍不是 Apple 原生 Live Photo 容器，界面会明确说明解压后可能显示为两个文件，不拿 `.pvt` 或原生格式冒充完成。
> 上传前那一屏除了「选照片」，还有后置「拍照」和前置「自拍」两个图标入口；iPhone / Android 上分别调起对应摄像头，桌面浏览器自然退化为文件选择。桌面端也可以直接把截图或图片粘贴进来开始修；编辑中拖入单张仍替换当前照片，一次拖入多张则把全部照片送进批量处理，其他类型的文件会被跳过。
> 欢迎页的「导入文件夹」可一次选一整个目录，只把图片送进批量处理，文件夹里的 `.xmp` / `.txt` 等旁车文件会被跳过；不支持目录选择的浏览器会退化为多选照片。
> 「实时相机」用浏览器 `getUserMedia` 打开实时取景：可选内置 / USB / UVC / 采集卡等浏览器能看见的相机，带网格、镜像、前 / 后切换、即时 / 3 / 5 / 10 秒倒计时（等待中可随时取消）、快门、3 / 5 张连拍（拍完选一张，或整组送入批量处理）、原始 / 1:1 / 4:5 / 3:4 / 16:9 / 9:16 六种拍摄画幅（取景框、全分辨率静态照和预览帧共用同一套居中等比裁切，并记住上次选择；浏览器支持 `canvas.captureStream` 时录像也按同一画幅和镜像输出，不支持时明确提示本次录像保留相机原始构图）、**最长 20 秒的录像**（默认同时录麦克风，可一键关掉声音；录完可直接「用短片调色打开」，也可以下载）、相机支持时的点按兴趣点对焦、变焦（滑杆或双指捏合）、曝光补偿、手动对焦与补光；点按对焦不受支持时会提示继续用下方对焦滑杆。会记住上次选择的相机，并在设备插拔时刷新列表，拍下的一帧直接进入现有修图链路。录像优先用 WebM（Chromium 的 MP4 录制实际会写出 VP9，播不了），Safari 自动退回 MP4；MediaRecorder 的 WebM 没有时长头，读取时会自动算出来。**必须在 HTTPS 或 localhost 下使用**；手机用局域网 IP 打开时浏览器会禁用相机，可先用系统「拍照」入口或配置 HTTPS。真正的单反遥控 / 厂商 SDK 需要原生桥，不在纯 Web 范围。
> 「相机桥」先解决单反 / 微单拍完就进修图：在本机运行 `npm run camera:bridge -- --dir <相机保存目录>`，把 EOS Utility / Imaging Edge / Camera Control Pro / Capture One 等 tether 软件的保存目录指过去，网页里点「相机桥」即可看到新照片并导入；扫描支持「年份 / 月份 / 日期」等最多三层子目录，单次最多检查 256 个目录 / 5000 个条目，列表会显示相对文件夹以区分不同日期的同名 `IMG_0001`。连接后可以打开「自动导入新照片」，之后相机每落一张新图，网页会自动导入最新一张（默认关闭，避免换掉当前照片）。照片目录接口只读，本机默认只监听 `127.0.0.1`，支持 JPG / PNG / WebP / HEIC / HEIF / TIFF 和常见 RAW 后缀。**同名的 RAW + JPEG 会合并成一条**：默认导入 JPG 预览，旁边可单独取 RAW 原片，不再把一张照片列成两条、重复导入。用 iPad / iPhone 在同一 Wi-Fi 下连电脑上的桥时，运行 `npm run camera:bridge -- --host 0.0.0.0`；程序会自动生成访问令牌，网页「相机桥」里填入终端显示的局域网地址和令牌即可，所有照片和相机控制请求都要带这个令牌。电脑上填好令牌后可点「复制配对链接」：它把地址和令牌放进 URL hash，在 iPad / iPhone 打开后点一次「相机桥」就会自动填好并连接，读完立即从地址栏清掉；链接含访问令牌，只发给自己的设备。本机有 `sips`、`magick`、`rawtherapee-cli`、`darktable-cli` 或 `dcraw_emu` 时，桥会按文件格式选择能处理 RAW / HEIC / TIFF 的转换器，失败时继续尝试下一个并缓存有效 JPEG；需要原始文件时点「原图」。没有转换器时仍可导入原文件，能否直接解码取决于浏览器。USB 直连相机时运行 `npm run camera:bridge -- --gphoto2`：通过本机 gphoto2 控制 Canon / Nikon / Sony / Fujifilm 等支持 PTP 的机型，提供实时取景、快门、ISO、快门速度、光圈、白平衡、驱动模式、测光、曝光补偿、对焦模式、图像质量和拍摄模式；实时取景可开三分构图网格、红色对焦峰值、高光斑马纹、伪色曝光和 RGB 直方图，另有一个 **100% 对焦放大镜**：主画面保持原构图，点照片即可把放大镜观察点移到脸、眼睛或产品边缘，放大镜按实时取景原生像素 1:1 显示，不靠平滑拉大冒充细节；也可以进入全屏取景、按 Esc 退出，所有辅助都在浏览器里本地叠加，不改相机原片；电池和镜头作为只读状态显示；打开「自动导入新照片」后，网页里按快门成功也会立即把新照片就近导入修图。先用 `--list-config` 探测相机实际支持的配置，选项和范围也从相机读取，不再写死；macOS 可 `brew install gphoto2`，Windows 需先安装 libgphoto2 的 gphoto2 可执行文件。相机支持 PTP/IP 时，让它进入 PC Remote / PTP 模式并与电脑同一 Wi-Fi；既可以启动时运行 `npm run camera:bridge -- --gphoto2-ip 192.168.1.50`，也可以在网页「相机桥」里直接填相机 IP 和可选端口，让正在运行的桥切换到无线 gphoto2。网页配置也会经过同一套控制标记和参数校验，并把相机 IP / 端口写进相机目录的隐藏配置文件；桥重启后会自动恢复上次无线目标，桥或浏览器也会记住最近一次输入。默认端口 15740，特殊机型可在网页或 `--gphoto2-port ptpip:IP:端口` 里覆盖。不是所有机型都开放 PTP/IP，连不上时先查相机菜单和电脑防火墙。桥接器仍保留标准 `CameraControlProvider` 接口，厂商私有 SDK 可继续作为后续适配器接入；开发时可用 `--mock-live <一张 JPG>` 演示整条链路，并运行 `npm run check:camera-live` 检查实时取景辅助在 WebKit / 390px 下可用。
> 相机或 tether 软件在同目录写出同名 `.xmp` 时，相机桥会把它作为照片的附属配方一起列出和取回；单张、自动导入和多张「导入全部」都会把旁车带进编辑器或批量处理，不会把 XMP 误列成另一张照片。
> 相机桥连上后会在面板里直接说明当前能力，例如「完整 RAW：RawTherapee · HEIC / TIFF：sips」；没有转换器时会明确写“RAW 仅使用相机内嵌预览”，并提示安装 RawTherapee、darktable 或 LibRaw，用户不用去猜终端日志。
> 无线相机配置可以按机身或机位命名保存，最多 8 组，点一下就能在 PTP/IP、Canon CCAPI 和 Sony Camera Remote 之间切换。配置只存在当前浏览器，只包含连接方式、地址和端口，不复制访问令牌；删除配置不会断开当前相机。可以把配置导出成 JSON 带到 Mac / iPhone / iPad，再导入另一台浏览器；文件不含访问令牌，导入后也不会自动连接，令牌仍需单独填写。
> 「检查相机」会做一次只读体检：逐项报告相机桥、机身连接、实时取景、拍摄与参数控制、照片列表 / 存储卡导入，以及本机 RAW / HEIC 转换器。它不会按快门，也不会改相机参数；失败项直接说明下一步查什么。
> 相机状态与照片列表每 2 秒一起刷新：USB / Wi-Fi 掉线会立即改成“未检测到相机”并显示诊断，恢复连接后不用重新打开面板也会回到可用状态。
> 相机桥的快门可用时还能做**间隔拍摄**：选择 2–20 张、1–60 秒间隔，运行中显示「已拍 X/Y」并可随时停止；结束后若开了「自动导入新照片」，整组会一次性送进批量处理，不会每拍一张就替换当前编辑器。它复用现有单张快门，不要求相机自带间隔计时器。
> **Canon CCAPI**：对开启无线 Camera Control API 的 Canon 机型，相机桥正常启动后即可在网页「相机桥 → 无线相机 → 连接方式」选择 **Canon CCAPI**，填写相机地址和可选端口；配置会热切换到 CCAPI，并在桥重启后自动恢复。也可以直接运行 `npm run camera:bridge -- --canon-ccapi 192.168.1.50`（默认 8080 端口，也可写完整 `http://相机IP:端口`）。网页会显示实时取景、快门和相机实际返回的 ISO / 快门 / 光圈 / 曝光补偿 / 白平衡等参数；拍完会在相机目录出现新文件后自动取回桥目录。不按快门时也可以点「从相机导入」，把当前目录最近的 20 张照片取回；已下载过的同名文件不会重复复制。首次使用前需在相机「无线通信设置 → Wi-Fi 设置」启用 Camera Control API，并让电脑与相机处于同一网络。真实机型的菜单名称、固件和取回速度仍需实机验收；网页配置可跑 `npm run check:remote-camera-ui` 检查 390px / 桌面 WebKit 布局和控制台。
> **Sony Camera Remote**：支持公开 Camera Remote API 的 Sony 机型，在网页连接方式里选 **Sony Camera Remote**，填相机地址即可（默认 10000 端口）；也可运行 `npm run camera:bridge -- --sony-camera 192.168.1.70`。适配器会进入遥控模式、读取实时取景和当前允许修改的 ISO / 快门 / 光圈 / 曝光补偿 / 对焦模式，按快门后直接下载相机返回的 JPEG。支持存储卡导入的机型也可以点「从相机导入」：桥会切到 `Contents Transfer`，按日期倒序取最近照片、跳过已下载文件，完成后切回 `Remote Shooting`。先在相机打开 Wi-Fi「遥控拍摄」/ Smart Remote Control，并让电脑加入相机的 Wi-Fi；较新的机型可能只提供厂商私有 SDK，仍需实机确认。命令行探针用 `npm run camera:probe -- --sony-camera 192.168.1.70`。
> 相机提供可写的曝光补偿时还能做**包围曝光**：选择 3 / 5 张和 0.3 / 0.7 / 1 EV 步长，自动按负数到正数逐张改曝光并抓拍，结束后恢复原曝光。拍完点「用这组做 HDR」会把整组照片按拍摄顺序直接带进 HDR 工作区，也可以继续送批量处理。若相机范围不够生成不重复的曝光序列，会在开拍前明确拒绝；真实机型仍需硬件验收。
> 相机适配器暴露可写焦点位置时还能做**焦点包围**：选择 3 / 5 张和窄 / 中 / 宽范围，自动从当前焦点向两侧逐张移动、抓拍并恢复原焦点。拍完点「用这组做焦点堆栈」会把整组照片预填到焦点堆栈工作区，适合微距和产品拍摄。没有可写焦点字段的机型不显示这项，不会拿曝光包围冒充；真实机型的焦点单位、方向和步长仍需硬件验收。
> **相机探针**：`npm run camera:probe -- --gphoto2-ip 192.168.1.50` 不开网页，直接检查 PTP/IP 是否连上，并验证状态、实时取景帧和参数读取；Canon 无线机型用 `npm run camera:probe -- --canon-ccapi 192.168.1.50`，Sony 用 `npm run camera:probe -- --sony-camera 192.168.1.70`；适配器开发时用 `npm run camera:probe -- --provider ./my-adapter.mjs`。探针不按快门；只有显式加 `--probe-write` 才会把当前参数原值写回一次，用来验证 setSettings()。没有硬件时可用 `npm run camera:probe -- --mock-live <一张 JPG>` 做完整演练。
> 相机桥的「自动导入新照片」偏好会记在这台浏览器；一次刷新到多张新照片时整组进入批量处理（最多 20 张），照片列表里也有「导入全部」；单张仍是直接进编辑器。
> 「厂商 SDK」：运行 `npm run camera:bridge -- --provider ./my-adapter.mjs`。适配器导出 `createCameraProvider({ root })`，返回带 `status()` / `liveView()` / `capture()` / `getSettings()` / `setSettings()` 的对象即可；网页会自动出现实时取景、快门和参数控件。第三方适配器的状态、能力、参数描述、JPEG / PNG 实时帧、快门文件名和返回参数都会经过统一契约层校验，并有调用超时保护，畸形或卡死的 SDK 不会把整个桥拖挂。接口和示例见 [相机适配器设计](docs/superpowers/specs/2026-10-19-camera-provider-plugin-design.md)。可控相机还可以把当前 ISO / 光圈 / 快门 / 白平衡等存成「拍摄预设」（只存本机，最多 20 条）；下次换场直接套用，换成另一台机身时只应用它支持的项，数值会按相机 schema 的范围、步长和下拉选项校验。

---

## 想调整什么细节，去哪找

| 想改的东西 | 去哪 |
|---|---|
| 页面上的一句话 / 按钮名字 | `src/ui/` 里对应页面的文件（见下一个表） |
| 颜色、大小、圆角、间距 | [src/styles.css](src/styles.css) —— 最上面一段就是"色号表" |
| 产品介绍页（落地页）的一切 | [LandingPage.tsx](src/ui/LandingPage.tsx) + [landing.css](src/landing.css) |
| 页面上用的照片、字体、Logo | `src/assets/`（landing / welcome / logo / fonts） |
| AI 怎么理解人话（给模型的提示词） | [prompt.ts](server/prompt.ts) |
| 写文案的规矩（怎么说话、禁用什么词） | [文案规范.md](docs/文案规范.md) |
| 模型的接口地址、钥匙 | 界面上「个人设置 → 模型配置」；代码在 [models.ts](server/models.ts) |
| 微信小程序（`mini/`「户外快速修图」） | 改小程序时进来，细节看 [mini/README.md](mini/README.md) |

### `src/ui/` 里每个页面分别是哪个文件

| 页面 | 文件 |
|---|---|
| 产品介绍（落地页） | [LandingPage.tsx](src/ui/LandingPage.tsx) |
| 登录 / 注册 | [LoginPage.tsx](src/ui/LoginPage.tsx) |
| 修图主界面（骨架） | [App.tsx](src/App.tsx) |
| 对话栏（右边那一条） | [ChatPanel.tsx](src/ui/ChatPanel.tsx) |
| 照片显示区（含滚轮 / 按钮 / 双击 / iPhone·iPad 双指缩放与拖动） | [Canvas.tsx](src/ui/Canvas.tsx) + [viewport.ts](src/ui/viewport.ts) |
| 历史转盘（照片上方那一圈小图，拖 = 转、点 = 回到那一版）★ **只记对话聊出来的版本**（原图 + 每次生成）；裁剪 / 点修 / 调色**不占格**，它们进「账本」 | [StepStrip.tsx](src/ui/StepStrip.tsx) |
| 账本（**每一版自己的修改记录**：调色 / 裁剪 / 点修 / 磨皮 / 形状等各记一笔）+ 调色屏左下角那组「上一步 / 下一步」箭头；点「2 / 3」可展开逐笔历史，每一笔带名字（原图 / 裁剪 / 磨皮 / 形状…），点哪一笔直接跳回哪一笔；桌面 / iPad 键盘支持 ⌘Z / Ctrl+Z 撤销、⌘⇧Z / Ctrl+Shift+Z / Ctrl+Y 重做 | [core/ledger.ts](src/core/ledger.ts) + [StepNav.tsx](src/ui/StepNav.tsx)（接线在 `App.tsx` 的 `ledgerStep` / `ledgerJump` / `commitCrop` / `commitRetouch`；设计见 [2026-10-08-adjust-ledger-design.md](docs/superpowers/specs/2026-10-08-adjust-ledger-design.md)） |
| 上传照片（欢迎页照片球） | [WelcomeGlobe.tsx](src/ui/WelcomeGlobe.tsx) + [Uploader.tsx](src/ui/Uploader.tsx) |
| 实时相机取景（设备选择、网格、镜像、前 / 后、倒计时、六种成片画幅、快门、权限提示） | [CameraCapture.tsx](src/ui/CameraCapture.tsx)（入口在 [Uploader.tsx](src/ui/Uploader.tsx)） |
| 相机桥（本机 tether 文件夹只读桥；EOS Utility / Imaging Edge / Camera Control Pro / Capture One 落盘后网页导入；实时取景 / 100% 对焦放大镜 / 快门 / 间隔拍摄 / 包围曝光 / 焦点包围适配器） | [CameraBridge.tsx](src/ui/CameraBridge.tsx) + [CameraLiveView.tsx](src/ui/CameraLiveView.tsx) + [cameraBrackets.ts](src/core/cameraBrackets.ts) + [cameraBridge.ts](server/cameraBridge.ts) + [camera-bridge.ts](scripts/camera-bridge.ts) |
| 对话列表 | [SessionsPage.tsx](src/ui/SessionsPage.tsx) |
| 调色面板（94 个参数 / 13 组；含工具行：裁剪 / 点修 / 磨皮 / 局部（调色 / 减淡 / 加深 / 牙齿 / 亮眼 / 红眼 / 发色 / 眼影 / 眉毛 / 美瞳 / 卧蚕 / 眼线 / 祛皱 / 黑眼圈 / 模糊 / 马赛克，含液化） / 装饰（画布 + 边框 + 贴纸 + 形状 + 叠加 + 涂鸦 + 光效 + 双色调） / 文字 / 对比） | [AdjustmentPanel.tsx](src/ui/AdjustmentPanel.tsx) + [ColorWheel.tsx](src/ui/ColorWheel.tsx) ＋ 工具行 [ToolBar.tsx](src/ui/ToolBar.tsx) / [CropOverlay.tsx](src/ui/CropOverlay.tsx) / [RetouchOverlay.tsx](src/ui/RetouchOverlay.tsx) / [LiquifyOverlay.tsx](src/ui/LiquifyOverlay.tsx) / [FrameOverlay.tsx](src/ui/FrameOverlay.tsx) / [CanvasFrameOverlay.tsx](src/ui/CanvasFrameOverlay.tsx) / [StickerOverlay.tsx](src/ui/StickerOverlay.tsx) / [ShapeOverlay.tsx](src/ui/ShapeOverlay.tsx) / [DoodleOverlay.tsx](src/ui/DoodleOverlay.tsx) / [LightOverlay.tsx](src/ui/LightOverlay.tsx) / [DuotoneOverlay.tsx](src/ui/DuotoneOverlay.tsx) / [TextOverlay.tsx](src/ui/TextOverlay.tsx) / [CompareSplit.tsx](src/ui/CompareSplit.tsx)（裁剪算式在 [core/crop.ts](src/core/crop.ts)、落到像素上在 [image/crop.ts](src/image/crop.ts)；点修掩码在 [core/retouch.ts](src/core/retouch.ts)、修补笔在 [image/heal.ts](src/image/heal.ts)、落地在 [image/erase.ts](src/image/erase.ts)；磨皮的画笔引擎在 [image/smooth.ts](src/image/smooth.ts)、接线在 [app/useSmooth.ts](src/app/useSmooth.ts)；局部调整 / 减淡 / 加深 / 牙齿 / 亮眼 / 祛皱 / 黑眼圈 / 发色 / 眼影 / 眉毛 / 美瞳 / 卧蚕 / 眼线引擎在 [image/localAdjust.ts](src/image/localAdjust.ts)、接线在 [app/useLocal.ts](src/app/useLocal.ts)；液化引擎在 [image/liquify.ts](src/image/liquify.ts)、接线在 [app/useLiquify.ts](src/app/useLiquify.ts)；文字的排版 / 落地在 [image/text.ts](src/image/text.ts)、接线在 [app/useText.ts](src/app/useText.ts)；画布扩展在 [image/canvasFrame.ts](src/image/canvasFrame.ts)、接线在 [app/useCanvasFrame.ts](src/app/useCanvasFrame.ts)；边框在 [image/frame.ts](src/image/frame.ts)、接线在 [app/useFrame.ts](src/app/useFrame.ts)；贴纸在 [image/sticker.ts](src/image/sticker.ts)、接线在 [app/useSticker.ts](src/app/useSticker.ts)；形状在 [image/shape.ts](src/image/shape.ts)、接线在 [app/useShape.ts](src/app/useShape.ts)；涂鸦在 [image/doodle.ts](src/image/doodle.ts)、接线在 [app/useDoodle.ts](src/app/useDoodle.ts)；光效在 [image/light.ts](src/image/light.ts)、接线在 [app/useLight.ts](src/app/useLight.ts)；双色调在 [image/duotone.ts](src/image/duotone.ts)、接线在 [app/useDuotone.ts](src/app/useDuotone.ts)；透视、镜头虚化和镜头校正在 [render/shader.ts](src/render/shader.ts) 的采样变换 / 邻域采样里 —— 点修移植自 Compositor，出处见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)） |
| 点修 → AI 消除（涂抹选区 → 1024 方图裁切 + 红标 → 云端回图 → 只按掩码回贴；只改当前这一版，可撤销；会消耗生成额度） | [AiEraseControls.tsx](src/ui/AiEraseControls.tsx) + [aiErase.ts](src/image/aiErase.ts) + [useAiErase.ts](src/app/useAiErase.ts) |
> 「局部」支持自由涂抹、线性渐变、径向渐变、色彩范围和明暗范围五种蒙版；渐变可直接在照片上拖出方向与范围。明暗范围按画面的阴影 / 中间调 / 高光选像素，再用「范围 / 羽化」控制相邻亮度和软边，适合只压天空、只提暗部或压暗背景高光。
> 「局部 → 反选」把当前画笔选区翻过来：先选主体，再反选局部模糊，就能只虚化背景；软边和强度都保留。
> 「局部」的画笔蒙版还有「羽化」：提交前把选区边缘柔和铺开，反选后的背景虚化和局部调色不会出现硬边。
> 「局部」里的「模糊 / 马赛克」复用同一张蒙版和强度滑杆，适合遮隐私或做局部虚化。
> 「局部 → 动感模糊」先涂出要拉出速度感的区域，再调强度和角度（0° 水平、90° 垂直）：沿一个方向做多采样平均，背景车流、跑步和运动主体都能用；掩码外和全局参数不动。
> 「局部 → 一键虚化背景」自动估主体，只把背景柔和虚化，主体保持清楚；本机计算，可撤销，不花生成额度。
> 「局部」新增「自动主体 / 自动背景 / 自动天空」：本地估出主体、背景或顶部天空蒙版，一键填进当前选区，之后仍可用画笔 / 橡皮 / 羽化修边；不做云端识别，不上传照片。
> 「局部 → 存为层」把当前蒙版和参数存成**可回改局部层**：不换底图，回来点「局部层 1」还能改选区、改亮度 / 效果，点「更新层」覆盖；「删」也记一笔，可撤销。一版最多 8 层；继续裁剪 / 磨皮 / 液化等底图操作时会先合进底图并清空层，所以位置永远对得上。
> 「局部 → 色彩范围」点一下画面上的颜色，按色相 / 饱和度 / 明度选出相近像素：容差控制选多宽、羽化柔化边缘。打开「相连区域」后只从点击位置向外生长，另一侧同色但不连通的物体会保持原样；存为层时会连点击种子一起保存，回来还能继续调。
> 「局部 → 保留颜色」是一键版局部彩色：点按钮，再点照片里要保留的颜色，其余区域会去色成黑白；容差 / 羽化 / 扩边仍可继续修，适合花朵、衣服、天空等单一主色。
> 「调色 → 黑白」使用真正的黑白混色：黑白强度决定去色程度，红 / 绿 / 蓝混色决定不同颜色在灰阶里的亮度贡献；预设栏的「黑白」也使用这套参数，不再只靠饱和度 -100。
> 调色「色彩」组提供日光 / 阴天 / 阴影 / 钨丝灯 / 荧光灯五个白平衡起点；点选只改色温和色调，之后仍可继续拖滑杆微调。
> 「局部」的反选现在对五种蒙版都可用：涂抹直接翻掩码；线性 / 径向 / 色彩范围 / 明暗范围记住反选状态，调范围 / 羽化不会把反选冲掉，存成局部层后刷新也还在。
> 「局部 → 扩边」把蒙版整体向外扩（正数）或向内收（负数），范围 -50~50 像素：补掉漏涂的一圈、或把颜色选区收紧；扩完再配合羽化，边缘更自然。
> 「局部 → 不透明度」把整层效果按 0~100 混合：同一张蒙版、同一组参数，50 就是一半强度；存为局部层后也会保留，回来还能继续调。
> 「局部 → 调色」支持亮度 / 对比度 / 高光 / 阴影 / 白色色阶 / 黑色色阶 / 去雾 / 饱和度 / 自然饱和度 / 色温 / 色调 / 清晰度：压暗天空高光、提亮背光暗部、整理局部白点和黑点、拉开远处灰雾、纠正局部偏绿或偏洋红，都可以只在选区里做，不碰全局参数。
> 「局部 → 调色」再补自然饱和度 / 清晰度：自然饱和度优先抬灰一点的颜色、少动已经很艳的颜色；清晰度在选区里做亮度高通，拉开纹理和边缘，同样不碰全局参数。
> 「局部 → 减淡 / 加深」是专业修图常用的明暗塑形：减淡提亮、加深压暗，并可限定在阴影 / 中间调 / 高光；按原亮度缩放 RGB，保留色相与纹理，支持存为可回改局部层。
> 调色面板多了「图层」栏：文字 / 形状 / 贴纸和局部层统一列在一起，能显示 / 隐藏、上下移、删除，点名字直接回来改；局部层永远作用在照片上，叠图层永远盖在它上面。显隐和顺序都记进账本，刷新后还在。
> 「局部 → 发色」先涂头发，再选自然黑 / 深棕 / 亚麻 / 酒红 / 雾蓝 / 玫瑰金；按原亮度换色，发丝明暗保留，皮肤不被染。
> 「局部 → 眼影」先涂眼皮，再选大地棕 / 珊瑚橘 / 玫瑰粉 / 紫罗兰 / 雾蓝 / 香槟金；只混入五成左右，保留眼皮纹理。
> 「局部 → 美瞳」先涂虹膜，再选暖棕 / 冷灰 / 冰蓝 / 橄榄绿 / 紫罗兰 / 琥珀；按亮度门避开眼白和瞳孔，保留虹膜放射纹理。
> 「局部 → 眉毛」先涂眉毛，再选自然黑 / 深棕 / 灰棕 / 红棕；按原亮度换色并混入约七成，保留毛流深浅。
> 「局部 → 卧蚕 / 眼线」先涂眼下窄条或上眼睑线，再选珍珠 / 香槟 / 蜜桃或自然黑 / 深棕 / 炭灰；卧蚕柔和提亮，眼线沿涂抹线压暗，掩码外用不动。
> 「局部 → 修容 / 高光」先涂颧骨下方、鼻影或鼻梁、颧骨上方，再选修容冷棕 / 暖棕 / 灰棕或高光香槟 / 珍珠 / 蜜桃；修容压暗、高光提亮，都按原亮度保留纹理，掩码外和全局参数不动。
> 「局部 → 祛皱」先涂黑眼圈、法令纹或细纹，再调强度；先柔化小尺度明暗反差，再按阴影权重轻提亮，掩码外与全局参数不动。
> 「局部 → 黑眼圈」先涂眼下暗沉，或点「自动眼下」按正脸框圈出泪沟，再调强度；只把比周围肤色更暗的一层提亮并压掉蓝紫偏色，正常肤色和掩码外不动。
> 「局部 → 去反光」先涂眼镜、鼻梁、额头或窗户上的反光，再调强度；只压涂选区域的高光，暗部和纹理保留，适合逆光人像与玻璃反光。
> 套上内置预设或「我的预设」后，调色面板会多出「预设强度」：0 = 不动、100 = 原预设，中间按比例混合全部参数；拖强度时预设格仍亮着，再手调别的参数才退出这套预设。刷新或恢复会话后也会从参数反推出预设与强度，不让滑杆和选中态白白消失。
> 调色面板每个改过的参数组标题右侧都会出现分组重置：点「重置光效」只清光效，点「重置色彩」只清色彩，其它组和当前照片的其它调整原样保留。重置按钮只在对应组有改动时出现；iPhone / iPad 上触控区补到 44px，组头保持吸顶。
> 「我的预设」支持 **PinkRose JSON 和 XMP**：JSON 用于整组备份 / 恢复；XMP 可导入桌面修图软件常见的单套预置，也可把当前调色导出成 XMP。PinkRose 自己导出的 XMP 用自定义命名空间保存全部调色参数，能无损回读；第三方 XMP 映射曝光、对比、高光、阴影、黑白场、增量色温 / 色调、清晰度、纹理、去雾、自然饱和度、饱和度、锐化、降噪、颗粒、暗角，以及满强度黑白和红 / 绿 / 蓝灰度混色。未映射的 HSL / 曲线 / 美颜 / 几何参数按零处理，不伪装成完整兼容。
> 单张照片和同目录同名 `.xmp` 一起选择时，会自动把旁车当作这张照片的初始调色，优先于账号默认风格；匹配不唯一或 XMP 损坏时不会猜，会明确说明没有套用。
> 一次选择多张照片和各自同名 XMP 时会进入批量处理：每张带旁车的照片优先使用自己的配方，没有旁车的照片继续使用整批统一调色；读取失败的旁车会逐份列出，照片本身仍照常处理。
> 批量处理可勾选「附带 XMP 调色配方」：下载或分享的 ZIP 会在每张成片旁放一份同名 `.xmp`，记录这张实际套用的调色参数（包括自动增强和自动镜头校正后的结果）。Lut 不会写进 XMP，界面会明确提示单独保留。
> 调色面板提供「复制调色 / 粘贴调色」：把当前参数和滤镜引用放进跨照片剪贴板，换一张照片后可一键套用，不必先命名保存预设；剪贴板会做参数钳制，旧版本缺的新参数按 0 补齐。
> 调色面板「Lut → 导出当前外观」把当前颜色、曲线、HSL、三段色彩分级和正在用的 Lut 烘焙成标准 33³ `.cube`：先点「生成 .cube」，再点「下载 .cube」，苹果端也不会因为异步下载丢掉用户手势。局部蒙版、镜头校正、美颜和纹理这类空间 / 局部效果不会写进 LUT；文件可再导入本产品，也能给支持 `.cube` 的剪辑 / 调色软件使用。
> Lut 导入同时支持 **1D 和 3D `.cube`**：1D 文件按 R / G / B 三条独立曲线展开成现有 3D 纹理，导入后在编辑器、批量、缩略图和对话选 Lut 中走同一条渲染链；1D 保留原文件的 `TITLE` 与 `DOMAIN_MIN / MAX`。
> 导出支持 **JPG / PNG / WebP / AVIF / TIFF，以及本机编码器可用时的 HEIC**。JPG / PNG / WebP / TIFF 会内嵌同一份 sRGB ICC 色彩配置，苹果「预览」、Photoshop 和印刷软件能按同一套颜色解释；AVIF / HEIC 的色彩配置由本机编码器决定。TIFF 在浏览器里写 8 位 `.tif`：没有透明像素时是 RGB，有透明像素时是未预乘 RGBA；浏览器支持 `CompressionStream` 时使用无损 Deflate，否则回退无压缩。适合摄影、打印和后续继续编辑，不经过云端。JPG / PNG / WebP / TIFF 都能保留或主动移除拍摄信息，并可填写作者和版权，分别写入标准 EXIF `Artist` / `Copyright`（TIFF 写同义 IFD 标签）；标准字段建议使用英文、数字、拼音和 `©`。TIFF 还会把相机、镜头、曝光、白平衡和 GPS 写成标准 IFD 标签，AVIF / HEIC 当前不写回，界面会明确提示。
> 导出设置可选 **sRGB / Display P3**：P3 会先把 sRGB 像素数值正确转换，再给 JPG / PNG / WebP / TIFF 写入 Display P3 ICC；不会只换标签。当前编辑工作色域仍是 sRGB，因此界面明确说明 P3 交付不会恢复已被 sRGB 管线收窄的颜色。
> 批量处理共用同一套色彩空间选择；整批成片按 P3 编码，给作品集另存的 JPEG 母版仍保持 sRGB。
> 调色面板的「照片信息」按需读取本机文件：显示文件名、大小、尺寸、相机、镜头、拍摄时间、快门、光圈、ISO、焦距、白平衡、作者、版权和 GPS 坐标；JPG、PNG、WebP 和 TIFF / 常见 TIFF-based RAW 都会读取对应 EXIF（PNG 的 `eXIf`、WebP 的 `EXIF` chunk），导出的 PNG / WebP / TIFF 再导回来仍能恢复摄影信息。坐标只在本机显示，不调用地图或上传位置。
> 「镜头校正」组除了畸变 / 色差，还提供**暗角校正**：正值提亮四角、负值加深，中心不动；按画幅比例归一化，2 MP 和 48 MP 的观感一致。适合修掉广角镜头和遮光罩造成的四角发暗。
> 「镜头校正 → 镜头配置」会读取照片 EXIF 里的机身 / 镜头型号，从内置的 15 套常见镜头（Sony / Canon / Nikon / Fujifilm / Sigma / Tamron / iPhone 主摄）里给出一组畸变 / 暗角 / 色差起点；点「套用配置」才写入，认不出镜头时仍可手动选，套完还能继续拖三根滑杆微调。内置值是近似起点，不是测量级标定，也不会自动覆盖用户已经手调过的参数。冷门镜头可以把自己调好的三根存成「我的配置」（只存本机）：下次同一支镜头按 EXIF 自动认回来，批量页的按 EXIF 自动镜头校正也会优先使用它。
> 调色面板头的「推荐」会采样当前照片，从内置预设里挑一套最接近的起点；不联网、不花模型额度，点完仍可继续拖滑杆或另选预设。
> 「点修 → 克隆」可以选源点后在目标处涂抹，把源点附近的内容复制过去；第一笔落点定下复制方向。
> 「点修 → AI 消除」先涂住要去掉的人或物，只把选区周围的一小块送去云端；回图只贴回涂过的区域，掩码外、构图和参数都不动。输入一句「把它换成一只橘猫」这类指令时，同一选区会变成 AI 局部编辑；留空仍是消除。会消耗生成额度，一次涂太大会提示分几次处理。
> 「局部」里的「自动眼 / 自动牙」用本地正脸框生成眼睛和牙齿选区，再交给亮眼 / 牙齿效果；边缘仍可用画笔修。
> 人像预设包含牙齿、亮眼和手动红眼去除。
> 「点修 → 抠图」支持「智能主体」或点背景自动选区，再用手动画笔修边；背景可直接换成白底、证件蓝、浅灰、虚化、自定义颜色或自己的图片。PNG / WebP 保留 alpha，JPG 自动铺白底。
> 换背景还内置晴空 / 日落 / 暮色三种本地生成的天空，配合智能主体可直接换天；天空和自定义背景都支持缩放、左右 / 上下移动和翻转，移动范围随缩放自动限制，不会拖出空白。
> 调色面板「效果 → 去雾」把雾天、远处发灰的一层空气感拉开；往负值拖会给画面加雾。它进预设、会话和作品配方，全程本地计算。
> 调色面板「效果 → HDR」把大光比照片的暗部提起来、亮部压回去，再加一点局部反差；适合逆光、窗内窗外和夜景灯牌。
> 调色面板「效果 → 柔光」让高光向周围轻轻溢出，适合逆光人像、夜景灯牌和梦幻氛围。
> 调色面板「曲线」支持整体影调 + 红 / 绿 / 蓝三条分通道曲线；切通道后拖五个控制点，可修偏色或做电影感分离色调。每条通道另有「柔和 S / 强对比 / 哑光 / 提亮」四个本机预设，点一下只改当前通道，其他通道和曝光参数保持不动。
> 调色面板顶部有实时 RGB 直方图、亮度波形和矢量示波器，可切换查看；同时给出暗部 / 高光溢出读数。画布右下角还有「高光 / 暗部」裁切警告：高光在照片上标红、暗部标蓝，关闭立即恢复；提示画在独立覆盖层，不改变主画布和导出字节。
> 调色面板提供「颜色取样」：点一下照片，按当前渲染结果读取一小块平均色，显示 HEX、RGB 和 HSL，并可一键复制 HEX。它只读数，不修改参数、不新增历史，也不上传照片。
> 「文字」工具现在是**可回改的文字层**：可以叠多层、点已有层回来改内容 / 字体 / 颜色 / 位置，也可以单独删除；文字层按版本记账本，支持上一步 / 下一步，刷新会话后仍然在，导出时才合成进成片（底图像素不会被写字破坏）。裁剪、透视、扩画布、加边框或超清放大会先把文字层合并进底图，避免尺寸变化后字跑位；这些操作同样可以撤销。内置标题 / 极简 / 胶片 / 杂志 / 旅行 / 手记六套模板，可选黑体 / 宋体 / 楷体 / 等宽四档字体，按照片短边自动定字号；支持整块文字旋转 -180°~180°、行距 0.8~2.0 和字距 -20~40px。
> 对话栏加号里有「修复老照片 / 画质增强 / 黑白上色 / 消除路人 / 换天空 / 动漫化 / 手绘化 / AI 写真 / AI 换装 / 去水印 / AI 发型 / 海边背景 / 城市夜景 / 雪景 / 商品白底」：用固定提示词做老照片修复、清晰度与降噪增强、黑白照片上色、清理背景人物、替换天空、画风转换、棚拍人像、换西装、去叠加水印、换齐肩层次发型，或把背景换成海边 / 城市夜景 / 雪景 / 纯白商品棚；尽量保留构图、身份、服装和主体边缘；生成新版本，可撤销。走云端图片模型，会消耗生成额度，结果取决于原图与模型表现。
> 预设栏新增「夜景增强」：抬暗部、压高光、降噪，再用一点 HDR 和柔光保住霓虹层次；全部本地计算，不调用模型。
> 「人像」会本地估出正脸框，用「瘦脸 / 小头 / 颅顶 / 大眼 / 瘦鼻 / 下巴 / 微笑 / 瘦颈 / 双下巴 / 直角肩 / 瘦身 / 长腿」自动塑形，再用「补光 / 美白 / 红润 / 口红 / 腮红」提亮暗脸、调肤色和上妆（珊瑚 / 玫瑰 / 莓果三档色号）；美白 / 红润先用肤色门避开眼睛、嘴唇和背景；微笑只把嘴角向斜上方轻提，幅度保持克制；颅顶只抬额头上方的头顶中段、长腿只拉脸下方身体中段，上下缘都淡出；小头会连头部周围一起缩放，瘦颈只收下巴下方两侧、双下巴只轻提下巴下方软组织、直角肩只抬肩线外侧；合影识别到多张脸时会出现「全部 / 脸 1 / 脸 2」选择，也可以直接点照片里的脸框选人；单脸只改选中的人，「全部」会把脸局部效果逐脸应用，瘦颈 / 肩线 / 身体和长腿只执行一次，避免重复拉伸；自动找不到脸或框认错时可以点「重选脸」，直接在照片上拖一个脸框继续修，不必退出工具；复杂发丝和复杂背景可继续用局部液化手工修；先预览，应用后才写进当前底图，可撤销。
> 「人像 → 一键美颜」给出一套自然的起点：自动找脸框内的小暗点并修补、脸框内磨皮、轻瘦脸 / 大眼 / 瘦鼻 / 下巴 / 微笑、补光、美白 / 红润、口红和腮红；磨皮用脸框软边蒙版，背景和衣服不跟着糊。磨皮默认保留 35% 皮肤纹理，毛孔和皮肤起伏还在，不会磨成塑料；工具行的「磨皮」画笔另有「纹理」滑杆，0 最平滑、100 等于不磨，可以按皮肤状态自己拿捏。全在本机计算，不花生成额度，之后仍可继续拖滑杆或重来。
> 「人像 → 颅顶」把额头上方的头顶中段向上拉，增加颅顶高度；上下缘和两侧都做软过渡，脸框下方、背景和复杂发丝保持原位，强度 0 = 不动。
> 「人像 → 长腿」把脸下方身体中段向下拉，视觉上拉长腿部；上下缘和两侧软过渡，脸本身和画面外侧不动；适合全身照，背景很复杂时建议改用局部液化。
> 「作品 → 证件照」支持一寸 / 二寸 / 小二寸 / 签证尺寸，自动取景、换白 / 蓝 / 红 / 浅灰底并下载 JPG，还能排成 6 寸相纸八张打印版，全程本机完成。
> 「作品 → 打印排版」支持 6 寸 1 / 4 / 8 张、5×7 2 张、A4 6 / 9 张、A5 4 张和自定义毫米尺寸：单张自动循环铺满、多张按顺序铺格，每一格都能单独换成别的照片；横版 / 竖版可切，页边距 / 格子间距可调，可选填满裁切 / 完整留白和裁切参考线，下载 300dpi JPG 或 PDF。
> 「作品 → 照片动图」把 2–12 张照片做成循环 GIF：可选 1:1 / 4:5 / 3:4 / 9:16 / 16:9 画幅、480 / 720 / 1080 宽、每张 0.4–2 秒、填满裁切或完整留白、循环开关；纯前端编码，Safari / iPhone 也能直接导出。另可导出 H.264 MP4（30fps，需要本机 Node 服务与 ffmpeg）；苹果端直接下载 MP4，不依赖 MediaRecorder。
> 「作品 → 短片调色」导入手机拍的 MP4 / MOV / WebM，剪一段或拼最多 6 段（全片合计 20 秒，12 / 24fps），每段单独拖起点 / 终点、可以调顺序；可选原比例 / 1:1 / 4:5 / 9:16 / 16:9 成片画幅，套用和照片完全相同的一套预设与强度；视频人像区另有磨皮 / 美白 / 红润三根滑杆（叠加在预设上，按肤色门控，逐帧计算）；可加最多 10 条字幕（上下中位置、三档字号、三种颜色、按全片时间出现和消失，直接烧进画面），可加一段本地背景音乐（混合原声或替换，音量可调，短了自动循环），导出 H.264 MP4；预览停在哪一帧都能「截一帧存作品」。逐帧渲染在浏览器本地完成（同一条 WebGL 着色器，暗角 / 颗粒 / 虚化也一致），服务端只用 ffmpeg 编码并把每段原声按顺序接回来（没有音轨的段补等长静音）；苹果端不依赖 MediaRecorder。20 秒 24fps 约 480 帧，导出时可以随时取消；需要本机 Node 服务与 ffmpeg。
> 「作品 → 照片电影」选 1–12 张照片，按顺序做成一段带**缓慢推近 / 拉远 / 平移**的 MP4（也可以选静止），相邻照片可选硬切或**0.4 秒淡入淡出**；每张 1–4 秒、全片最多 20 秒；可套用照片预设、加本地配乐（自动循环到全片长度），导出 H.264 + AAC。「照片动图」是硬切幻灯片，「照片电影」是镜头在动、带转场的回忆视频；两者共用同一套逐帧渲染与编码链路，苹果端不依赖 MediaRecorder。
> 「作品 → 社交封面」用一张照片加标题直接做小红书封面 / 朋友圈 / 竖屏故事 / 杂志留白：标题自动折行，可调强调色、文字色、留白底色和 JPG / PNG；照片裁切、渐变和文字都在本机完成。
> 导出设置支持原图 / 1:1 / 4:5 / 3:4 / 9:16 / 16:9 社交比例；可选居中裁切、模糊扩展或镜像扩展，按目标长边输出。
> 导出格式支持 JPG / PNG / WebP / AVIF / TIFF，并在本机具备 HEIC 编码器时增加 HEIC（macOS 优先使用系统 `sips`，其他系统使用带 HEIC 支持的 ImageMagick）。TIFF 由浏览器本地生成 8 位 RGB / RGBA `.tif`，单张和批量都支持；浏览器支持 `CompressionStream` 时用无损 Deflate，否则自动回退无压缩；批量处理画布是 WebGL 时会先转到临时 2D 画布再编码。HEIC 选项只有在服务端实测可用时才出现，单张导出和批量页共用同一份能力判断；没有编码器时不会留下点了必然失败的按钮，也可以继续导出 JPG / WebP。WebP / AVIF / HEIC / TIFF 批量成片会额外生成一份 JPEG 作品母版，下载和 ZIP 保留用户选择的格式，而“存进作品”仍能正常保存。AVIF 由本机 ffmpeg（libaom-av1）转码，同一画面通常比 JPG 小 40–60%，Safari 16.4+ / iOS 16.4+ 可直接显示；大图会先把画布编成 WebP 中间图（保留透明度、体积远小于 PNG），避免 PNG 中间图超过服务端 12MB 上限，没有 ffmpeg 时会明确提示换 JPG / WebP。
> 单张导出可在「文件名」里填自己的名字，扩展名会跟着当前格式自动换；留空仍用「原文件名_pinkrose」。下载和系统分享共用这个名字，批量处理继续用批量页自己的命名规则。
> 导出设置里有「常用平台」：小红书 3:4、朋友圈 1:1、微博 4:3、竖屏视频 9:16，一键切成 JPG、长边 1080 和居中裁切；「全部打包」会一次生成四张并放进一个 ZIP，沿用当前水印和拍摄信息隐私选择。套完仍可改回 PNG / WebP、扩展方式或原尺寸。批量处理的画幅选择也补了 4:3 横版。
> 导出设置里点「设为默认」会把当前格式 / 质量 / 尺寸 / 比例 / 拍摄信息选项记在这台设备并同步到账号；下次打开新照片、或换设备登录同一账号都会沿用，离线时本机值仍然有效。
> 个人设置 →「修图偏好 → 默认风格」可以选一套内置预设或「我的预设」作为下一张新照片的起点；只影响新打开的照片，正在编辑的这张不会变。选择会同时写进本机和账号，换设备登录同一账号也会沿用；相机拍到 / 自动导入的新照片同样按它起手，相机桥「导入全部」进入批量处理时也会预选这套风格。
> 个人设置 →「修图偏好 → 界面外观」可在深色 / 浅色之间切换：默认深色，减少环境光对照片明暗和色温判断的影响；浅色适合白天、投影或系统本身偏亮的场景。选择同样同时写本机和账号，落地页 / 登录页仍跟随系统。
> 支持图片剪贴板的浏览器可在导出设置里直接「复制图片」：会带上当前水印、比例和尺寸设置，统一输出 PNG，粘贴到聊天或文档即可。
> JPG / PNG / WebP / TIFF 默认保留原图的拍摄时间、相机和 GPS 信息；导出设置里可以整体关闭拍摄信息，也可以只取消「包含 GPS 位置」，保留相机、镜头和曝光但移除坐标。作者和版权留空时保留原值，填写后覆盖标准 EXIF / TIFF 标签；批量处理也遵守这两级开关和同一份权利信息，作品母版不会偷偷保留已经关闭的元数据。
> 导出和批量处理都支持水印：文字或图片 Logo、单个或平铺、位置 / 透明度 / 大小可调；文字水印还能选黑体 / 宋体 / 楷体 / 等宽，与文字图层使用同一套字体。文字、字体、颜色、位置、透明度和排布会记在这台浏览器，下次打开导出或批量页自动恢复；Logo 图片本身不持久化。水印只加在导出副本上，不污染当前底图。
> 批量处理支持统一方向（左转 / 右转 90°、180°、水平 / 垂直翻转）、统一画幅（保持原样 / 1:1 / 4:5 / 3:4 / 9:16 / 16:9，居中裁切；选好画幅后可逐张点「取景」手动拖框 / 缩放，手动取景优先于智能主体构图）、逐张自动增强（只校正曝光、对比、高光、阴影、白平衡与饱和度）和**按 EXIF 自动镜头校正**（每张认镜头，认出的覆盖畸变 / 暗角 / 色差，认不出的保留你选的值）。画幅、方向、自动增强、自动镜头校正和文件命名会记住上次选择，也可用「恢复默认」一键清回；不会把高开销的人像 / 背景等设置悄悄带给下一批。调色可以直接选「当前调色」或任意预设，并用「预设强度」把整套参数按 0~100 混合后再套到整批照片上；已导入的 Lut 也能独立叠加并调强度；「创意风格 → 双色调」还能整批套同一套渐变映射，自选暗部 / 亮部颜色和强度。人像精修除磨皮 / 补光 / 美白 / 红润 / 去斑外，还能整批做瘦脸、瘦颈、双下巴、直角肩和微笑，没找到脸的照片保留原样；打开「合影多人脸」后，肤色检测到的多张脸都会参与磨皮 / 补光 / 美白 / 红润 / 去斑和瘦脸 / 微笑，结果里会报告实际覆盖了几张脸。输出增强支持 2× / 4× 本机放大。文件可按原文件名保留，也可用统一前缀 + 三位序号，或「前缀 + EXIF 拍摄日期 + 序号」重命名；日期缺失时回退文件修改日期并在结果里报告。批量页的「智能挑图」会本地看一遍清晰度和曝光，给每张标「保留 / 复查」，只给建议，不自动删照片；处理完成后结果区会给每张成片一张小缩略图，下载 ZIP 前可以先快速检查，每张也可以单独下载，或者直接点「存进作品」把成片写进作品集。
> 作品页和详情页支持 0–5 星评分与红 / 黄 / 绿 / 蓝 / 紫五色整理标签：作品卡片直接点星，点同一颗可清回 0 星；作品页可按评分、保留 / 排除、颜色、机身和镜头筛选。保存作品时会留下原文件名、EXIF 拍摄时间、机身和镜头；详情页会列出这些来源信息，图库搜索可直接找 `IMG_1234`、机身型号或镜头。有拍摄时间时可在「按最近编辑 / 按拍摄」之间切换日期分组，旧作品缺 EXIF 会自动回退到编辑时间。5 张以上、彼此相隔不超过 1.5 秒且整段不超过 20 秒的相邻作品会折成「连拍组」，收起时只占一格，展开后每张仍能查看、评分和勾选。连拍优先看 EXIF 拍摄时间，绝不跟最后编辑时间走；也可一键关掉。「整组挑最好」会直接在收起态比较整组缩略图的清晰度和曝光，进入多选并只留下本机评分最高的一张，仍不判断审美、不上传原片。多选作品后可以批量打星、清除评分或一次给整组标色；「智能复查」会逐张看清晰度和曝光，把建议保留 / 建议复查一次请求写进选片标记，不删除照片；选中两张可以「对比两张」，直接进入已有的左右同步拖线对比。选中一张后点「找相似」，会在本机比较当前筛选结果的缩略图感知哈希，把相近构图和连拍一起选中，不上传照片。选中至少两张后点「挑最好」，同样只留下分数最高的一张；推荐句说明原因和本机分数，不自动删除。全屏看片也能点色标，再点同色取消。卡片右上角可进入全屏看片，方向键切换、数字键 0–5 评分、P 保留、X 排除、U 清除标记、Z 或双击切 1:1 查看、C 进入左右对比、[ / ] 换对比图、E 打开编辑、Esc 退出；对比时可拖分割线看两张照片的同一块区域。评分、标记和颜色都保存到账号，不修改图片字节，也不会让作品在时间分组里跳到今天。
> 作品页支持自建相册 / 收藏集：可新建、重命名、删除，多选作品后可直接加入，按相册筛选查看；删相册只删分组，不会删照片。筛选到某个相册后，可以整组送进批量处理（最多前 20 张，取原图，单张失败不拖垮整组），也可以整组下载为一个原图 ZIP。
> 作品详情支持「生成分享链接」：链接是只读的，未登录也能打开；可复制链接或走系统分享，停止分享后旧链接立即失效。公开页只显示作品名、日期和图片，不暴露调色配方、账号或硬盘文件名。
> 「裁剪 → 透视」支持四角自由拖拽，把梯形拍歪的建筑 / 屏幕 / 画框拉正；也可以先点「自动透视」，在本机找贯穿画面的左右竖边并填好四个角。识别结果只进预览，用户确认后才应用；找不到可信竖线时会明确提示手动拖，不会硬拉一张普通照片。算法只处理垂直方向的一点透视，三点透视、鱼眼和弯曲页面仍需手动框。
> 裁剪比例支持 1:1 / 4:5 / 3:4 / 9:16 / 16:9 / 3:2 / 2:3 / 4:3 / 原图 / 自由，并可输入自定义宽高比；比例只收裁剪框，不放大照片。
> 「裁剪 → 自动水平」会本地找地平线，把「水平矫正」一次拨正；找不到可信的水平边时会明确提示手动拖。
> 「裁剪 → 智能构图」先选一个画面比例，再在本地估出主体位置，把裁剪框平移到主体上；只移动框，不改比例、不写像素、不提交。背景复杂或主体不明显时会提示手动拖框。
> 裁剪里的构图参考线可在「网格 / 三分 / 黄金分割 / 对角线 / 关闭」之间循环，全部只画在预览框里，不写进成片。
> 「裁剪 → AI 扩图」支持 1:1 / 4:5 / 3:4 / 9:16 / 16:9：原图居中，四周由图片模型自然补画，生成后是新的一版，可撤销。
> 「裁剪 → 超清放大」可选 2× / 4×，本机高品质重采样并轻度锐化；不调用模型，4× 同样受设备画布和 12 MP 本机缓冲上限保护，可撤销。
> 「装饰 → 叠加」支持第二张图双重曝光，四种混合模式和不透明度可调。
> 「装饰 → 画布」把单张照片放进原图 / 1:1 / 4:5 / 3:4 / 9:16 / 16:9 画布，可选纯色、当前照片的模糊背景或透明背景，边距 0%~20%；先预览，应用后写进当前底图并记一笔账。
> 「装饰 → 涂鸦」可以自由画线，颜色、笔刷粗细和不透明度可调；支持撤销一笔 / 清空，应用后写进当前底图，可撤销。
> 「装饰 → 贴纸」内置星 / 心 / 闪光 / 箭头 / 对话框 / 花 / 云 / 皇冠 / 音符 / 闪电 / 对勾 / 太阳十二种矢量贴纸，可拖位置、调大小、旋转、颜色、不透明度和混合模式；也可以选自己的 PNG / WebP / HEIC 图片当画中画，透明背景保留，支持完整显示 / 填满裁切和水平 / 垂直翻转。贴纸现在是**可回改的贴纸层**：可叠多个、点已有贴纸回来改或删除，按版本记账本，刷新会话后仍在；自定义图片贴纸会存一份 512px 内的透明 PNG 数据用于恢复和导出。裁剪、透视、扩画布、加边框或超清放大会先合并贴纸层并清空层，撤销时层一起回来。
> 「装饰 → 形状」可在照片上直接拖出矩形 / 椭圆 / 直线 / 箭头；线宽、圆角、描边色、填充色、不透明度和混合模式可调，线宽和圆角按照片短边缩放。形状现在是**可回改的形状层**：可以叠多个、点已有形状回来改或单独删除，按版本记账本，刷新会话后仍然在，导出时才合成进成片。裁剪、透视、扩画布、加边框或超清放大会先合并形状层并清空层，撤销时层一起回来。
> 「装饰 → 光效」内置逆光 / 漏光 / 光斑 / 霓虹四种程序化光效，以及可调光源方向与冷暖的「方向光」；强度可调，应用后写进当前底图、可撤销。
> 「装饰 → 双色调」内置墨青 / 玫瑰金 / 银蓝 / 赤焰 / 紫夜 / 黑白六套渐变映射，也可以自选暗部 / 亮部颜色和强度；先预览，应用后写进当前底图、可撤销。全部本机计算，不上传照片。
> 「镜头校正」可拉直广角畸变，并补偿画面边缘的红 / 青色差；0 时保持原始采样。镜头配置只是把这三根滑杆一次拨到合适的起点，最终仍以滑杆上的值为准。
> 「镜头」组的虚化可选**径向**或**移轴**：径向模式拖动焦点环，清晰区跟着焦点走；移轴模式在照片上显示一条可上下拖动、可调角度的清晰带，带外逐渐变糊，适合建筑、街景和俯拍微缩效果。也可以直接在对话里说「做成移轴」「清晰带斜一点」，它会走本地参数，不调用生成模型。方向键可微调、Shift 加速、Home 回中心；强度回 0 时辅助线自动隐藏。
> 「光效」组新增白色色阶 / 黑色色阶，「细节」组新增纹理：分别调最亮端点、最暗端点和中频质感，0 = 不动，可进预设、会话和作品配方。
> 「细节 → 彩色降噪」单独平滑高 ISO 照片里的红绿蓝彩斑，只混色度、保留亮度边缘和明暗纹理；和普通「降噪」分开调，避免为了压彩噪把整张照片抹软。
> 「细节 → 锐化」新增「锐化半径」和「锐化蒙版」：半径决定看多宽的轮廓，蒙版越高越只锐化明显边缘，纯色墙面、皮肤和高感噪点区不会被一起放大。
> 「HSL」新增「从照片取色」：点一下画面里的颜色，自动切到最近的色带，再调色相 / 饱和度 / 明度；太灰或太暗会提示换一块有颜色的地方。
> 「作品 → 拼图」支持 2–9 张照片合成一张，内置经典网格 / 杂志 / 胶片条 / 大图故事 / 九宫格五套模板，版式、画幅、间距、圆角和背景色也可继续微调。
> 「作品 → 九宫格切图」把一张照片切成 2×2 / 3×3 / 4×4，支持间距、圆角、白底或透明底、JPG / PNG、单格 1080 / 2048 长边；按 1 → N² 的顺序打包成 ZIP，全程本机完成。
> 「作品 → 长图」把 2–20 张照片按顺序接成纵向或横向长图，支持间距、圆角、背景色、JPG / PNG / WebP、固定边 1080 / 1440 / 2048；可上下调整顺序，总长超过画布上限时整体等比缩小，全程本机完成。
> 「作品 → 全景」支持 2–8 张有重叠的照片，按拍摄顺序自动找接缝，横向或纵向拼成一张长图；短边、格式和质量可调，全程本机完成。
> 「作品 → HDR 合成」支持 2–5 张同一场景的不同曝光照片，本机做曝光融合，暗部和亮部都保住；可自动对齐轻微手抖，自然 / 鲜明 / 戏剧三种风格。相机桥完成包围曝光后可直接点「用这组做 HDR」，整组照片会按顺序预填，不用再手动重选。
> 「作品 → 长曝光」支持 2–8 张同机位连续照片：车流光轨用逐通道高光累积，流水丝滑用多帧平均；可自动对齐轻微手抖，JPG / PNG / WebP 导出。
> 「作品 → 焦点堆栈」支持 2–15 张同一机位、不同对焦点的照片：本机估计轻微平移，逐像素保留最清楚的一到两张，适合微距、产品和风景；可自动对齐轻微手抖，JPG / PNG / WebP，高度 1200 / 1600 / 2000 可调。相机支持可写焦点位置时，完成焦点包围后可直接带入整组照片预填。

| 修容 / 高光（局部涂抹；冷棕 / 暖棕 / 灰棕，香槟 / 珍珠 / 蜜桃） | [localAdjust.ts](src/image/localAdjust.ts) + [LocalControls.tsx](src/ui/LocalControls.tsx)（接线在 [app/useLocal.ts](src/app/useLocal.ts)） |
| 预设栏（照片左边那排效果小图） | [PresetRail.tsx](src/ui/PresetRail.tsx) |
| 智能主体 / 换背景（本地前景估计；白底 / 纯色 / 虚化 / 天空 / 自定义图片） | [subjectSelect.ts](src/core/subjectSelect.ts) + [backgroundReplace.ts](src/image/backgroundReplace.ts) + [TransparentControls.tsx](src/ui/TransparentControls.tsx) |
| 人像自动塑形与肤色（本地正脸框；瘦脸 / 小头 / 颅顶 / 大眼 / 瘦鼻 / 下巴 / 微笑 / 瘦颈 / 双下巴 / 直角肩 / 瘦身 / 长腿，补光 / 美白 / 红润，预览后提交） | [faceDetect.ts](src/core/faceDetect.ts) + [faceShape.ts](src/image/faceShape.ts) + [skinTone.ts](src/image/skinTone.ts) + [PortraitControls.tsx](src/ui/PortraitControls.tsx) |
| 我的预设导入 / 导出（版本化 JSON 整组、单套 XMP 基础兼容 / 全参数回读、格式校验、重名检查） | [PresetManager.tsx](src/ui/PresetManager.tsx) + [presetFile.ts](src/core/presetFile.ts) |
| 一键自动（本地直方图分析 → 影调 / 白平衡） | [autoEnhance.ts](src/core/autoEnhance.ts)（按钮在 [AdjustmentPanel.tsx](src/ui/AdjustmentPanel.tsx)） |
| 白平衡吸管（点中性灰 → 色温 / 绿—洋红色调） | [whiteBalance.ts](src/core/whiteBalance.ts) + [sample.ts](src/image/sample.ts)（入口在 [AdjustmentPanel.tsx](src/ui/AdjustmentPanel.tsx)） |
| 智能构图（先选比例，再按本地主体位置移动裁剪框） | 几何 [core/smartCrop.ts](src/core/smartCrop.ts) + 低分辨率主体检测 [image/smartCrop.ts](src/image/smartCrop.ts)（入口在 [CropControls.tsx](src/ui/CropControls.tsx)） |
| 导出 / 分享（JPG / PNG / WebP / AVIF / TIFF、可用时的 HEIC、质量、长边尺寸、文字 / Logo 水印） | [ExportSettings.tsx](src/ui/ExportSettings.tsx) + [save.ts](src/export/save.ts) + [tiff.ts](src/export/tiff.ts) + [WatermarkControls.tsx](src/ui/WatermarkControls.tsx)（接线在 [useDelivery.ts](src/app/useDelivery.ts)） |
| 批量处理（最多 20 张、智能挑图清晰度 / 曝光建议、统一画幅 / 逐张手动取景 / 逐张自动增强、内置 / 我的预设 / 当前调色、批量双色调、批量人像塑形 / 合影多人脸、原文件名 / 前缀序号、文字或 Logo 水印 / 平铺、ZIP 下载或系统分享） | [BatchPanel.tsx](src/ui/BatchPanel.tsx) + [process.ts](src/batch/process.ts) + [batchCrop.ts](src/core/batchCrop.ts) + [duotone.ts](src/image/duotone.ts) + [faceDetect.ts](src/core/faceDetect.ts) + [faceShape.ts](src/image/faceShape.ts) + [cull.ts](src/core/cull.ts) + [image/cull.ts](src/image/cull.ts) + [autoEnhance.ts](src/core/autoEnhance.ts) + [watermark.ts](src/image/watermark.ts) + [WatermarkControls.tsx](src/ui/WatermarkControls.tsx) + [zip.ts](src/batch/zip.ts)（入口在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| 多图拼图（2–9 张、五套模板、自动/大图/网格、画幅、间距、圆角、背景、导出） | [CollagePanel.tsx](src/ui/CollagePanel.tsx) + [collage.ts](src/image/collage.ts)（入口在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| 九宫格切图（2×2 / 3×3 / 4×4、间距 / 圆角 / 白底或透明底、JPG / PNG、单格长边、ZIP） | [GridSplitPanel.tsx](src/ui/GridSplitPanel.tsx) + [gridSplit.ts](src/image/gridSplit.ts)（入口在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| 长图拼接（2–20 张、纵向 / 横向、顺序调整、间距 / 圆角 / 背景、固定边、JPG / PNG / WebP） | [LongImagePanel.tsx](src/ui/LongImagePanel.tsx) + [longImage.ts](src/image/longImage.ts)（入口在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| 全景拼接（2–8 张、横向 / 纵向、自动重叠检测、接缝渐变、顺序调整、JPG / PNG / WebP） | [PanoramaPanel.tsx](src/ui/PanoramaPanel.tsx) + [panorama.ts](src/image/panorama.ts)（入口在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| HDR 合成（2–5 张不同曝光、自动平移对齐、曝光融合、三种风格、JPG / PNG / WebP；相机包围曝光整组可直达并预填） | [HdrPanel.tsx](src/ui/HdrPanel.tsx) + [hdrMerge.ts](src/image/hdrMerge.ts)（入口在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| 焦点堆栈（2–15 张不同对焦点、自动平移对齐、逐像素保留最清晰版本、JPG / PNG / WebP；相机焦点包围整组可直达并预填） | [FocusStackPanel.tsx](src/ui/FocusStackPanel.tsx) + [focusStack.ts](src/image/focusStack.ts)（入口在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| 长曝光（2–8 张同机位连续照片、光轨 / 丝滑、自动平移对齐、JPG / PNG / WebP） | [LongExposurePanel.tsx](src/ui/LongExposurePanel.tsx) + [longExposure.ts](src/image/longExposure.ts)（入口在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| 证件照（标准尺寸、自动取景、智能换底、JPG 下载、6 寸八张排版） | [IdPhotoPanel.tsx](src/ui/IdPhotoPanel.tsx) + [idPhoto.ts](src/idphoto/idPhoto.ts) + [idPhotoSheet.ts](src/idphoto/idPhotoSheet.ts)（入口在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| 打印排版（6 寸 1 / 4 / 8 张、5×7 2 张、A4 6 / 9 张、A5 4 张、自定义毫米尺寸、横竖版、循环铺格、每格单独换图、自定义页边距 / 格子间距、填满 / 留白、裁切线、300dpi JPG / PDF） | [PrintPanel.tsx](src/ui/PrintPanel.tsx) + [printSheet.ts](src/print/printSheet.ts) + [pdf.ts](src/print/pdf.ts)（入口在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| 照片动图（2–12 张、GIF89a 全局 256 色 / LZW、可选 H.264 MP4、画幅 / 宽度 / 停留 / 留白 / 循环） | [GifPanel.tsx](src/ui/GifPanel.tsx) + [gif.ts](src/gif/gif.ts) + [motion.ts](src/gif/motion.ts) + [server/motion.ts](server/motion.ts)（入口在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| 社交封面（小红书 3:4 / 朋友圈 1:1 / 竖屏 9:16 / 杂志留白、标题折行、强调色、文字色、JPG / PNG） | [PosterPanel.tsx](src/ui/PosterPanel.tsx) + [poster.ts](src/poster/poster.ts)（入口在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| AI 扩图（裁剪子模式；5 种比例、镜像引导底图、生成新版本） | [OutpaintControls.tsx](src/ui/OutpaintControls.tsx) + [outpaint.ts](src/export/outpaint.ts)（接线在 [App.tsx](src/App.tsx) 与 [useGeneration.ts](src/app/useGeneration.ts)） |
| 超清放大（本机 2× / 4×、轻度锐化、设备上限保护、账本可撤销） | [upscale.ts](src/image/upscale.ts) + [useUpscale.ts](src/app/useUpscale.ts)（入口在 [CropControls.tsx](src/ui/CropControls.tsx)） |
| 修复老照片（一键固定提示词、复用生成链路、新版本可撤销） | [aiPresets.ts](src/core/aiPresets.ts) + [ChatPanel.tsx](src/ui/ChatPanel.tsx)（动作在 [App.tsx](src/App.tsx)） |
| 消除路人（一键固定提示词、只清背景人物、保留主体、新版本可撤销） | [aiPresets.ts](src/core/aiPresets.ts) + [ChatPanel.tsx](src/ui/ChatPanel.tsx)（动作在 [App.tsx](src/App.tsx)） |
| 换天空（一键固定提示词、只替换天空、保留前景与透视、新版本可撤销） | [aiPresets.ts](src/core/aiPresets.ts) + [ChatPanel.tsx](src/ui/ChatPanel.tsx)（动作在 [App.tsx](src/App.tsx)） |
| AI 风格化 / 人像（动漫化 / 手绘化 / AI 写真 / AI 换装 / 去水印 / AI 发型、固定提示词、保留身份与构图、新版本可撤销） | [aiPresets.ts](src/core/aiPresets.ts) + [ChatPanel.tsx](src/ui/ChatPanel.tsx)（动作在 [App.tsx](src/App.tsx)） |
| 作品多选下载（原图逐张取回、同名去重、ZIP） | [works.ts](src/batch/works.ts) + [SelectBar.tsx](src/ui/kit/SelectBar.tsx)（接线在 [GalleryPage.tsx](src/ui/GalleryPage.tsx)） |
| 作品集 | [GalleryPage.tsx](src/ui/GalleryPage.tsx) |
| 作品详情 | [WorkDetailPage.tsx](src/ui/WorkDetailPage.tsx) |
| 公开分享页（只读链接、未登录可看、可停止分享） | [SharedWorkPage.tsx](src/ui/SharedWorkPage.tsx) + [works.ts](src/api/works.ts) + `server/works.ts` |
| 个人设置 | [AccountPage.tsx](src/ui/AccountPage.tsx) |
| 模型设置 | [ModelSettings.tsx](src/ui/ModelSettings.tsx) |
| 滤镜（导入 1D / 3D `.cube` LUT） | [LutSettings.tsx](src/ui/LutSettings.tsx) + [lut.ts](shared/lut.ts) |
| 当前外观导出 LUT（33³ .cube，颜色 / 曲线 / HSL / 三段色彩分级 / 当前 Lut） | [lutExport.ts](src/export/lutExport.ts) + [LutExporter.tsx](src/ui/LutExporter.tsx) |
| 左侧导航栏 | [Nav.tsx](src/ui/Nav.tsx) |

---

## 每个文件夹是干什么的

| 文件夹 | 是什么 | 要不要管 |
|---|---|---|
| `src/` | 网页界面代码 —— **想改样子主要在这** | 要 |
| `server/` | 后台（登录、AI 调用、存照片） | 一般不用 |
| `shared/` | 前后两边共用的少量定义（含几句共用文案） | 一般不用 |
| `docs/` | 设计文档、文案规范、用户协议 / 隐私政策草案 | 想看规矩时进来 |
| `create-image/` | 素材原图（做产品页、欢迎页图片的原料） | 不用 |
| `archive/` | 旧档案：2026 年 9 月的实验脚本和小程序调研 | 不用 |
| `test-photos/` | 测试工具自己用的照片 | 不用 |
| `scripts/` | 开发用的小工具 | 不用 |
| `public/` | 网站公开的小文件 | 不用 |
| `data/` | **你的账号和照片数据** | ⚠️ 千万别删 |
| `dist/` | 打包产物（自动生成，删了会重生） | 不用 |
| `node_modules/` | 下载来的依赖（自动生成） | 不用 |
| `.superpowers/` | Claude 的工作台（画板、验收截图、过程档案），隐藏目录 | 不用 |

## ⚠️ 别碰这几样

- `.env` —— 钥匙。别打开看、别发给任何人。
- `data/` —— 你的账号和照片都在里面，删了就找不回来。
- `package.json`、`vite.config.ts`、`tsconfig*.json`、`index.html` —— 工程配置，动了可能起不来。

---

## 给接手的人（或 AI 助手）

- 测试：`npm test` ／ 类型检查：`npm run typecheck` —— 提交前**两个都要绿**
  （vitest 不做类型检查，「测试全绿」不等于「类型没病」）。
- ⚠️ **动了 `src/render/` 里任何 GLSL，必须跑 `npm run check:lut`**（真 Chrome + 真 GPU）：
  字符串哨兵 / typecheck / build / `check:layout` **四样都看不见"整个着色器程序编译不过"**——
  那种坏法是**每张照片全黑**，只有这一条探针抓得到（2026-10-05 真机上抓到过一次）。
- 前端 dev 在 `5173`（`npm run dev` 同时起）；**后端改动不热重载**，改完要重启。
- 设计文档在 `docs/superpowers/specs/`，实现计划在 `docs/superpowers/plans/`；
  写文案前先读 [文案规范.md](docs/文案规范.md)。
- [smoke.mjs](scripts/smoke.mjs) 会**花钱**（真实 API），只手动跑，不进 CI。
