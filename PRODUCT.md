# PinkRose 产品说明

> 这份文件面向项目内的后续开发会话。它是产品定位和边界的第一入口；
> 具体代码地图看 [README.md](README.md)，已实现能力和验证证据看
> [能力矩阵](docs/superpowers/specs/2026-10-20-capability-matrix.md)。

## 产品是什么

PinkRose 是一款面向普通用户和摄影工作流的 **Web / PWA / 桌面修图产品**。

- 桌面版复用同一套 React 前端、Node 服务和账号体系，由 Electron 提供原生窗口；
  用户可选择独立数据目录，程序只监听本机回环地址。
- 安装包不内置服务端 API 密钥。用户自己的模型密钥仍写进本机加密数据库，
  卸载程序不会删除用户选择的照片与作品目录。

- 用户可以通过一句话描述想怎么改，也可以通过专业参数、画笔、局部蒙版、
  预设和批量工作流手动修图。
- 照片编辑的核心计算尽量在本机完成；只有用户主动使用生成式能力时，
  才把对应预览发给云端模型。
- 产品以苹果用户为重要目标：iPhone / iPad / Mac Safari、主屏安装、
  安全区、触控、Apple Pencil、HEIC 和实况照片配对都需要持续维护。
- 后续要接入真实拍摄相机。当前已有浏览器相机、tether 文件夹桥、
  gphoto2 USB / 无线 PTP/IP、Canon CCAPI、Sony Camera Remote、厂商 SDK 适配器加载点，
  以及实时取景辅助。

## 核心用户

1. **普通手机用户**：想把旅游照、人像、日常照片快速修好并发出去。
2. **苹果设备用户**：用 iPhone / iPad 选片、修图、批量处理和分享。
3. **摄影爱好者 / 摄影师**：需要 RAW / HEIC、批量、镜头校正、选片、
   预设、tether 拍摄和无线相机控制。

## 产品原则

- **真实可用优先**：界面出现的按钮必须真的能做到它写的事；不能把
  “只支持半边”、模拟能力或未验证硬件写成已完成。
- **本地优先**：调色、人像、裁剪、合成和批量处理尽量不上传原片。
- **非破坏优先**：参数、图层、账本和版本历史能回退；换底图操作要留记录。
- **说人话**：错误必须说明“哪里不对 + 下一步怎么做”，不显示原始英文异常。
- **苹果端不是兼容补丁**：触控、安全区、HEIC、实况照片和 WebKit 都要有验证路径。
- **专业但不吓人**：高级能力可深，默认入口仍应让普通用户能直接开始。

## 架构入口

- `src/`：React 前端、编辑器、画布工具、导出和浏览器端图像处理。
- `server/`：账号、会话、作品、AI 网关、图片转换、视频和相机桥。
- `shared/`：前后端共用的参数、协议、会话和作品定义。
- `scripts/`：浏览器探针、相机桥和布局 / 兼容性验收。
- `data/`：用户账号、会话和作品存储，禁止删除或提交。
- `mini/`：小程序代码；当前 Web 产品任务明确要求先不改动它。

## 关键技术约束

- React 18 + Vite + TypeScript + 原生 CSS，不使用 Tailwind。
- 调色预览走 WebGL2；改 GLSL 后必须跑 `npm run check:lut`。
- 后端改动不会热重载，需要重启开发服务。
- 苹果兼容以 Playwright WebKit 为主，390px 是最低手机基线之一。
- 任何密钥、令牌、密码、cookie 和私钥都不能进入源码、日志、截图或对话。

## 验证入口

```powershell
npm run typecheck
npm run build
npm run check:bundle
npm test
```

专项探针按改动选择：

```powershell
npm run check:safari
npm run check:touch
npm run check:smooth
npm run check:perspective
npm run check:tilt-shift
npm run check:focus-bracket
npm run check:clipping
npm run check:connected-select
npm run check:luminance
npm run check:grading
npm run check:color-noise
npm run check:sharpen
npm run check:bursts
npm run check:portrait
npm run check:heic
npm run check:import
npm run check:live-photo
npm run check:camera-live
npm run check:remote-camera-ui
npm run check:lens
npm run check:lut-export
npm run check:color
npm run check:raw-preview
npm run check:source-profile
```

## 当前明确缺口

- Canon / Sony / Nikon 等厂商私有 SDK 的真实相机适配与硬件验证。
- 非 gphoto2 支持机型的私有无线协议。
- 广色域编辑；已识别并提示 P3 / Adobe RGB / ProPhoto 等源色域，也能从 sRGB 工作色域正确转换并交付 Display P3，但编辑链仍统一在 sRGB。
- 完整 RAW 解档 / 去马赛克已能交给本机 RawTherapee / darktable / LibRaw；没有这些转换器时退到相机内嵌 JPEG 预览。仍需在装有真实转换器和相机的 Mac 上做最终验收。
- Apple 原生 Live Photo 重打包导出；已能识别配对，并导出当前 JPG 成片 + 原 MOV 的兼容 ZIP，但仍不是原生 `.pvt` 容器。
- 真实相机 PTP/IP、USB 控制仍需在支持的硬件上验收。

这些缺口不能被“界面已显示”或“假执行器测试通过”替代为已完成。

## 当前发布节奏

核心 Web 修图、批量、苹果分享和兼容包已经进入验收阶段，不再按“市场功能清单”
无限追加入口。真实 iPhone / iPad 的发布验收、真实相机、RAW 和广色域验证按
[苹果端验收清单](docs/苹果端验收清单.md) 执行；每轮只修阻断项或记录明确边界。
