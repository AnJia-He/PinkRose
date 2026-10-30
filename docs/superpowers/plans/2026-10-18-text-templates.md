# 文字模板实现计划 — 2026-10-18

设计见 [2026-10-18-text-templates-design.md](../specs/2026-10-18-text-templates-design.md)。

## Task 1：模板数据

- `src/image/text.ts`：`TEXT_STYLES`（六套、短边比例、样式 patch）。

## Task 2：界面

- `src/ui/TextControls.tsx`：模板胶囊 + 按图片短边换算字号。
- `src/App.tsx`：把 `image` 传给文字控件。

## Task 3：测试与 Apple 验收

- `App.tools.test.tsx`：标题 / 杂志模板。
- `check:safari`：WebKit 下套用标题模板并检查字号。

## Task 4：验证

- README / 文案规范；全量测试、typecheck、build、layout、copy。
