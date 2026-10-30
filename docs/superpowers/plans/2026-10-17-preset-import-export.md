# 预设导入 / 导出实现计划 —— 2026-10-17

1. `src/core/presetFile.ts`：版本化序列化、解析、校验、文件名。
2. `src/core/presetFile.test.ts`：格式与边界测试。
3. `src/ui/PresetManager.tsx`：导入 / 导出行、文件读取、状态句。
4. `src/export/save.ts`：通用 `downloadFile`，下载图仍走同一入口。
5. 组件测试、文案、README、真浏览器导入导出验收。
