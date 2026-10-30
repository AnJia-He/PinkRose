# RGB 分通道曲线实现计划 — 2026-10-18

设计见 [2026-10-18-rgb-curves-design.md](../specs/2026-10-18-rgb-curves-design.md)。

## Task 1：参数层

- `shared/adjustments.ts`：追加 15 个 RGB 曲线键、`RGB_CURVE_CHANNELS`、
  标签 / 范围 / 分组 / `ZERO` / clamp / toUnit。
- `src/render/uniforms.ts`：15 个 uniform + `uCurveRgbOn`。

## Task 2：CPU 曲线与着色器

- `src/core/toneCurve.ts`：通道曲线点、取值、反解、总开关。
- `src/render/shader.ts`：`curve5()` + 三条通道曲线，放在整体曲线之后。

## Task 3：界面

- `src/ui/ToneCurve.tsx`：RGB / 红 / 绿 / 蓝通道胶囊、当前通道的点和读数、
  当前通道拉直 / 全部拉直。

## Task 4：测试与文档

- `core/toneCurve.test.ts`、`shared/adjustments.test.ts`、
  `render/uniforms.test.ts`、`render/shader.test.ts`、
  `AdjustmentPanel.behavior.test.tsx`。
- README / 文案规范。

## Task 5：验证

- 真机 RGB 曲线探针；全量测试、typecheck、build、check:layout、check:copy、
  check:lut、diff check。
