# 导出设置（设计）— 2026-10-17

## 0. 一句话

在「下载 / 分享」旁边补一个可展开的导出设置：格式（JPG / PNG / WebP）、
压缩质量、长边尺寸（原图 / 2048 / 1080）。不打开也能按默认值一键导出，
打开后按用户选的编码和尺寸把图拿走。

## 1. 为什么现在做

调色、裁剪、点修、磨皮、局部、文字都已经能把图改好，但「把图交出去」这一步
只有一种固定编码：JPG 95%、原尺寸。市面修图产品普遍会让用户控制：

- 透明底 / 无损导出（PNG）；
- 更小的文件（WebP / 质量）；
- 发朋友圈、发消息时先缩到长边 1080 / 2048。

这条能力不碰编辑数据模型，也不改服务端会话格式，完全落在 `useDelivery`
和导出层，是当前最独立、最能补齐成品链路的缺口。

## 2. 选项

```ts
type ExportOptions = {
  format: 'image/jpeg' | 'image/png' | 'image/webp'
  qualityPct: number        // 60~100；PNG 忽略
  longEdge: number | null   // null = 原尺寸；从不放大
}
```

默认值保持原行为：`image/jpeg`、95%、原尺寸。

`exportSize(width, height, longEdge)` 只做等比缩小；原图比上限小就原样返回，
极端比例至少保留 1px。

## 3. 界面

- 舞台底部操作条最后一颗是 `<details>` 的 `导出设置`，展开后是一个小面板；
- 格式和尺寸用 radio（不是 button）—— `.actions button` 那三颗是测试和探针
  的锚点，不能被这里的选项污染；
- 质量用 range，仅 JPG / WebP 显示；PNG 明确写「无损」；
- 主按钮「下载 / 分享」语义不变，只是读当前选项；
- 面板在窄屏上限宽 `calc(100vw - 32px)`，向右对齐。

## 4. 落地

- `save.ts`：`ExportFormat` 加 WebP、`ExportOptions`、`exportSize`、
  WebP 文件名后缀；
- `useDelivery.ts`：选项 state、按长边生成一张临时 2D 画布、
  把格式 / 质量传给 `buildExportBlob`；
- `ExportSettings.tsx`：受控的格式 / 质量 / 尺寸面板；
- `TopActions.tsx`：接收 `exportSettings` 节点，保持原有三颗按钮不变。

### 4.1 「存进作品」不受影响

作品集存的是**我们自己保存的母版**：固定 JPEG 95% 原尺寸。导出的 WebP
只用于下载 / 分享。这样服务端存储格式稳定，也避免把「发消息用的压缩图」
当成作品母版。

## 5. 不做

- 不做服务端 WebP 存储；
- 不做自定义宽高 / DPI / 色彩空间；
- 不在该轮做批量导出；后续已由
  `2026-10-17-batch-processing-design.md` 单独补上（作品页内的批量工作区）。
- 不动小程序。

## 6. 验证

- `save.test.ts`：WebP 文件名、`exportSize` 等比缩小 / 不放大 / 非法值；
- `ExportSettings.test.tsx`：格式 / 质量 / 尺寸回调、PNG 不显示质量；
- `App.test.tsx`：选 WebP + 质量 80 后下载，参数和文件名都跟着变；
- 真浏览器：桌面 / 390px 面板在视口内，实际下载一张 1080 长边的 WebP。
