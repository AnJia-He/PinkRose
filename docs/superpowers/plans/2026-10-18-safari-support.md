# Apple / Safari 支持实现计划 — 2026-10-18

设计见 [2026-10-18-safari-support-design.md](../specs/2026-10-18-safari-support-design.md)。

## Task 1：兼容探针

- `scripts/check-safari.mjs`：WebKit / 390px；落地页、注册、上传、调色、
  直方图、文字工具、控制台错误。
- `package.json`：`check:safari`。

## Task 2：Safari 样式补丁

- `src/landing.css`：`-webkit-backdrop-filter` 前置。

## Task 3：文档

- README 加 Apple/Safari 验证入口；记录 `light-dark()` 的现代 Safari 基线。

## Task 4：验证

- `npx playwright install webkit`（首次）
- `npm run check:safari`
- 全量测试、typecheck、build、layout、copy、lut、diff check。
