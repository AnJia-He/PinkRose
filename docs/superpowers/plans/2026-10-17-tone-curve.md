# 影调曲线实现计划 — 2026-10-17

设计见 [2026-10-17-tone-curve-design.md](../specs/2026-10-17-tone-curve-design.md)。

## Task 1：CPU 曲线

- `src/core/toneCurve.ts`：`CURVE_POINTS`、`curvePoints`、`curveValueAt`、
  `paramForCurveY`、`curveActive`。
- `src/core/toneCurve.test.ts`：中立点、方向、单调、精确控制点、拖点反解。

## Task 2：参数与 uniform

- `shared/adjustments.ts`：5 个字段、`CURVE_KEYS`、`PARAM_KEYS` 追加、
  标签 / 范围 / 曲线组 / `ZERO` / clamp / toUnit。
- `src/render/uniforms.ts`：5 个曲线 uniform + `uCurveOn`。

## Task 3：着色器

- `src/render/shader.ts`：`curveAt()` 五段 smoothstep + 单调夹取；在 HSL 后、
  分离色调前应用亮度偏移。
- `src/render/shader.test.ts`：顺序和总开关。
- 验证：`npm run check:lut`。

## Task 4：界面

- `src/ui/ToneCurve.tsx`：SVG 拖点 + 键盘 + 读数 + 「拉直」。
- `src/ui/AdjustmentPanel.tsx`：曲线组特殊渲染 + `Spline` 图标。
- `src/styles.css`：曲线网格 / 参考线 / 控制点 / 读数行。
- 验证：`vitest run src/ui/AdjustmentPanel.behavior.test.tsx`。

## Task 5：文档与全量验证

- `docs/文案规范.md`：48 参数 / 八组 / 曲线行。
- `node scripts/sync-mini-shared.mjs`（只同步共享镜像）。
- `npm test`、`npm run typecheck`、`npm run check:layout`、
  `npm run check:copy`、`npm run check:lut`。
- 自建曲线真机像素探针。
