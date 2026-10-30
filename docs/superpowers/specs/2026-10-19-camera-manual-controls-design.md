# 实时相机手动控制设计 —— 2026-10-19

## 目标

浏览器直连 USB / UVC / 采集卡相机时，除了变焦和补光，再补两个真实拍摄最常用的
控制：曝光补偿和手动对焦。相机不声明能力时不显示滑杆，避免给一个按了没反应的控件。

## 接口

沿用 `MediaStreamTrack.getCapabilities()` / `getSettings()` / `applyConstraints()`：

- `exposureCompensation`：`{ min, max, step }`；
- `focusDistance`：`{ min, max, step }`（单位米）。

只在范围有限且 `max > min` 时显示；当前值从 `getSettings()` 取并钳进范围。
应用失败（浏览器或设备不支持）时隐藏该滑杆，取景和快门照常可用。

## 边界

- 不伪造能力：设备不声明就不显示。
- 不改照片像素；只影响后续 `takePhoto()` / 预览帧。
- 与相机桥 / 厂商 SDK 的参数面板互不替代：桥适合单反，浏览器控制适合
  UVC / 采集卡 / 内置摄像头。

## 验收

- `CameraCapture.test.tsx`：能力存在时滑杆出现、初始值正确、拖动后
  `applyConstraints` 收到 `exposureCompensation` / `focusDistance`。
- WebKit 390px：弹层无横向溢出，不支持能力的设备不出现空控件。
