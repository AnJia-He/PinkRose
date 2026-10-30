# 贴纸 / 形状合成模式设计 —— 2026-10-19

## 目标

让「我的图」真正能当画中画用，也让形状可以参与合成：

- 贴纸和形状都支持不透明度与 `normal / screen / multiply / overlay`
  四种混合模式；
- 自定义图片额外支持「完整显示 / 填满裁切」和水平 / 垂直翻转；
- 预览（CSS `mix-blend-mode`）和成片（Canvas
  `globalCompositeOperation`）使用同一套模式名；
- 提交仍走 baseEdit：只改当前这一版底图、账本记一笔、可撤销。

## 契约

- 混合模式类型和 Canvas 映射收在 `image/blend.ts`；双重曝光、
  贴纸、形状共用，不各写一份字符串。
- 不透明度 0 = 无效果，主按钮禁用；1~100 直接作为 Canvas
  `globalAlpha` / CSS `opacity`。
- 自定义图片默认 `contain`，保持原比例；`cover` 时裁切到贴纸方框。
- 翻转只影响贴纸 / 图片本身，不改变位置和框大小。

## 验收

- `sticker.custom.test.ts`：填满时按 cover 缩放、裁切到方框，
  不透明度 / 混合 / 翻转落到 Canvas。
- `shape.render.test.ts`：形状的不透明度和混合模式落到 Canvas。
- `App.tools.test.tsx`：贴纸 / 形状选择正片叠底后原样交给各自引擎。
- 真 WebKit：预览的 `mixBlendMode`、图片 `object-fit`、翻转变换、
  应用后底图变化、390px 不溢出、控制台无错。
