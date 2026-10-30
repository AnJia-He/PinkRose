# 镜头校正实现计划 —— 2026-10-17

1. `shared/adjustments.ts`：追加 `lensDistortion` / `lensChromatic`，
   新增「镜头校正」组，补 ZERO / clamp / toUnit。
2. `src/render/uniforms.ts` + `src/render/shader.ts`：新增 uniform、径向采样映射、
   自动缩放和红蓝色差校正。
3. `src/ui/AdjustmentPanel.tsx`：给新组配 `Ruler` 图标。
4. `server/prompt.ts`：让“把广角拉直 / 把边缘绿边去掉”走 params。
5. 同步 `mini/lib/shared/`，不改小程序页面。
6. 单测、类型检查、`check:lut`、真实浏览器桌面 / 手机验收、文案与 README。
