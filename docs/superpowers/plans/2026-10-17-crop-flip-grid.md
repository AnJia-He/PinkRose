# 裁剪翻转与构图网格实现计划 — 2026-10-17

设计见 [2026-10-17-crop-flip-grid-design.md](../specs/2026-10-17-crop-flip-grid-design.md)。

## Task 1：裁剪模型与像素

- `core/crop.ts`：`CropSpec.flipH/flipV`。
- `image/crop.ts`：rotate 之后 scale 翻转。
- `image/crop.test.ts`：翻转调用顺序。

## Task 2：现场与预览

- `app/useCrop.ts`：翻转 / 网格状态。
- `ui/Canvas.tsx`：预览 transform + CropScene.grid。
- `ui/CropOverlay.tsx`：三分网格线。
- `ui/CropControls.tsx`：三个新控件。

## Task 3：测试、文档与验证

- `App.tools.test.tsx`：翻转 / 网格接线。
- 真浏览器：预览 / 成片 / 网格。
- `npm test`、`typecheck`、`check:layout`、`check:copy`。
