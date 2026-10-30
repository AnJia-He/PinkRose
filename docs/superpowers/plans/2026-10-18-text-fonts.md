# 文字字体实现计划 —— 2026-10-18

1. `src/image/text.ts`：`TextFontId`、四档字体栈、`textFontFamily`、选项归一化。
2. `src/ui/TextControls.tsx`：模板下面的「字体」四颗胶囊。
3. `src/ui/TextOverlay.tsx`：预览使用选中字体。
4. `src/image/text.test.ts` / `src/App.tools.test.tsx`：字体回退、模板字体、选宋体。
5. `README.md` / `docs/文案规范.md`：能力与词条。
6. 类型检查、单测、Chromium + WebKit 字体探针、布局 / 文案 / Safari 回归。
