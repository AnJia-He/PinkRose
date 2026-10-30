# 人像自动塑形实现计划 — 2026-10-17

设计见 [2026-10-17-portrait-reshape-design.md](../specs/2026-10-17-portrait-reshape-design.md)。

## Task 1：人脸框

- `src/core/faceDetect.ts`：肤色连通域 + 正脸比例收口。
- `src/image/faceDetect.ts`：640 副本检测，放大回原图。
- `src/core/faceDetect.test.ts`。

## Task 2：塑形引擎

- `src/image/faceShape.ts`：反向采样瘦脸 / 大眼 / 下巴 / 瘦身，软边淡出。
- 同文件 `faceShapeToBitmap()`：预览与提交共用，`maxSide` 区分。
- `src/image/faceShape.test.ts`。

## Task 3：现场

- `src/app/usePortrait.ts`
  - 打开时检测；
  - 120ms 防抖预览；
  - 提交走 `baseEdit`；
  - 取消 / 切屏 / 换照片释放位图。

## Task 4：界面

- `src/ui/PortraitControls.tsx`：四根滑杆 + 重来 / 取消 / 应用人像。
- `src/ui/FaceGuide.tsx`：照片上的人脸椭圆框。
- `src/ui/ToolBar.tsx`：第 4 颗「人像」。
- `src/ui/Canvas.tsx`：人脸框现场。
- `src/App.tsx`：接线、busy、切屏清理。
- `src/styles.css`：人脸框样式、八颗工具格的窄屏说明。

## Task 5：测试与验收

- `src/test/appHarness.tsx`：检测 / 塑形模块假桩。
- `src/App.tools.test.tsx`：识别、预览、提交、无脸。
- `scripts/check-mobile-layout.mjs`：开着人像的第二行。
- 真浏览器：真实人像、手机 390px、控制台。
- `npm run typecheck`、定向测试、`npm test`、`check:layout`、`check:copy`。
