# 细节与质感实现计划 — 2026-10-17

设计见 [2026-10-17-detail-effects-design.md](../specs/2026-10-17-detail-effects-design.md)。

## Task 1：参数层

- `shared/adjustments.ts`：追加 `sharpen` / `noiseReduction` / `grain`，
  更新 `PARAM_KEYS`、`PARAM_LABELS`、`PARAM_RANGE`、`PARAM_GROUPS`（细节组）、
  `ZERO`、`clampAdjustments`、`toUnit`。
- `src/render/uniforms.ts`：追加 `uSharpen` / `uNoiseReduction` / `uGrain`。
- 验证：`vitest run shared/adjustments.test.ts src/render/uniforms.test.ts`。

## Task 2：着色器

- `src/render/shader.ts`：在磨皮之后、色温之前加 8 邻域保边降噪和
  4 邻域 unsharp 锐化；在暗角之后、LUT 之前加确定性颗粒。
- `src/render/shader.test.ts`：顺序、恒等、颗粒位置哨兵。
- 验证：`npm run check:lut`（真 Chrome + 真 GPU）。

## Task 3：对话与预设

- `server/prompt.ts`：提示词参数扩到 12 个，加细节组规则和 JSON 模板键。
- `server/prompt.test.ts`：标签一一对应、细节组走 params。
- `src/core/presets.ts`：新增「街拍质感」预设。

## Task 4：界面与文案

- 面板由 `PARAM_GROUPS` 自动生成「细节」组；`AdjustmentPanel` 补组图标。
- `docs/文案规范.md`：参数总数 19、六组、锐化/降噪/颗粒三行。
- 更新测试里的 16 → 19、五组 → 六组。

## Task 5：全量验证

- `node scripts/sync-mini-shared.mjs`（只同步共享镜像，不做小程序界面）。
- `npm test`、`npm run typecheck`、`npm run check:layout`、`npm run check:copy`、
  `npm run check:lut`。
