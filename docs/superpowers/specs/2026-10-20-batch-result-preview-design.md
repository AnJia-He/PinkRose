# 批量结果缩略图设计 —— 2026-10-20

## 0. 背景

批量处理完 20 张后，结果区只有文件名、尺寸和大小。用户要下载整个 ZIP、解压后
才能确认每张是否真的按预期处理；如果其中几张不对，只能重跑整批。

## 1. 实现

- `processBatchFiles` 在导出前从最终的合成画布生成一张长边 ≤160px 的 JPEG
  data URL，挂在 `BatchSuccess.preview`；
- 缩略图生成失败（画布被污染 / 浏览器不支持）时安静地留空，不影响导出；
- 结果区每行左侧显示缩略图，右侧保留文件名、尺寸和大小；
- 手机端缩略图缩到 40px，行内不横向溢出。

## 2. 验证

- `batch/process.test.ts`：成功项带 `data:image/jpeg` 预览；
- `BatchPanel.test.tsx`：结果区渲染 `.batch-done-thumb`；
- iPhone WebKit 390×844：处理两张后出现 2 张缩略图，页面无横向溢出。
