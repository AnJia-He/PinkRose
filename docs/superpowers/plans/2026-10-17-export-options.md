# 导出设置实现计划 — 2026-10-17

设计见 [2026-10-17-export-options-design.md](../specs/2026-10-17-export-options-design.md)。

## Task 1：导出层

- `src/export/save.ts`：WebP 格式、`ExportOptions`、`exportSize`。
- `src/export/save.test.ts`：文件名与尺寸数学。

## Task 2：交付 hook

- `src/app/useDelivery.ts`：选项 state；按长边重绘临时画布；
  下载 / 分享读选项，存进作品固定 JPEG 原尺寸。

## Task 3：界面

- `src/ui/ExportSettings.tsx`：格式 / 质量 / 长边。
- `src/ui/TopActions.tsx`：接收并渲染导出设置节点。
- `src/App.tsx`：接线。
- `src/styles.css`：窄屏面板宽度与暗色浮层。

## Task 4：测试与真机

- `src/ui/ExportSettings.test.tsx`：回调与 PNG 无质量。
- `src/App.test.tsx`：WebP + 质量 80 的下载参数。
- 浏览器：桌面 + 390px 展开面板；下载并核对 1080 长边 WebP。

## Task 5：文档与全量验证

- README / `docs/文案规范.md`。
- `npm test`、`npm run typecheck`、`npm run check:layout`、`npm run check:copy`。
