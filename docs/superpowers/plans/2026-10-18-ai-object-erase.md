# AI 局部消除实现计划 — 2026-10-18

设计见 [2026-10-18-ai-object-erase-design.md](../specs/2026-10-18-ai-object-erase-design.md)。

## Task 1：图像层

- 新增 `src/image/aiErase.ts`：`planInpaintCrop` / `buildInpaintInput` /
  `compositeInpaint` / `blendInpaintPixels` / `inpaintAreaTooLarge`。
- 新增 `src/image/aiErase.test.ts`：裁切夹取、掩码外不变、软边、面积闸门。

## Task 2：现场与提交

- 新增 `src/app/useAiErase.ts`：掩码、笔刷、取消、付费请求、过期作废、账本。
- 复用 `app/baseEdit.ts`：只改当前这一版；不推版本转盘。

## Task 3：界面

- 新增 `src/ui/AiEraseControls.tsx`。
- `ToolBar` 增加 `aiErase` 子工具；`App` 接画布掩码层和忙碌态。
- 点修第二行加入「AI 消除」。

## Task 4：测试与文案

- `App.tools.test.tsx`：成功后换底图 / 参数不动 / 转盘不动；没涂和太大不发请求。
- README、`docs/文案规范.md`、移动布局 / iPad 探针同步。
