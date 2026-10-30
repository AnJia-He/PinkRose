# 双重曝光实现计划 — 2026-10-17

设计见 [2026-10-17-double-exposure-design.md](../specs/2026-10-17-double-exposure-design.md)。

## Task 1：像素与预览

- `src/image/doubleExposure.ts`：cover、混合映射、成片合成、预览。
- `src/image/doubleExposure.test.ts`：cover 与模式映射。

## Task 2：工具现场

- `src/app/useDoubleExposure.ts`：第二张图解码、预览、模式 / 不透明度、baseEdit。
- `src/ui/Canvas.tsx`：预览 `<img>` 与真实混合模式。

## Task 3：界面接线

- `src/ui/DoubleExposureControls.tsx`：选图 / 混合 / 不透明度 / 应用。
- `src/ui/FrameControls.tsx` / `StickerControls.tsx`：装饰里的「叠加」入口。
- `src/ui/ToolBar.tsx` / `src/App.tsx`：子模式保持「装饰」点亮。

## Task 4：验证

- App 接线测试、真浏览器像素、布局、文案、全量单测。
