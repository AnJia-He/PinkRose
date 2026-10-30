# 作品多选下载实现计划 —— 2026-10-17

1. `src/batch/works.ts`：原图逐张取回、失败隔离、同名去重、ZIP 与状态结果。
2. `src/batch/works.test.ts`：纯流程与边界测试。
3. `src/ui/kit/SelectBar.tsx`：可选下载动作、下载状态句、忙碌锁。
4. `src/ui/GalleryPage.tsx`：选择条接线、进度和结果。
5. `App.gallery.test.tsx` + 真浏览器验收、README / 文案规范。
