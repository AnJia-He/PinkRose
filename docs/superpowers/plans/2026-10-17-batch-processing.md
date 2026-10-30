# 批量处理实现计划 —— 2026-10-17

1. `src/batch/zip.ts`：纯 TS ZIP store 写入器 + 单测。
2. `src/batch/process.ts`：复用现有解码 / 缩放 / WebGL 管线 / 导出，
   逐张处理、失败隔离、停止信号、ZIP 汇总 + 单测。
3. `src/ui/BatchPanel.tsx`：选照片、预设、导出设置、进度、失败清单、下载。
4. `src/ui/GalleryPage.tsx`：作品页内切换批量工作区。
5. `src/styles.css`：桌面 / 390px 布局、拖放、列表、进度与状态样式。
6. 文案规范、README、布局探针、浏览器验收。
