# 局部黑眼圈实现计划 —— 2026-10-18

1. `src/image/facePartMask.ts`：按正脸比例生成两块眼下软选区；自动选区扩展 `undereye`。
2. `src/image/localAdjust.ts`：新增 `darkcircle` 固定预设——局部肤色参考、暗沉提亮、蓝紫偏色回收。
3. `src/ui/LocalControls.tsx`：局部效果行加「黑眼圈」，自动选区行加「自动眼下」。
4. `src/app/useLocal.ts` / `src/App.tsx`：接自动选区与账本提交，全局参数不动。
5. 单测：眼下选区位置 / 软边；暗沉提亮、偏色回收、正常肤色与掩码外不动；App 自动选区提交。
6. Chromium + WebKit：390px 与 iPad 布局、控制台无错误；README / 文案规范同步。
