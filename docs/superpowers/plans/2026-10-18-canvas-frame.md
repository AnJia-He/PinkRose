# 单图画布扩展实现计划 —— 2026-10-18

1. `src/image/canvasFrame.ts`：比例 / 边距布局、纯色 / 模糊 / 透明绘制。
2. `src/image/canvasFrame.test.ts` + `canvasFrame.render.test.ts`。
3. `src/ui/CanvasFrameOverlay.tsx`：从当前 WebGL 画布生成准确预览。
4. `src/app/useCanvasFrame.ts` + `CanvasFrameControls.tsx`：现场与提交。
5. 接入「装饰」六个模式，更新 `ToolBar` / `Canvas` / `App`。
6. 修复 WebKit 底图尺寸变化后的合成层透明问题。
7. App 测试、布局探针、Chromium + WebKit 像素探针、README / 文案规范。
