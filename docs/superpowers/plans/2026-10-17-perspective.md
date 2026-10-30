# 几何透视校正实现计划 — 2026-10-17

设计见 [2026-10-17-perspective-design.md](../specs/2026-10-17-perspective-design.md)。

## Task 1：参数与分组

- `shared/adjustments.ts`：`perspectiveV` / `perspectiveH`、几何组、范围。
- `shared/adjustments.test.ts`：52 个参数、组顺序、toUnit。
- `node scripts/sync-mini-shared.mjs`。

## Task 2：渲染

- `src/render/shader.ts`：投影采样 + 四角自动 zoom；暗角用 `vUv`。
- `src/render/uniforms.ts`：两个新 uniform。
- `src/render/shader.test.ts` / `uniforms.test.ts`：顺序与映射。

## Task 3：界面与模型

- `src/ui/AdjustmentPanel.tsx`：几何组图标。
- `src/ui/AdjustmentPanel.behavior.test.tsx`：组标题、26 根滑块、范围。
- `server/prompt.ts` / `prompt.test.ts`：透视走 params 及正负方向。

## Task 4：真机验证

- `npm run check:lut`：真 Chrome 编译。
- 梯形网格图：V=35 上下边等宽；回 0 逐像素回基线。

## Task 5：文档与全量验证

- 文案规范 / README 设计文档。
- `npm test`、`npm run typecheck`、`npm run check:layout`、`npm run check:copy`。

## Task 6：四角自由透视（追加）

- `src/core/perspective.ts` / `src/image/perspective.ts`：投影矩阵 + 像素反采样。
- `src/ui/PerspectiveOverlay.tsx`：四个可拖角点。
- `src/app/usePerspective.ts`：现场、重置、应用与账本。
- `src/ui/CropControls.tsx` / `src/App.tsx`：「裁剪 → 透视」子模式。
- `src/App.tools.test.tsx` / 真浏览器：梯形校正验收。
