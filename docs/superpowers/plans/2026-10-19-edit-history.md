# 可视编辑历史实现计划 —— 2026-10-19

1. `core/history.ts` / `core/ledger.ts`：`editLabel` / `label`、`jumpLedger`、
   `ledgerLabels`，撤销 / 重做 / 记账同步搬名字。
2. 所有记账点补名字：调色、baseEdit 操作、生成式编辑、恢复会话。
3. `ui/StepNav.tsx`：计数展开菜单，支持任意跳转与关闭手势。
4. `App.tsx`：`applyLedger` 收口，`ledgerJump` 接线。
5. 测试、类型检查、构建、WebKit 真浏览器验收。
