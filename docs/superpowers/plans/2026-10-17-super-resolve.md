# 超清放大实现计划 — 2026-10-17

1. `src/image/upscale.ts`：2 倍目标尺寸、设备闸门、高品质重采样、unsharp mask。
2. `src/app/useUpscale.ts`：复用 baseEdit 骨架，接账本与落盘。
3. `src/ui/CropControls.tsx`：裁剪第二行加入口、禁用态和目标尺寸提示。
4. `src/App.tsx`：接线；成功后收裁剪工具。
5. 测试：像素纯函数 + App 工具接线。
6. README、文案规范、布局与真浏览器验收。
