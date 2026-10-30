# 纵向全景实现计划 —— 2026-10-18

1. `src/image/panorama.ts`：`axis` 选项、纵向灰度采样、纵向 NCC、纵向排版、纵向接缝渐变。
2. `src/image/panorama.test.ts`：纵向 50px 重叠、纵向排版。
3. `src/ui/PanoramaPanel.tsx`：方向选择、短边文案、预览依赖。
4. `src/ui/PanoramaPanel.test.tsx`：选纵向后把 `axis: 'vertical'` 交给引擎。
5. `README.md` / `docs/文案规范.md` / 全景 spec：方向与短边口径。
6. 类型检查、单测、Chromium + WebKit 纵向拼接像素探针、布局 / 文案 / Safari 回归。
