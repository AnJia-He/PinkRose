# 一键自动实现计划 — 2026-10-17

设计见 [2026-10-17-auto-enhance-design.md](../specs/2026-10-17-auto-enhance-design.md)。

## Task 1：算法

- `src/core/autoEnhance.ts`：分位数、曝光 / 对比 / 高光 / 阴影 / 饱和 / 白平衡。
- `src/core/autoEnhance.test.ts`：暗 / 亮 / 低反差 / 偏色 / 黑白 / 空样本 / 范围。

## Task 2：界面与接线

- `src/ui/AdjustmentPanel.tsx`：面板头「自动」+ `onAuto` prop。
- `src/App.tsx`：采样底图、调算法、覆盖八项参数。
- `AdjustmentPanel.behavior.test.tsx` / `App.adjust.test.tsx`：按钮与 App 行为。

## Task 3：文档与全量验证

- README / 文案规范。
- `npm test`、`npm run typecheck`、`npm run check:layout`、`npm run check:copy`。
