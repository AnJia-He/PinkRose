# 肤色美颜实现计划 — 2026-10-17

设计见 [2026-10-17-skin-beauty-design.md](../specs/2026-10-17-skin-beauty-design.md)。

## Task 1：参数层

- `shared/adjustments.ts`：`skinBrighten` / `skinRosy`、`SKIN_KEYS`、
  `PARAM_KEYS` 追加、标签 / 范围 / 美颜组 / ZERO / clamp / toUnit。
- `src/render/uniforms.ts`：两个 uniform；总数 52。

## Task 2：着色器

- 把肤色蒙版提成共享 `skin`；
- 曲线之后、分离色调之前加美白 / 红润。
- 验证：`npm run check:lut`。

## Task 3：提示词与预设

- `server/prompt.ts`：14 个键 + 美颜规则 + JSON 模板/示例。
- `src/core/presets.ts`：柔光人像补美白 15 / 红润 8。

## Task 4：界面与文档

- `src/ui/AdjustmentPanel.tsx`：美颜组笑脸图标。
- `docs/文案规范.md`：50 参数 / 九组 / 美白 / 红润。

## Task 5：全量验证

- `npm test`、`npm run typecheck`、`npm run check:layout`、
  `npm run check:copy`、`npm run check:lut`。
- 自建肤色真机像素探针。
