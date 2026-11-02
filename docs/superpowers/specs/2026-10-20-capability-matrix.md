# 能力矩阵（2026-10-22）

这份表只记**代码里已经能点、能出结果**的能力，以及明确还没做的。
每行都能顺着文件找到实现；「验证」一列写的是最近一次实际跑过的检查。

> 2026-10-22 全量回归由 `scripts/test-all.mjs` 隔离重型 App 并分批执行，
> 共 **2751 项通过**。其中 App 核心分簇、服务端、shared、批量、导出、图像、
> 渲染和 UI 测试均按批次完成。自动测试不等于实机验收，硬件 / 广色域缺口仍以第七节为准。
> Windows 上最后一次 server + shared 合并批触发 Vitest worker 退出；同一批 48 个文件
> 拆成 336 + 469 两半重跑后全部通过，覆盖该批完整的 805 项。
> 同日补多文件拖放、单张 / 批量 XMP、相机桥旁车和照片专注看图后，
> `App.test.tsx` **71 / 71**；Chromium / WebKit 真实拖放、XMP 导入、
> 相机桥配对的 390px 专项探针均通过；生产构建与首包 1 MB 预算通过。

## 一、编辑核心

| 能力 | 落点 | 验证 |
| --- | --- | --- |
| 曝光 / 对比 / 高光 / 阴影 / 黑白场；高光 / 暗部裁切警告 | `shared/adjustments.ts`、`render/shader.ts`、`render/clipping.ts`、`ui/Canvas.tsx` | 调色面板测试、WebKit 直方图、`clipping.test.ts`、`Canvas.test.tsx`、`check:clipping`（WebKit 桌面 + 390px 7/7：警告层不污染主画布导出字节） |
| 调色参数搜索（88 根参数：按参数名 / 分组标题定位，Escape 或清除按钮恢复全部；粗指针设备搜索框 44px） | `ui/AdjustmentPanel.tsx` | `AdjustmentPanel.behavior.test.tsx`（参数名 / 组名 / 空结果 / 清除）、`check:touch`（WebKit iPhone + iPad 实际输入、分组过滤与恢复） |
| 颜色取样（点击当前渲染画面读取小块平均色，显示 HEX / RGB / HSL 并复制 HEX；不改参数、不新增历史、不上传照片） | `core/colorSample.ts`、`ui/AdjustmentPanel.tsx`、`App.tsx`、`ui/Canvas.tsx` | `colorSample.test.ts`（HEX / RGB / HSL 换算）、`AdjustmentPanel.behavior.test.tsx`（入口、读数、复制动作）、`check:color-sample`（WebKit iPhone 390px + 桌面 9/9：44px 触控、面板 RGB 与点击位置独立重绘一致、HEX / HSL、无参数变化、无溢出、复制值正确） |
| 按参数组重置（每个有改动的组头显示独立重置；只清当前组，其它组保留；组无改动时不显示入口；粗指针设备 44px 命中区） | `ui/AdjustmentPanel.tsx`、`styles.css` | `AdjustmentPanel.behavior.test.tsx`（只清光效，色彩保留）、WebKit 桌面 + iPhone 390px 实测（桌面 17 / 33 → 重置光效 → 0 / 33；iPhone 11 / 22 → 0 / 22；按钮 44×44、组头吸顶、无横向溢出、无控制台错误） |
| 色温 / 绿—洋红色调 / 饱和 / 自然饱和（色调保持亮度，全局与局部共用同一轴向；含日光 / 阴天 / 阴影 / 钨丝灯 / 荧光灯白平衡预设） | `shared/adjustments.ts`、`render/shader.ts`、`core/tone.ts`、`core/whiteBalancePresets.ts`、`image/localAdjust.ts`、`ui/AdjustmentPanel.tsx` | `adjustments.test.ts`、`tone.test.ts`、`uniforms.test.ts`、`shader.test.ts`、`whiteBalancePresets.test.ts`、`AdjustmentPanel.behavior.test.tsx`、`localAdjust.test.ts`、`App.tools.test.tsx`、`check:grading`（WebKit 15/15） |
| 黑白混色（黑白强度 + 红 / 绿 / 蓝通道混色，黑白预设使用真实通道权重） | `shared/adjustments.ts`、`render/shader.ts`、`core/tone.ts`、`core/presets.ts` | `adjustments.test.ts`、`tone.test.ts`、`uniforms.test.ts`、`shader.test.ts`、`presets.test.ts`、`check:bw`（WebKit 5/5：三色块变灰、红色权重改变亮度、归零复原） |
| 色彩平衡 + 三段色彩分级（阴影 / 中间调 / 高光独立色相与强度，支持明暗平衡；LUT 导出同步烘焙） | `shared/adjustments.ts`、`render/shader.ts`、`ui/AdjustmentPanel.tsx` | `adjustments.test.ts`、`uniforms.test.ts`、`shader.test.ts`、`AdjustmentPanel.behavior.test.tsx`、`check:grading`（WebKit 12/12：色调正负方向与亮度保持、三段各自着色、平衡生效、归零复原）、`check:lut`（真 WebGL 22/22） |
| HSL（8 色带 × 3 轴） | `ui/HslControls.tsx` | `hslPick` / 面板测试 |
| 曲线（整体 + RGB；每通道四个本机预设：柔和 S / 强对比 / 哑光 / 提亮，只改当前通道） | `ui/ToneCurve.tsx`、`core/toneCurve.ts` | `toneCurve.test.ts`、`ToneCurve.test.tsx`、WebKit 桌面 + 390px 实际点按（预设值 `4 / -28 / 0 / 28 / -4`，无横向溢出） |
| 清晰度 / 纹理 / 锐化 / 锐化半径 / 锐化蒙版 / 降噪 / 彩色降噪 / 颗粒（彩色降噪只平滑色度斑点；锐化蒙版只放行明显边缘） | shader + 细节组 | `shader.test.ts`、`uniforms.test.ts`、`AdjustmentPanel.behavior.test.tsx`、`check:color-noise`（WebKit：彩斑方差 -91.2%，亮度方差保持 100%，归零复原）、`check:sharpen`（WebKit 7/7：强边缘增强、平面噪声受控、半径生效、归零复原） |
| 去雾 / HDR / 柔光 / 暗角 | shader | `App.adjust.test.tsx` |
| 白平衡吸管 | `core/whiteBalance.ts` | `App.adjust.test.tsx` |
| 当前外观导出 LUT（33³ `.cube`：颜色 / 色温与色调 / 曲线 / HSL / 分离色调 / 当前 Lut） | `export/lutExport.ts`、`ui/LutExporter.tsx` | `lutExport.test.ts`、`LutExporter.test.tsx`、`check:lut-export`（WebKit 6/6：恒等、暖色温、洋红色调） |
| Lut 导入（1D / 3D `.cube`；1D 三通道曲线展开进现有 3D 渲染链） | `shared/lut.ts`、`render/pipeline.ts`、`LutSettings` | `shared/lut.test.ts`、`core/lut.test.ts`、`server/luts.test.ts`、`check:lut`（Chrome / WebGL2 22/22） |
| 裁剪 / 旋转 / 拉直 / 水平垂直翻转；裁剪框与八向把手支持方向键 1px / Shift 10px 精确移动和缩放，粗指针设备把手扩展为 44px 命中区 | `core/crop.ts`、`ui/CropOverlay.tsx` | 裁剪引擎测试、`CropOverlay.test.tsx`（拖动 / 比例 / 内接区 / 键盘移动与缩放）、`check:touch`（WebKit iPhone + iPad：九颗裁剪交互控件的真实命中区 + 实际键盘事件） |
| 透视校正（四角手动 / 自动找左右竖边；四角支持方向键 1px / Shift 10px 与 44px 触控命中区） | `core/perspective.ts`、`core/autoPerspective.ts`、`image/autoPerspective.ts`、`app/usePerspective.ts`、`ui/PerspectiveOverlay.tsx` | `perspective.test.ts`、`autoPerspective.test.ts`、`PerspectiveOverlay.test.tsx`（键盘步进 / 角点顺序）、`PerspectiveControls.test.tsx`、`App.tools.test.tsx`、`check:perspective`（WebKit 桌面 + 390px 6/6，普通正脸照不误判）、`check:touch`（WebKit iPhone + iPad 实际命中与键盘事件） |
| 镜头虚化（径向景深 + 可拖焦点 / 移轴清晰带 + 角度；对话可走本地参数） | shader、`LensFocusOverlay`、`AdjustmentPanel`、`server/prompt.ts` | `uniforms.test.ts`、`shader.test.ts`、`AdjustmentPanel.behavior.test.tsx`、`LensFocusOverlay.test.tsx`、`App.adjust.test.tsx`、`prompt.test.ts`、`validate.test.ts`、`check:lut`（Chrome / WebGL2 22/22）、`check:tilt-shift`（WebKit 桌面 + 390px 6/6，含实际倾斜方向） |
| 镜头畸变 / 色差 / 暗角校正 | shader | 调色面板、暗角实测 |
| 镜头配置文件（EXIF 识别 / 内置 15 套 / 我的配置 / 手动选择 / 一键套用 / 批量逐张；JPG + PNG + WebP + TIFF / DNG / 常见 TIFF-based RAW） | `core/lensProfile.ts`、`core/customLensProfiles.ts`、`image/tiffMetadata.ts`、`core/photoInfo.ts`、`ui/LensProfilePicker.tsx`、`batch/process.ts` | `tiffMetadata.test.ts`、`photoInfo.test.ts`、`lensProfile.test.ts`、`customLensProfiles.test.ts`、`process.test.ts`、`check:lens`（WebKit 11/11）、`check:raw-preview`（RAW 机型 / 镜头 / 焦距） |
| 单会话上下文记忆（服务端读取已存历史；超过 16 条或 6000 字自动整理，最近 8 条原文保留；摘要独立存储且不从会话接口返回）；跨会话稳定偏好（默认开启，可在个人设置查看、关闭、清除，不记录敏感信息和一次性需求） | `server/memory.ts`、`server/route.ts`、`server/prompt.ts`、`server/app.ts`、`src/api/memory.ts`、`ui/AccountPage.tsx` | `memory.test.ts`、`route.test.ts`、`prompt.test.ts`、`sessions.test.ts`、`app.test.ts`、`api/memory.test.ts`、`App.account.test.tsx`；桌面 Chromium 实测长期偏好关闭、重新开启和确认清除，请求体与页面状态同步、控制台 0 错误；真实模型抽样确认首次长期偏好写入、单会话接续、跨会话偏好和 18 条历史阈值压缩均生效，回复均未暴露记忆字段 |
| 内置联网搜索 MCP（官方 TypeScript SDK、stdio、`pinkrose_web_search` 只读工具；Bing RSS 优先、HTML 回退；外部事实按需搜索并附可点击来源；匿名近期事实可走“先搜索、单次回答”的快捷路；纯修图与相机色彩参考不生成；搜索失败仍按摄影搭子的正常身份结合照片和会话处理，不暴露内部步骤，也不把核实资料变成用户任务） | `server/searchMcp.ts`、`server/searchMcpClient.ts`、`server/webSearch.ts`、`server/searchIntent.ts`、`server/route.ts`、`ui/LinkifiedText.tsx` | `searchMcp.test.ts`、`webSearch.test.ts`、`searchIntent.test.ts`、`route.test.ts`、`prompt.test.ts`、`LinkifiedText.test.tsx`；真实 stdio MCP 调用 Bing 返回 3 条结果；真实模型抽样确认纯修图 0 搜索、外部色彩参考走本地参数且不生成、匿名近期事实单次模型回答并附来源、私人请求搜索词不含私人上下文、恶意搜索结果不被执行；真实 RSS 搜索 `Sony A7M5` 返回官方产品页、帮助指南和发布页；桌面 Chromium 实测来源链接为 `target=_blank` + `noopener noreferrer`、键盘焦点可见、无横向溢出、控制台 0 错误 |
| 审美创作导演（先判断场景、主体、光线、构图、色彩、质感与真实性边界，再从受控能力清单选择本地调色、人像、几何、镜头、配方、用户预设、Lut 或最多一次生成；人像、旅行、夜景、产品食物、建筑、旧照和社交发布使用可按版本扩展的场景 Skill；开放咨询给两条可执行方向但不擅自动图；计划编译后统一钳制、去重和风险复核；内部词与失败过程不进入 reply；旧版路由输出保持兼容） | `server/aesthetic/skills.ts`、`server/aesthetic/capabilities.ts`、`server/aesthetic/plan.ts`、`server/aesthetic/review.ts`、`server/prompt.ts`、`server/route.ts`、`src/app/useGeneration.ts` | `skills.test.ts`、`capabilities.test.ts`、`plan.test.ts`、`review.test.ts`、`integration.test.ts`、`route.test.ts`、`prompt.test.ts`；场景 Skill 选择、本地、单次生成、本地加生成、只给建议与多人物点选端到端通过；旧版 route / Lut / 预设 / 搜索 / 记忆用例全部保持通过；桌面 Chromium 模拟登录态完成真实上传、本地调色和对话，无横向溢出、控制台 0 错误 |

## 二、局部与人像

| 能力 | 落点 | 验证 |
| --- | --- | --- |
| 涂抹 / 线性 / 径向 / 色彩范围 / 明暗范围蒙版；颜色相近区域可按四邻连通生长（种子随局部层保存）；明暗范围按阴影 / 中间调 / 高光选择，并用范围 / 羽化控制软边，范围参数可随局部层回改 | `ui/LocalControls.tsx`、`GradientOverlay`、`core/colorRange.ts`、`core/luminanceRange.ts`、`image/luminanceRange.ts` | `colorRange.test.ts`、`luminanceRange.test.ts`、`layers.test.ts`、`App.tools.test.tsx`（含明暗范围应用与回改）、`check:connected-select`（WebKit 390px 4/4：左侧变、右侧同色块不变）、`check:luminance`（WebKit 390px 6/6：高光区变化、暗部不变） |
| 局部调色（亮度 / 对比度 / 高光 / 阴影 / 白色色阶 / 黑色色阶 / 去雾 / 饱和度 / 自然饱和度 / 色温 / 色调 / 清晰度；掩码外不写像素，色温、端点和去雾随局部层保存） | `image/localAdjust.ts`、`app/useLocal.ts`、`ui/LocalControls.tsx`、`shared/local.ts` | `localAdjust.test.ts`、`layers.test.ts`、`App.tools.test.tsx`（局部色调 / 白色黑色色阶 / 去雾应用）、`check:safari` / `check:touch` |
| 局部图层与混合模式 | `LayerPanel`、`shared/layers.ts` | `layers.test.ts` |
| 局部减淡 / 加深（阴影 / 中间调 / 高光范围） | `image/localAdjust.ts`、`ui/LocalControls.tsx`、`app/useLocal.ts` | `localAdjust.test.ts`、`layers.test.ts`、`App.tools.test.tsx`、`check:safari` / `check:tablet`（iPad 75/75；控制区与固定出口按钮分离后，明暗范围不再被覆盖） |
| 人脸检测 / 多脸 / 合影单脸或全部脸 / 手动圈脸；自动失败时可用 Enter 放置居中脸框、方向键移动、加减键缩放、Enter 确认 | `core/faceDetect.ts`、`app/usePortrait.ts`、`ui/PortraitControls.tsx`、`ui/Canvas.tsx`、`ui/FaceGuide.tsx`、`ui/ManualFaceOverlay.tsx` | `faceDetect.test.ts`、`ManualFaceOverlay.test.tsx`（键盘放置 / 移动 / 缩放 / 取消）、批量合影测试、`App.tools.test.tsx`（单脸切换；全部脸逐脸塑形、合并磨皮、身体关系只做一次；自动失败与重选脸）、`check:portrait`（WebKit 390px：14/14，全部脸双框与预览、直接点脸框选人、手动拖框并完成磨皮）、`check:touch`（WebKit iPhone + iPad 键盘兜底） |
| 磨皮（画笔 / 人像 / 全局 / 批量） | `image/smooth.ts`、`useSmooth`、`render/shader.ts` | `smooth.test.ts`、`App.tools.test.tsx`、`check:smooth`（WebKit 9/9：全局磨皮使脸颊纹理下降 64.3%，虹膜 / 睫毛边缘仅下降 11.4%；画笔涂抹后真实换底图，390px 无溢出、无控制台错误） |
| 一键美颜 | `usePortrait`、`PortraitControls` | 人像测试 |
| 瘦脸 / 大眼 / 瘦鼻 / 下巴 / 微笑 / 颅顶 / 瘦颈 / 双下巴 / 直角肩 / 长腿 / 瘦身 | `image/faceShape.ts`、`image/bodyShape.ts` | `faceShape` 测试 |
| 美白 / 红润 / 肤色 | shader、`image/skinTone.ts` | `skinTone.test.ts` |
| 口红 / 腮红 / 眼影 / 眉毛 / 眼线 / 美瞳 / 卧蚕 / 修容 / 高光 | `image/makeup.ts`、`localAdjust.ts` | `makeup.test.ts` |
| 点修 / 克隆 / 牙齿 / 亮眼 / 红眼 / 发色 / 去反光 / 黑眼圈 | `core/retouch.ts`、`localAdjust.ts` | `App.tools.test.tsx` |
| 液化（推 / 收 / 膨胀 / 收缩） | `image/liquify.ts` | `liquify.test.ts` |

## 三、合成与创意

| 能力 | 落点 | 验证 |
| --- | --- | --- |
| 文字 / 形状 / 贴纸 / 涂鸦 / 相框 / 画布 | `ui/Text*`、`Shape*`、`Sticker*`、`Doodle*`、`Frame*`、`CanvasFrame*` | 各自测试 |
| 双重曝光 / 双色调 / 打光 / 漏光 | `DoubleExposure*`、`Duotone*`、`Light*` | `App.tools.test.tsx` |
| 换背景 / 抠图 / 天空 | `backgroundSelect`、`skyMask`、`TransparentControls` | `backgroundSelect.test.ts` |
| HDR 合成 / 全景 / 焦点堆栈 / 长曝光 | `image/hdrMerge`、`panorama`、`focusStack`、`longExposure` | 各自测试 + 面板测试；`GalleryPage.hdr.test.tsx`（相机包围曝光整组自动打开 HDR 并预填）、`GalleryPage.focus.test.tsx`（相机焦点包围整组自动打开焦点堆栈并预填） |
| AI 消除 / 扩图 / 生成 / 预设动作 | `image/aiErase`、`export/outpaint`、`core/aiPresets` | `App.tools` / `aiPresets` |

## 四、输出与工作流

| 能力 | 落点 | 验证 |
| --- | --- | --- |
| 导出比例 / 格式（JPG / PNG / WebP / AVIF / TIFF，以及可用时的 HEIC）/ TIFF Deflate / 质量 / 长边 / 元数据（整体保留或移除；GPS 可独立移除；作者 / 版权写入 EXIF Artist / Copyright 与 TIFF IFD；TIFF 写标准 EXIF/GPS IFD）/ 水印（文字 / Logo、单个 / 平铺、位置 / 透明度 / 大小、四种文字字体、文字水印本机偏好恢复）/ 复制 / 四种社交尺寸一次打包 ZIP | `ui/ExportSettings.tsx`、`export/save.ts`、`export/social.ts`、`export/tiff.ts`、`image/watermark.ts`、`server/imageConvert.ts`、`server/heicConvert.ts` | `save.test.ts`、`save.tiffmetadata.test.ts`、`social.test.ts`、`save.metadata.test.ts`、`prefs.test.ts`、`colorProfile.test.ts`、`watermark.test.ts`、`WatermarkControls.test.tsx`、`BatchPanel.test.tsx`、`tiff.test.ts`（压缩 / 回退 / WebGL / 元数据 / 权利标签）、Pillow 独立解码、`check:safari`（WebKit 77/77：Compression=8、社交 ZIP、TIFF/PNG 作者版权字节回读）、AVIF 实测、HEIC 转换器 / 能力探针测试 |
| sRGB / Display P3 ICC 色彩交付（JPG / PNG / WebP / TIFF；P3 会真实转换像素后嵌配置；复制 PNG 同样写 sRGB） | `export/colorProfile.ts`、`export/p3.ts`、`export/save.ts`、`export/tiff.ts`、`ui/ExportSettings.tsx` | `colorProfile.test.ts`、`p3.test.ts`、`save.p3.test.ts`、`prefs.test.ts`、`ExportSettings.test.tsx`、`check:color`（Pillow / LittleCMS 独立解析 sRGB + P3）、`check:safari`（WebKit 真实下载 P3 PNG 61/61） |
| 摄影信息读取（JPG EXIF / PNG eXIf / WebP EXIF / TIFF-DNG IFD；相机、镜头、曝光、焦距、白平衡、作者、版权、GPS 坐标；照片信息与自动镜头校正共用缓存） | `core/photoInfo.ts`、`image/tiffMetadata.ts` | `photoInfo.test.ts`、`tiffMetadata.test.ts`、`lensProfile.test.ts`、`process.test.ts` |
| 源色彩识别（JPEG APP2 / PNG iCCP / WebP ICCP / TIFF-DNG ICC / HEIF nclx；sRGB、P3、Adobe RGB、ProPhoto、BT.2020） | `image/sourceProfile.ts`、`image/decode.ts`、`core/photoInfo.ts` | `sourceProfile.test.ts`、`photoInfo.test.ts`、`App.test.tsx`、`check:source-profile`（WebKit / 390px） |
| HEIC / RAW / TIFF 上传兜底（26 种 RAW 后缀前后端共用；普通文件夹导入对同目录同 stem 的 RAW + JPG / HEIC 只保留 RAW；二进制上传避免 base64 膨胀，上限 128MB；RAW 先查本机转换能力，无转换器时不上传原文件、直接读内嵌预览；按格式自动选择 sips / ImageMagick / RawTherapee / darktable / LibRaw；失败依次回退、LibRaw 自动 TIFF→JPEG、结果校验 JPEG 签名） | `shared/imageFormats.ts`、`core/rawPair.ts`、`image/decode.ts`、`image/rawPreview.ts`、`image/tiffMetadata.ts`、`server/http.ts`、`server/importConvert.ts`、`server/imageConverter.ts` | `rawPair.test.ts`、`Uploader.test.tsx`、`BatchPanel.test.tsx`、`http.test.ts`、`decode.test.ts`、`importConvert.test.ts`、`cameraBridge.test.ts`、`FocusStackPanel.test.tsx`、`PhotoMoviePanel.test.tsx`、`imageConverter.test.ts`、`rawPreview.test.ts`、`tiffMetadata.test.ts`、`decode.fallback.test.ts`、`check:raw-preview`（WebKit 6/6，预检上传 0 次）、`check:import`（无转换器安全回退 4/4） |
| 拖放 / 粘贴导入（编辑中单张替换当前照片；一次多张全部进入批量处理；非照片文件跳过；Chromium 桌面与 WebKit 390px 均验证） | `app/usePhotoDrop.ts`、`App.tsx` | `App.test.tsx`、`scripts/check-photo-drop.py`（Chromium + WebKit：两张照片预填、2 / 20、无溢出、无控制台错误） |
| 批量处理（调色 / 人像 / 取景 / EXIF 镜头校正 / 原文件名、前缀序号或 EXIF 拍摄日期命名 / 画幅、方向、自动校正与命名本机记忆 / sRGB 或 Display P3 / TIFF / 存作品 / ZIP 下载或系统分享；可用时含 HEIC，非 JPG/PNG 另存 sRGB JPEG 作品母版；RAW 内嵌预览单独计数） | `ui/BatchPanel.tsx`、`batch/process.ts`、`batch/prefs.ts`、`core/photoInfo.ts`、`export/save.ts`、`export/tiff.ts`、`export/p3.ts` | 批量测试（含偏好恢复 / 重置、日期命名、EXIF 缺失回退、P3 选项传递、ZIP 分享 / 取消 / 失败回退）、`ExportSettings.test.tsx` 与 `save.test.ts`（真实 MIME + 文件名探测、取消不算失败）、`check:safari`（WebKit 真实批量 TIFF ZIP + 文件头）、HEIC 能力探针、iPhone 实测 |
| 证件照 / 打印排版（JPG / PDF） | `IdPhotoPanel`、`PrintPanel`、`print/` | 面板测试 |
| 九宫格 / 长图 / 拼图 / 社交封面 | `GridSplitPanel`、`LongImagePanel`、`CollagePanel`、`PosterPanel` | 面板测试 |
| 照片动图（GIF + MP4） | `gif/`、`server/motion.ts` | 面板测试、浏览器实测 |
| 照片电影（推拉镜头 / 淡入淡出 / 配乐 / 排序） | `ui/PhotoMoviePanel.tsx`、`movie/` | 15 条测试、Chromium 实测 |
| 短片调色（多段拼接 / 画幅 / 字幕 / 人像美颜 / 背景音乐 / 静音 / 截帧 / 原声 MP4） | `ui/VideoPanel.tsx`、`video/`、`server/video.ts` | 44 条测试、Chromium 实测 |
| 预设 / LUT / XMP 互操作 / 调色剪贴板 / 默认风格（XMP 支持增量色温 / 色调与满强度黑白混色；单张与批量照片可自动读取同目录同名 XMP，批量时逐张优先使用自己的配方；批量 ZIP 可附每张成片同名 XMP 旁车） | `core/presets`、`core/presetFile`、`LutSettings`、`adjustmentClipboard`、`ui/Uploader.tsx`、`App.tsx`、`batch/process.ts` | 各自测试；`presetFile.test.ts`（自定义命名空间无损、第三方基础项 / 色调 / 黑白映射）、`Uploader.test.tsx`（单张 / 多张旁车配对）、`App.test.tsx`（XMP 优先于默认风格且批量逐张配对）、`process.test.ts`（单张 / 批量 XMP 参数、错误回退与 ZIP 内容）、`BatchPanel.test.tsx`；`check:safari`（XMP 下载 + 390px）、`scripts/check-xmp-sidecar-import.py`（WebKit 390px：单张亮度落到 30；两张照片各自 XMP 批量处理成功；无溢出、无控制台错误）、`scripts/check-batch-xmp.py`（WebKit 390px 真实批量导出并解包：2 JPG + 2 同名 XMP、字段回读、无溢出、无控制台错误） |
| 账本撤销重做 / 历史跳转 | `core/ledger.ts`、`StepNav` | `ledger.test.ts` |
| 选片（全屏 / 左右对比 / 多选两张直达对比 / 星级 / 保留排除 / 红黄绿蓝紫颜色标签 / 机身与镜头筛选 / 本地智能复查 / 缩略图感知哈希找相似 / 从选中挑最好 / 相册 / 名字或器材搜索 / 按拍摄时间或最近编辑分组 / 按 EXIF 拍摄时间识别连拍 / 连拍堆栈收起与展开 / 整组多选 / 整组一键挑最好） | `CullingLightbox`、`GalleryPage`、`core/gallery.ts`、`core/perceptualHash.ts`、`image/perceptualHash.ts`、`core/cull.ts`、`image/cull.ts`、`server/works.ts`、`server/db.ts` | `perceptualHash.test.ts`、`cull.test.ts`、`gallery.test.ts`、`shared/works.test.ts`、`CullingLightbox.test.tsx`、作品页选片 / 连拍 / 器材筛选 / 智能复查测试、作品接口 / 数据库迁移测试、`check:layout` 多选操作条、`check:bursts`（WebKit 桌面 + 390px 21/21，含器材元数据、筛选、拍摄时间分组、搜索、智能复查、对比和整组挑最好） |
| 作品来源元数据（原文件名 + EXIF 秒级拍摄时间 + 机身 + 镜头；主保存、批量成片保存、旧作品空值回退；详情展示、搜索和器材筛选） | `shared/works.ts`、`server/db.ts`、`server/works.ts`、`core/photoInfo.ts`、`app/useDelivery.ts`、`batch/process.ts`、`WorkDetailPage.tsx`、`GalleryPage.tsx` | `photoInfo.test.ts`、`works.test.ts`、`db.test.ts`、`App.gallery.test.tsx`、`WorkDetailPage.test.tsx`、`BatchPanel.test.tsx`、`process.test.ts`、`check:bursts` |

## 五、账号、分享、苹果端

| 能力 | 落点 | 验证 |
| --- | --- | --- |
| 注册登录 / 改密 / 作品 / 会话 / 相册 | `server/account.ts` 等 | 服务端测试 |
| 公开分享链接 | `server/works.ts`、`SharedWorkPage` | 分享测试 |
| PWA / 加到主屏 / 安全区 / 首包预算（React、Base UI、图标、EXIF 拆成稳定缓存块；作品页批量 / 视频 / 拼图 / 打印等工作流、实时相机和相机桥按需加载）；在线 / 离线状态变化时明确说明本地能力仍可用、联网能力暂停与恢复，断网时 AI 对话 / 推荐 / 生成 / 重试入口禁用 | `public/manifest`、`styles.css`、`vite.config.ts`、`GalleryPage.tsx`、`Uploader.tsx`、`ui/ChatPanel.tsx`、`app/useNetworkStatus.ts`、`scripts/check-bundle.mjs` | `useNetworkStatus.test.tsx`、`check:safari`、`check:bundle`（主包 ≤ 1 MB，vendor、重工作流与相机动态块存在）、`check:touch`（WebKit iPhone + iPad 实际断网 / 恢复事件与 AI 发送禁用 / 恢复） |
| iPhone / iPad 手势、照片专注看图、Apple Pencil 压感、粗指针设备 44px 触控命中区 | `ui/viewport.ts`、`RetouchOverlay`、`ui/Canvas.tsx`、`styles.css` | `Canvas.zoom.test.tsx`（专注层、Esc 退出、工具中不开放）、`scripts/check-photo-focus.py`（WebKit 桌面 + iPhone 390px：照片面积放大、44px 四向命中、无溢出、无控制台错误）、`check:safari` / `check:tablet` / `check:touch`（WebKit iPhone + iPad：可见控件四向命中探针、照片最小尺寸、无溢出与无控制台错误） |
| 手机调色面板收起（短视口默认先给照片；展开参数后仍可收起；高视口手机 / 桌面默认展开；桌面不显示移动端按钮） | `ui/AdjustmentPanel.tsx`、`styles.css` | `AdjustmentPanel.behavior.test.tsx`（390×664 初始收起、展开、再收起）、WebKit 实测（390×664：画布 139×264，收起面板 53px、44×44 按钮、无溢出；390×844：展开 84×159 → 收起 267×506；桌面按钮隐藏、参数常开） |
| 实况照片配对与兼容包（同名照片 + MOV；读取 MOV Content Identifier 与静帧 Apple 文本 / 16 字节 MakerNote 标识，显示已核对 / 不一致 / 仅同名；支持一次多组、逐组进入静帧修图或短片调色、全部静帧批量处理；ID 一致时可把当前 JPG 成片与原 MOV 按同 stem 导出 ZIP，设备支持文件分享时可直接交给系统面板；同名歧义不猜，不冒充原生 Live Photo） | `core/livePhoto.ts`、`ui/Uploader.tsx`、`app/useDelivery.ts`、`ui/ExportSettings.tsx`、`export/livePhotoBundle.ts`、`export/save.ts` | `livePhoto.test.ts`（文本 / 二进制 ID 对账）、`Uploader.test.tsx`（完整配对交给上层）、`ExportSettings.test.tsx`（核对中禁用 / 一致后开放 / 下载与分享模式）、`save.test.ts`（ZIP MIME 探测、取消不算失败）、`livePhotoBundle.test.ts`（JPG + MOV 同 stem / 拒绝非 JPG）、`check:live-photo`（WebKit 390px 14/14：三种 ID 状态、未核对禁用、真实下载 ZIP 内 JPG + MOV + 原动作 ID、无溢出与控制台错误）；桌面 WebKit 检查兼容包区块与导出弹层无溢出 |
| WebKit 390 / iPad 多尺寸探针 | `scripts/check-safari.mjs`、`check-tablet-layout.mjs` | 66/66、60/60 |

## 六、相机

| 能力 | 落点 | 验证 |
| --- | --- | --- |
| 浏览器实时取景 / 连拍 / **录像（含麦克风）** / 滑杆与双指捏合变焦 / 点按兴趣点对焦 / 曝光 / 手动对焦 / 即时、3、5、10 秒可取消倒计时 / 原始、1:1、4:5、3:4、16:9、9:16 拍摄画幅（支持 `canvas.captureStream` 时录像也套用画幅与镜像，否则明确回退原始构图） | `ui/CameraCapture.tsx` | `CameraCapture` 测试（倒计时与取消、双指变焦、点按对焦、画幅数学、取景框、预览帧与本机录像画布裁切、镜像、回退提示、记忆选择）、虚拟摄像头实测 |
| tether 文件夹桥（LAN + 令牌 + 三层日期 / 场次目录 + 扫描预算 + 相对文件夹显示 + RAW/JPEG 配对 + 同名 XMP 旁车配对 / 单张 / 批量 / 自动导入携带 + 面板显示 RAW / HEIC 转换能力 + 掉线状态自动刷新） | `server/cameraBridge.ts`、`CameraBridge`、`Uploader`、`AdjustEmpty` | 桥测试（含深层目录 / 同名文件 / XMP 配对与下载）、`CameraBridge.test.tsx`（单张和多张旁车交给上层）、`check:camera-live`（WebKit 9/9）、`scripts/check-camera-xmp.py`（WebKit 390px：真实桥目录 2 JPG + 2 XMP，显示 XMP 标记、导入全部后批量匹配 2 份）、iPhone 实测 |
| gphoto2 遥控（取景 / 100% 对焦放大镜 / 全屏取景 / 网格 / 对焦峰值 / 斑马纹 / 伪色曝光 / RGB 直方图 / 快门 / 间隔拍摄 / 包围曝光 / 焦点包围 / ISO / 光圈 / 白平衡… / 参数快照） | `server/gphoto2.ts`、`core/cameraPresets.ts`、`core/cameraBrackets.ts`、`ui/CameraBridge.tsx`、`ui/CameraLiveView.tsx`、`image/liveOverlay.ts` | gphoto2 测试、`cameraBrackets.test.ts`（曝光 + 焦点序列）、`liveOverlay.test.ts`（含竖幅 100% 裁剪上限）、`CameraBridge.test.tsx`（全屏 / 100% 放大镜 / 间隔两拍 / 取消 / 包围恢复曝光 / 焦点包围并恢复 / 整组交给 HDR 或焦点堆栈）、`GalleryPage.hdr.test.tsx`、`GalleryPage.focus.test.tsx`、`check:camera-live`（WebKit 390px 12/12）、`check:focus-bracket`（WebKit 390px 5/5） |
| 多相机连接配置与跨设备备份（按机身 / 机位命名，最多 8 组；本机保存类型、地址、端口；一键切换 PTP/IP / Canon CCAPI / Sony；单独删除；JSON 导入 / 导出；不复制访问令牌，导入后不自动连接） | `app/cameraConnections.ts`、`ui/CameraBridge.tsx` | `cameraConnections.test.ts`（默认名称 / 去重 / 上限 / 坏记录过滤 / 名称与端口校验 / JSON 白名单与坏文件校验）、`check:remote-camera-ui`（WebKit 390px + 桌面：保存 Canon、持久化但不含 token、导出 2 组、导入备用 PTP、点 Canon 配置切回并提交标准化地址、删除 Sony 不影响其它配置、无溢出与控制台错误） |
| 只读相机诊断（桥、机身连接、实时取景、拍摄与参数控制、照片列表 / 存储卡导入、本机 RAW / HEIC 转换器；不按快门、不改参数） | `ui/CameraBridge.tsx` | `check:remote-camera-ui`（WebKit 390px + 桌面 19/19：逐项捕获 Canon 型号、取景 / 控制 / 导入能力、无转换器提示，确认检测阶段 0 次快门请求、无溢出与控制台错误） |
| 无线 PTP/IP（启动参数或在网页里输入相机 IP / 端口；桥重启自动恢复） | `server/gphoto2.ts`、`server/cameraBridge.ts`、`server/cameraRuntimeConfig.ts`、`scripts/camera-bridge.ts`、`ui/CameraBridge.tsx` | 参数构造、运行时配置、持久化 / CLI 生命周期和界面测试；真实机型待验证 |
| Canon CCAPI 无线遥控（机型 / 电量 / 实时取景 / 快门 / 常用曝光参数读写 / 拍摄后从相机取回新照片 / 从存储卡导入最近照片且避免重复 / 网页选择连接方式与地址、热切换、重启恢复） | `server/canonCcapi.ts`、`server/canonCcapiUrl.ts`、`server/cameraProvider.ts`、`server/cameraRuntimeConfig.ts`、`ui/CameraBridge.tsx`、`scripts/camera-bridge.ts` | `canonCcapi.test.ts`（本地假相机：状态、schema、参数写回、JPEG 取景、快门后下载、重复导入）、provider 契约、运行时配置持久化、`CameraBridge.test.tsx`（网页切到 Canon / Sony、标准化地址、存储卡导入）、`check:remote-camera-ui`（WebKit 390px / 桌面）；真实 Canon 机型待验证 |
| Sony Camera Remote 无线遥控（远程模式 / 二进制实时取景 / 快门与照片下载 / `Contents Transfer` 最近照片导入与去重 / 可选曝光参数 / 网页热切换与重启恢复） | `server/sonyCamera.ts`、`server/sonyCameraUrl.ts`、`server/cameraProvider.ts`、`server/cameraRuntimeConfig.ts`、`ui/CameraBridge.tsx`、`scripts/camera-bridge.ts` | `sonyCamera.test.ts`（本地假相机：远程模式、参数读写、实时取景帧解析、快门下载、日期视图存储卡导入与模式恢复、断线提示）、provider 分派、运行时配置持久化、`CameraBridge.test.tsx`、`check:remote-camera-ui`；真实 Sony 机型待验证 |
| 厂商 SDK 适配器加载点（状态 / 能力 / 参数 / 实时帧 / 文件名契约与超时保护；无拍摄体检探针） | `server/cameraProvider.ts`、`server/cameraProviderAudit.ts`、`scripts/camera-bridge.ts` + 设计文档 | 适配器加载、畸形返回值、安全文件名、卡死超时和体检流程测试 |

## 七、仍未完成（明确缺口）

| 缺口 | 原因 | 下一步 |
| --- | --- | --- |
| Canon / Sony / Nikon 私有 SDK 实机遥控 | 已增加 Canon CCAPI 与 Sony Camera Remote 公开接口；EDSDK、Sony 私有 SDK 等与更多机身能力仍需原生二进制和真实相机 | 按 `CameraControlProvider` 写原生适配器，并用真实机型验证公开 API / 私有 SDK 行为 |
| 非 gphoto2 支持机型的私有无线协议 | 厂商私有协议 / 硬件 | 按 `CameraControlProvider` 写适配器 |
| 完整广色域编辑 | 已能识别源 sRGB / P3 / Adobe RGB / ProPhoto / BT.2020；也能从 sRGB 工作色域正确转换并交付 Display P3，但编辑链仍在 sRGB，无法恢复源文件中超出 sRGB 的颜色。2026-10-22 双浏览器像素探针确认：Chromium 具备 `drawingBufferColorSpace` / `unpackColorSpace`；WebKit 两者都没有，且 Canvas2D 虽接受 `display-p3` 参数，sRGB 纯红读回仍是 `[255,0,0]`，实际按 sRGB 处理 | 设计 2D / WebGL 都能成立的 P3 感知编辑管线；P3 文件不能只换标签，也不能把 WebKit 的静默 sRGB 当广色域 |
| 完整 RAW 解档 / 去马赛克 | 已接入成熟本机转换器：RawTherapee / darktable 直接输出 JPEG，LibRaw 输出 TIFF 后接 sips / ImageMagick；没有转换器时仍只用内嵌 JPEG 预览，不冒充完整解档 | 在装有 RawTherapee、darktable 或 LibRaw 的真实 Mac 上用厂商 RAW 做硬件验收，确认产物尺寸、色彩和高光恢复 |
| Apple 原生 Live Photo 重打包导出 | Web 没有标准容器写回能力 | 只能分别导出静帧或动作短片；不伪装成原生 Live Photo |

> HEIC 导出已接上“本机有编码器才显示”的可选路径：macOS 优先 `sips`，
> 其他系统使用支持 HEIC 的 ImageMagick。当前 Windows 开发机两者都没有，
> 因此已验证的是能力隐藏、转换参数和错误路径；真实 HEIC 字节仍需在 Mac
> 或安装了 HEIC delegate 的机器上用 `npm run check:heic` 补一次实机验收。

> 这张表不等于"市面上的功能全都有"：上表能证明的是**这些能力已经能点、能出结果**；
> 第七节里的每一项都还没有完成。

## 八、微信小程序

| 能力 | 落点 | 验证 |
| --- | --- | --- |
| 快速修图与 AI（拍照 / 相册、13 风格、一句话 AI、停止、重试、保存相册与本地作品） | `mini/pages/index`、`mini/lib/auth.ts`、`mini/lib/works.ts` | 原模拟器冒烟：风格 43/43、说一句 56/56、作品 41/41；本轮静态检查通过 |
| 常用手动修图（调色 6 参数、人像 3 参数、风格强度、对比、草稿恢复） | `mini/lib/editor.ts`、`mini/lib/draft.ts`、`mini/pages/index` | `node --test mini/tests/*.test.mjs`（19/19）、`npx vitest run --config mini/vitest.config.ts`（1/1）、`npx tsc -p mini --noEmit` |
| 裁剪、作品再次精修、默认风格和服务状态 | `mini/lib/image/crop.ts`、`mini/lib/editBridge.ts`、`mini/lib/prefs.ts`、`mini/lib/status.ts`、`mini/pages/works`、`mini/pages/me` | 裁剪几何 / 草稿 / tab 交接 / 默认风格 / 模型文案纯测试通过；真实微信模拟器和真机交互待正式 AppID 登录后验证 |
