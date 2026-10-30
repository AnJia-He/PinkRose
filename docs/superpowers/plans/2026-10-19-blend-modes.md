# 贴纸 / 形状合成模式实现计划 —— 2026-10-19

1. `src/image/blend.ts`：共用模式名、中文标签、Canvas 映射。
2. `sticker.ts`：不透明度 / 混合 / 填充 / 翻转；cover 裁切。
3. `shape.ts`：不透明度 / 混合沿用同一份映射。
4. `StickerControls` / `ShapeControls`：模式与不透明度控件。
5. `StickerOverlay` / `ShapeOverlay`：CSS 预览与落图一致。
6. 单元测试、App 接线测试、WebKit 真浏览器验收。
