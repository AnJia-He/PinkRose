# 水印 Logo / 平铺实现计划 — 2026-10-17

1. `src/image/watermark.ts`：扩展文字 / Logo、单个 / 平铺布局，新增 Logo 读取与释放。
2. `src/export/save.ts`：导出前复制画布并落水印，保持舞台底图干净。
3. `src/ui/WatermarkControls.tsx`：单张导出与批量处理共用的水印控件。
4. `src/ui/ExportSettings.tsx`、`src/app/useDelivery.ts`、`src/App.tsx`：单张导出接线。
5. `src/ui/BatchPanel.tsx`、`src/batch/process.ts`：批量水印与 Logo 接线。
6. 测试：像素布局、控件、批量参数、单张导出副本。
7. 文案规范、README、真浏览器桌面与 390px 验收。
