# Apple 输入兼容与文字旋转 —— 2026-10-18

## 目标

补齐两个主流修图缺口：让 iPhone 用户更容易选中 HEIC / HEIF，并在浏览器
原生位图解码失败时多试一条 `<img>` 解码路；文字工具支持整块旋转。

## HEIC / HEIF

- 所有照片选择器显式接受 `.heic` / `.heif`。
- `decodeImageFile` 先走 `createImageBitmap`；失败后用对象 URL + `<img>.decode()`
  再画进 sRGB 画布。
- 两条路都失败时，HEIC 给出“先用「照片」导出成 JPG”的可执行提示；
  其它格式保留通用提示。
- 不承诺所有浏览器都能直接解 HEIC：这取决于系统编解码器。Windows 上的
  Chromium 与 Playwright WebKit 实测无法解码公开 HEIC 样本；真实
  macOS / iOS Safari 仍需设备复核。

## 文字旋转

- `TextOptions.rotation` 范围 -180°~180°，默认 0。
- 预览用 CSS `rotate()`，成片用 canvas 绕文字块中心 `rotate()`；两边同一个值。
- 旋转不改变文字中心、内容、模板、描边、阴影和底色。

## 验收

- 单测：旋转夹取、预览 transform、canvas `rotate(π/6)`、HEIC 识别与提示。
- App：旋转滑杆同时进入预览和 `textToBitmap`。
- Chromium + WebKit：文字工具能调旋转并应用；HEIC 真实文件失败时出现
  “HEIC / JPG”提示；390px 无横向溢出、无控制台错误。
