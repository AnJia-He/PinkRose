# 实时直方图实现计划 — 2026-10-18

设计见 [2026-10-18-histogram-design.md](../specs/2026-10-18-histogram-design.md)。

## Task 1：纯计算

- `src/render/histogram.ts`：64 柱 RGB、暗部 / 高光溢出。
- `src/render/histogram.test.ts`。

## Task 2：渲染管线

- `src/render/pipeline.ts`：128×128 FBO + `readHistogram()`。
- `src/ui/Canvas.tsx`：可选 `onHistogram`，渲染后读回。

## Task 3：界面

- `src/ui/Histogram.tsx` + CSS。
- `src/ui/AdjustmentPanel.tsx`：面板顶部。
- `src/App.tsx`：只调色屏开 `onHistogram`。

## Task 4：验证

- Chromium + WebKit 探针、全量测试、typecheck、build、layout、copy、safari。
