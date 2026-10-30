# Apple 输入兼容与文字旋转实现计划 —— 2026-10-18

1. `src/image/decode.ts`：HEIC / HEIF 识别、`<img>` 解码兜底、失败提示。
2. 所有照片选择器显式接受 `.heic` / `.heif`。
3. `src/image/text.ts`：`rotation` 选项、夹取和 canvas 旋转落图。
4. `src/ui/TextOverlay.tsx` / `TextControls.tsx`：预览旋转与滑杆。
5. 单测 + App 接线测试。
6. Chromium + WebKit 真实路径探针。
7. README / 文案规范 / 设计文档同步。
