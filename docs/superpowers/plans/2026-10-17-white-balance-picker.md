# 白平衡吸管实现计划 — 2026-10-17

设计见 [2026-10-17-white-balance-picker-design.md](../specs/2026-10-17-white-balance-picker-design.md)。

## Task 1：取色与反解

- `src/image/sample.ts`：`samplePixelAt` 面积平均取色。
- `src/core/whiteBalance.ts`：中性色 → 色温 / 三根色彩平衡轴。
- `src/core/whiteBalance.test.ts`：回正、方向、拒绝坏样本。

## Task 2：画布取样态

- `src/ui/Canvas.tsx`：`sampling / onSamplePoint`，顶部提示、十字光标、与点选互斥。
- `src/App.tsx`：取样回调、写参数、失败提示、切屏清场。

## Task 3：面板入口

- `src/ui/AdjustmentPanel.tsx`：色彩组「白平衡吸管」按钮与选中态。
- `src/styles.css`：按钮与画布提示样式。

## Task 4：测试与验收

- `src/test/appHarness.tsx`：假掉 `samplePixelAt`，记录画布取样 props。
- `src/App.adjust.test.tsx`：成功取样 / 坏样本提示。
- 真浏览器：偏暖灰面回正。
- `npm test`、`npm run typecheck`、`npm run check:layout`、`npm run check:copy`。
