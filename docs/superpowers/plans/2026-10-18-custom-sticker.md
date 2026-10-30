# 自定义图片贴纸实现计划 —— 2026-10-18

1. `src/image/sticker.ts`：`source: shape | image`、自定义位图按 contain 绘制。
2. `src/image/sticker.test.ts` / `sticker.custom.test.ts`：归一化与比例。
3. `src/app/useSticker.ts`：解码、预览、ImageBitmap 生命周期。
4. `src/ui/StickerControls.tsx`：图形 / 我的图 / 换图入口。
5. `src/ui/StickerOverlay.tsx`：自定义图片预览。
6. App 接线测试、Chromium + WebKit 像素探针、README / 文案规范。
