# 磨皮实现计划 —— 2026-10-17

设计见 [2026-10-17-skin-smooth-design.md](../specs/2026-10-17-skin-smooth-design.md)。
两条腿一起落地：**方案一参数滑杆（Task 1–3）** + **方案二画笔工具（Task 4–7）**。

## Task 1：参数层（shared / uniforms / tone 测试房）

- `shared/adjustments.ts`：`skinSmooth` 追加进 `Adjustments`、`PARAM_KEYS`、
  `PARAM_LABELS`（磨皮）、`PARAM_RANGE`（[0,100]）、`PARAM_GROUPS.effects.keys`、
  `ZERO`、`clampAdjustments`、`toUnit`。所有注释里的"十五个"改"十六个"。
- `src/render/uniforms.ts`：`UNIFORM_NAMES` + `uniformValues` + `uSkinSmooth`。
- `shared/adjustments.test.ts`、`src/render/uniforms.test.ts`：键数/顺序/标签/映射。
- 验证：`vitest run shared/adjustments.test.ts src/render/uniforms.test.ts`。

## Task 2：着色器 + 真机探针

- `src/render/shader.ts`：第 0.5 步肤色识别 + 12 采样保边平滑；ASCII 注释；
  `uSkinSmooth == 0` 分支恒等。
- `src/render/shader.test.ts`：新哨兵（顺序：清晰度 < 磨皮 < 色温；恒等系数）。
- `src/core/tone.test.ts`：夹具补键（`applyTone` 本身不动 —— 磨皮是空间操作，
  和清晰度/暗角一样只在 shader 里）。
- 验证：`npm run check:lut`（要 dev 服务器 + 真 Chrome + 真 GPU；
  沙箱里跑不了就在真机上补，**不许跳过**）。

## Task 3：聊天词表 + 预设 + 文案

- `server/prompt.ts`：`PromptParamKey` + `PARAM_LABELS` + `ROUTER_SYSTEM`
  （JSON 模板 + "磨皮走 params" 一条）。`server/prompt.test.ts` 跟进。
- `server/validate.ts`：不用改（`PARAM_KEYS` 驱动）—— 跑它的测试确认。
- `src/core/presets.ts`：加「柔光人像」预设（`{...ZERO, …}` 长拷贝）。
- `docs/文案规范.md`：总表加「磨皮」一行。
- `README.md`：调色面板/账本两行的工具清单补"磨皮"。

## Task 4：CPU 磨皮引擎

- `src/image/smooth.ts`：
  - `smoothPixels(data, w, h, mask, opts)` —— 纯函数（guided filter，滑动窗口盒均值，
    只算掩码外接框 + 半径边距；coverage 0 一个字节不写）。
  - `smoothToBitmap(source, mask, opts)` —— 画布落地（照 `eraseToBitmap` 的模子）。
- `src/image/smooth.test.ts`：外不改 / 内变糊 / 边保留 / 恒等 / 空掩码。
- 验证：`vitest run src/image/smooth.test.ts`。

## Task 5：画笔工具 UI

- `src/ui/ToolBar.tsx`：`ToolId` 加 `'smooth'`、格子「磨皮」。
- `src/ui/SmoothControls.tsx`：画笔/橡皮、笔刷、强度、取消、「磨这里」。
- `src/app/useSmooth.ts`：现场 + `commitSmooth`（baseEdit 骨架 + 面积闸 + 暗罩）。

## Task 6：App 接线

- `src/App.tsx`：`useSmooth` 接进 `pickTool`、ToolBar 第二行三目、`busy`、
  StepNav 收起条件、切屏 effect。
- `src/App.tools.test.tsx` + `test/appHarness.tsx`：`image/smooth` 模块假桩、
  四条磨皮接线用例。
- `src/ui/ToolBar.test.tsx`：4 格。

## Task 7：样式 + 全量验证 + 同步

- `src/styles.css`：`.retouch-modes` 复用（第二行多一根滑杆，窄屏走既有横向滚动）。
- `node scripts/sync-mini-shared.mjs` + `tools/syncMiniShared.test.ts`。
- 全量：`npm test`、`npm run typecheck`、`npm run check:layout`、`npm run check:copy`、
  `npm run check:lut`（四样能跑的都要绿；沙箱缺真 Chrome/GPU 的，明确记下让真机补）。
- 真机验收（用户侧）：拖磨皮滑杆看实时性；说"磨皮一点"看路由；画笔磨一块看耗时。
