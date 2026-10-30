# 智能主体与背景替换实现计划 — 2026-10-17

设计见 [2026-10-17-smart-background-design.md](../specs/2026-10-17-smart-background-design.md)。

## Task 1：纯函数前景估计

- 新增 `src/core/subjectSelect.ts`
  - 背景色聚类、Otsu 阈值、边缘洪泛、连通域过滤、软边；
  - `resampleCoverage()` 做双线性放大。
- 新增 `src/core/subjectSelect.test.ts`，先写失败测试。
- 验证：`npx vitest run src/core/subjectSelect.test.ts`。

## Task 2：图像层接线

- `src/image/backgroundSelect.ts`
  - `selectSubjectToMask(source, mask)`：缩图、估计、放大、写回掩码。
- 新增 `src/image/backgroundReplace.ts`
  - 透明 / 纯色 / 虚化 / 自定义图片合成；
  - 输出新 `ImageBitmap`，主体 alpha 从掩码来。

## Task 3：现场与 UI

- `src/app/useTransparent.ts`
  - 智能主体动作、背景选择、自定义背景解码与释放、合成提交。
- `src/ui/TransparentControls.tsx`
  - 智能主体按钮、背景下拉、颜色 / 图片条件控件、主按钮文案。
- `src/App.tsx`：接线与 busy。
- `src/styles.css`：下拉、颜色选择器、文件名。

## Task 4：接线测试

- `src/test/appHarness.tsx`：假 `selectSubjectToMask` / `replaceBackgroundToBitmap`。
- `src/App.tools.test.tsx`：
  - 智能主体 → dirty → 换白底；
  - 虚化背景；
  - 自定义图片未选时禁用、选完可提交；
  - 取消不跑合成。

## Task 5：验证

- `npm run typecheck`
- `npx vitest run src/core/subjectSelect.test.ts src/App.tools.test.tsx`
- `npm test`
- `npm run check:copy`
- 真浏览器：合成图与 `test-photos/e2e_first_use.jpg`，桌面 + 390px。
- `git diff --check`。
