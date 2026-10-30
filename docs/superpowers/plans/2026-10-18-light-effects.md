# 光效实现计划 —— 2026-10-18

1. `src/image/light.ts`：四种程序化光效、screen 混合、画布落地。
2. `src/ui/LightOverlay.tsx`：照片上的预览层。
3. `src/ui/LightControls.tsx`：预设 / 强度 / 取消 / 应用。
4. `src/app/useLight.ts` + `src/App.tsx` + `src/ui/Canvas.tsx`：现场、接线、账本。
5. 装饰四种已存在模式各加「光效」入口。
6. `src/image/light.test.ts` / `src/App.tools.test.tsx`：绘制契约与接线。
7. 类型检查、单测、Chromium + WebKit 光效探针、布局 / 文案 / Safari 回归。
