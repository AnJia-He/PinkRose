# 局部调整画笔实现计划 — 2026-10-17

设计见 [2026-10-17-local-adjust-design.md](../specs/2026-10-17-local-adjust-design.md)。

## Task 1：像素引擎

- `src/image/localAdjust.ts`：`localAdjustPixels` / `localAdjustToBitmap`；
  调色 / 牙齿 / 亮眼 / 红眼四种局部效果。
- `src/core/gradientMask.ts`：线性 / 径向蒙版的纯算式。
- `src/image/localAdjust.test.ts`：掩码外不变、覆盖率、饱和度、色温、牙齿去黄、
  亮眼明暗分离、尺寸。

## Task 2：现场 hook

- `src/app/useLocal.ts`：掩码 ref + 涂抹 / 线性 / 径向现场 + 调色 / 牙齿 / 亮眼 +
  `open/close/cancel/commit`，提交走 `baseEdit`。
- 面积上限 / 慢任务暗罩同磨皮。

## Task 3：工具与界面

- `src/ui/ToolBar.tsx`：第五颗「局部」。
- `src/ui/LocalControls.tsx`：调色 / 牙齿 / 亮眼 / 红眼 + 涂抹 / 线性 / 径向 +
  画笔/橡皮 + 笔刷或羽化 + 当前模式滑杆 + 应用。
- `src/ui/GradientOverlay.tsx`：照片上的渐变方向/范围拖动预览。
- `src/App.tsx` / `src/ui/Canvas.tsx`：pickTool / 重置 / 切屏 / Canvas / busy /
  StepNav，以及画笔和渐变两种现场的分流。
- `src/styles.css`：窄屏五颗工具格收紧内边距。

## Task 4：测试与版面

- `src/test/appHarness.tsx`：假掉 `localAdjustToBitmap`。
- `src/App.tools.test.tsx`：应用 / 全零禁用 / 牙齿 / 亮眼 / 红眼 / 线性 / 径向 / 取消。
- `src/core/gradientMask.test.ts` / `src/ui/GradientOverlay.test.tsx`：渐变算式和拖动。
- `src/ui/ToolBar.test.tsx`：五颗格子。
- `scripts/check-mobile-layout.mjs`：新增「开着局部」态和工具行第一排宽度判据。

## Task 5：文档与全量验证

- `docs/文案规范.md` / README：局部入口和「应用局部」。
- `npm test`、`npm run typecheck`、`npm run check:layout`、`npm run check:copy`。
