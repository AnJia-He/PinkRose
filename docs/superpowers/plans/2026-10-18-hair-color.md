# 局部发色实现计划 —— 2026-10-18

1. `src/image/localAdjust.ts`：`hair` 效果、六个发色、按原亮度缩放的换色函数。
2. `src/image/localAdjust.test.ts`：换色、边界、亮度、强度 0。
3. `src/ui/LocalControls.tsx`：第二行「发色」、色板、强度和选中态。
4. `src/app/useLocal.ts` / `src/App.tsx`：发色状态、默认色号、提交参数。
5. `src/test/appHarness.tsx`：局部模块改成 partial mock，保留色板常量。
6. `src/App.tools.test.tsx`：涂发色 → 选酒红 → 应用。
7. `README.md` / `docs/文案规范.md`：能力与词条。
8. 类型检查、单测、Chromium + WebKit 像素探针、布局 / 文案 / Safari 回归。
