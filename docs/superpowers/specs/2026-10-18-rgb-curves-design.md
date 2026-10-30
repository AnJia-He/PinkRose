# RGB 分通道曲线（设计）— 2026-10-18

## 0. 一句话

现有的「曲线」从整体影调扩展成 **RGB / 红 / 绿 / 蓝** 四个通道。每个通道
还是五个控制点；切到哪条通道就拖哪条，整体影调保持原样。用来修偏色、
做电影感分离色调，不引入新的图片模型。

## 1. 为什么是它

Lightroom、Snapseed、VSCO 的曲线都有 RGB 通道。现有产品只有一条整体亮度
曲线，能改明暗但不能单独改红 / 绿 / 蓝响应；HSL 和色彩平衡能调颜色，
但替代不了「阴影偏青、高光偏暖」这种按通道分布的曲线。

## 2. 参数契约

- 保留原有五个整体曲线键：`curveBlack` … `curveWhite`；
- 追加 15 个键：
  - 红：`curveRedBlack` / `curveRedShadows` / `curveRedMidtones` / `curveRedHighlights` / `curveRedWhite`
  - 绿：`curveGreen*`
  - 蓝：`curveBlue*`
- 范围与整体曲线一致：黑场 0~100、白场 -100~0、其余 -100~100；
- `PARAM_KEYS` 在整体曲线之后追加 15 个；总参数 74，uniform 77
  （74 参数 + HSL / 整体曲线 / RGB 曲线三个开关）。

## 3. 着色器

1. 整体曲线仍按亮度偏移执行（老照片逐字节不变）；
2. 之后按通道执行：
   ```
   c.r = curveRedAt(c.r)
   c.g = curveGreenAt(c.g)
   c.b = curveBlueAt(c.b)
   ```
3. 三条通道共用一个 `curve5()`，控制点数学和 CPU 的
   `core/toneCurve.ts` 完全一致；
4. 三组全 0 时 `uCurveRgbOn = 0`，整段跳过。

## 4. 界面

- 曲线组顶部新增 `RGB / 红 / 绿 / 蓝` 四个通道胶囊；
- 选中的通道显示自己的五个控制点、曲线和读数；
- 「拉直」只重置当前通道；「全部」把整体 + 三条通道一起拉直；
- 默认仍是 RGB（整体影调），老用户的手感不变。

## 5. 验证

- `core/toneCurve.test.ts`：三条通道独立、红中间调只改红、反解、总开关；
- `shared/adjustments.test.ts`：74 键、顺序、范围、toUnit；
- `render/uniforms.test.ts`：77 个 uniform、`uCurveRgbOn`；
- `render/shader.test.ts`：RGB 曲线在整体曲线之后、美颜之前，0 时跳过；
- `AdjustmentPanel.behavior`：切红通道 → 拖点只改红色参数，切回 RGB 整体曲线不变；
- 真机探针：红色中间调拉高后红色通道变亮、绿 / 蓝不动；三条曲线为 0 时逐字节回到基线。

## 6. 不做

- 不做任意加点 / 曲线预设库；
- 不做关键点或 AI 自动曲线；
- 不改小程序界面。
