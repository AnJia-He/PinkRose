# 自动水平实现计划 — 2026-10-17

设计见 [2026-10-17-auto-straighten-design.md](../specs/2026-10-17-auto-straighten-design.md)。

## Task 1：纯算法

- `src/core/horizon.ts`：缩略灰度 + 模糊 + 每列竖直边 + RANSAC + 加权最小二乘。
- `src/core/horizon.test.ts`：正负倾角、水平线、噪点、竖线、45° 斜线、非法输入。
- 验证：`vitest run src/core/horizon.test.ts`。

## Task 2：像素入口与接线

- `src/image/straighten.ts`：底图缩到长边 480，取 RGBA，交给纯算法。
- `src/app/useCrop.ts`：`autoStraighten`，按 0.5° 档写入 `spec.angle`；
  找不到 / 失败时明确提示。
- `src/ui/CropControls.tsx`：第二行「自动水平」按钮。
- `src/App.tsx`：接线。

## Task 3：测试

- `App.tools.test.tsx`：4.2° → 4°；null → 不动 + 提示。
- 真实浏览器探针：6° 合成地平线 → 水平矫正 6°、canvas `rotate(-6deg)`。

## Task 4：文档与验收

- README / 文案规范。
- `npm test`、`npm run typecheck`、`npm run build`、`npm run check:layout`、
  `npm run check:copy`、`git diff --check`。
