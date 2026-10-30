# 局部修容 / 高光实现计划 —— 2026-10-18

1. `src/image/localAdjust.ts`：新增 `contour` / `highlight` 固定预设、冷棕 / 暖棕 / 灰棕与香槟 / 珍珠 / 蜜桃色板。
2. `src/ui/LocalControls.tsx`：局部效果行加「修容 / 高光」，选中后显示各自色板。
3. `src/app/useLocal.ts` / `src/App.tsx`：接线色号，沿用现有局部账本。
4. 单测：修容压暗、高光提亮、掩码外与强度 0 不动；App 提交参数与色号。
5. README / 文案规范 / 设计文档同步；重跑全量、构建和 Apple 探针。
