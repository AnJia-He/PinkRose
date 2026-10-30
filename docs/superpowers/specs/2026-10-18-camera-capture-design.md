# 相机拍照入口设计 —— 2026-10-18

## 目标

上传前那一屏除了相册选图，再提供直接拍照入口。iPhone / Android 点击后
调用后置摄像头；桌面浏览器不支持 `capture` 时自然退化成文件选择。

## 行为

- 输入框右侧新增一个 34px 的相机图标键，`aria-label="拍照"`。
- 隐藏的 file input 使用 `capture="environment"`，接受 `image/*` 和 HEIC / HEIF。
- 已经输入的「想怎么改」文字会跟着拍到的照片一起交给上层。
- 原来的「选照片 / 发送」主按钮仍是主路径；相机是同一件事的第二条路。

## 验收

- `Uploader.test.tsx`：相机 input 带 `capture="environment"`，按钮能点它，
  change 后 `onPick` 收到照片和已输入的文字。
- Chromium + WebKit：按钮在 390px 内可见，点击能打开文件选择并完成上传，
  无横向溢出、无控制台错误。
