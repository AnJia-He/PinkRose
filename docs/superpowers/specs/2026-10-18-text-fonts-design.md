# 文字字体设计 —— 2026-10-18

## 目标

给「文字」工具补四档字体：黑体 / 宋体 / 楷体 / 等宽。预览和成片共用
同一份字体栈；模板也能带字体（胶片 / 杂志用宋体，手记用楷体）。

## 字体栈

- 黑体：`system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`
- 宋体：`"Songti SC", "STSong", "SimSun", Georgia, "Times New Roman", serif`
- 楷体：`"Kaiti SC", "STKaiti", "KaiTi", "楷体", serif`
- 等宽：`ui-monospace, "SFMono-Regular", Menlo, Consolas, "Courier New", monospace`

不嵌入字体文件：Apple 和 Windows 各自落到系统里已有的字体。同一台设备上
预览和成片一致；跨平台字形不同是系统字体的正常表现，不承诺像素级相同。

## 数据与接线

- `TextOptions` 增加 `font: TextFontId`，默认 `sans`；`normalizeTextOptions`
  只接受四个已知 id，非法值回黑体。
- `image/text.ts` 的 `textToBitmap` 用 `textFontFamily(opts.font)`；
  `ui/TextOverlay` 的预览用同一个函数。
- `ui/TextControls` 在模板下面加「字体」四颗胶囊。
- 模板 patch 可以带 `font`；不改用户已输入的 `text/x/y`。

## 验收

- `image/text.test.ts`：默认字体、非法值回退、字体栈内容、模板字体。
- `App.tools.test.tsx`：选宋体后预览和提交都带 `font: 'serif'`。
- 真浏览器（Chromium + WebKit）：四档字体切换进预览、宋体真的写进底图、
  390px 不横向溢出且四档都在。
