# 一键修复老照片实现计划 —— 2026-10-18

1. `src/core/aiPresets.ts`：固定标签、提示词、应答。
2. `src/ui/ChatPanel.tsx`：加号工具行的「修复老照片」。
3. `src/App.tsx`：`restoreOldPhoto` 直接走 `applyDecision`，复用生成链路。
4. `src/App.tools.test.tsx`：固定提示词 / 新版本接线。
5. `README.md` / `docs/文案规范.md`：能力、额度与结果边界。
6. 类型检查、单测、Chromium + WebKit 拦截式真浏览器探针、布局 / 文案 / Safari 回归。
