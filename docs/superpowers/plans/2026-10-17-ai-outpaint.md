# AI 扩图实现计划 — 2026-10-17

1. `src/export/outpaint.ts`：目标比例尺寸、镜像引导底图、提示词和回复文案。
2. `src/ui/OutpaintControls.tsx`：比例选择、尺寸说明、生成 / 返回 / 取消。
3. `src/ui/CropControls.tsx`：裁剪第二行增加「AI 扩图」入口。
4. `src/App.tsx`、`src/ui/ToolBar.tsx`：接入 `outpaint` 子模式并复用生成链路。
5. 测试：纯函数、控件、App 生成接线。
6. README、文案规范、真浏览器桌面 / 390px 验收。
