# 局部眼影实现计划 —— 2026-10-18

1. `src/image/localAdjust.ts`：`eyeshadow` 效果、六色色板、按亮度混色。
2. `src/image/localAdjust.test.ts`：换色、边界、强度 0。
3. `src/ui/LocalControls.tsx`：第二行「眼影」和色板。
4. `src/app/useLocal.ts` / `src/App.tsx`：色号状态与提交参数。
5. `src/App.tools.test.tsx`：涂眼影 → 选玫瑰粉 → 应用。
6. `README.md` / `docs/文案规范.md`：能力与词条。
7. 类型检查、单测、Chromium + WebKit 眼影像素探针、布局 / 文案 / Safari 回归。
