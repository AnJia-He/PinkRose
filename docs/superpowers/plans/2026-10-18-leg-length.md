# 人像长腿实现计划 —— 2026-10-18

1. `src/image/faceShape.ts`：新增 `legs` 选项——脸下方身体中段向上取样、内容下移，上下缘和两侧淡出。
2. `src/app/usePortrait.ts`：状态、预览零检查、预览/成片参数、重置链路。
3. `src/ui/PortraitControls.tsx` / `src/App.tsx`：新增「长腿」滑杆和接线。
4. 单测：身体中段白线被向下拉、脸和身体外不动、0 恒等；App 提交 legs 参数。
5. README / 文案规范 / 设计文档同步；Apple 探针确认滑杆可用。
