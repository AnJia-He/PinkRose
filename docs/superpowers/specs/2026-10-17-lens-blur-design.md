# 镜头虚化（设计）— 2026-10-17

## 0. 一句话

调色面板补上「镜头」组：焦点可拖的径向景深虚化。焦点附近保持清晰，
外圈按强度 / 范围 / 过渡逐渐变糊，像手机修图里的「镜头模糊 / 移轴」。

## 1. 为什么叫「镜头虚化」而不是「背景虚化」

真正的背景虚化需要**主体分割**（人脸 / 人物 mask），否则会把主体边缘一起糊掉。
这一版没有分割模型，所以明确叫「镜头虚化」：它是一个**焦点可拖**的创意
景深效果，不冒充 AI 抠背景。用户把焦点拖到主体上、再调范围与过渡，就能得到
自然的人像虚化效果。

## 2. 参数

```ts
lensBlur: number     // 0~100，0 = 不虚化
lensRange: number    // -100~100，清晰中心半径；0 = 中等
lensFeather: number  // -100~100，清晰到虚化的过渡；0 = 中等
lensFocusX: number   // -100~100，焦点横向位置；0 = 画面中心
lensFocusY: number   // -100~100，焦点纵向位置；0 = 画面中心
```

- `lensBlur` 是总开关：0 时整段跳过，画面逐字节不变；
- `lensRange` 映射到短边半径的 0.22~0.70；
- `lensFeather` 映射到 0.04~0.30；
- `lensFocusX / lensFocusY` 映射到归一化焦点 `(x, y) = (0.5, 0.5) + v * 0.5`；
- 五根都进预设 / 会话 / 作品配方，默认 0 时画面与旧的固定中心版本逐字节一致。

## 3. 渲染

在 fragment shader 的细节处理之后、色温之前：

1. 用 `vUv`（输出坐标）和 `uLensFocusX/Y` 算出焦点，再算经过宽高比校正的半径 `r`；
2. `smoothstep(range, range + feather, r)` 得到外圈权重；
3. 用 20 个黄金角分布的采样点，在原始纹理上做半径随短边缩放的 disk blur；
4. `c = mix(c, bokeh, lensBlur * focus)`。

半径按短边缩放，2 MP 和 24 MP 的照片看起来一致。采样只在外圈真正需要时才
执行，中心权重为 0。

## 4. 界面与模型

- 面板新增「镜头」组，图标 `Focus`，五根本地滑块；
- 调色屏上虚化强度 > 0 时，照片上出现可拖焦点环；方向键可微调（Shift 加速），
  Home 回中心。环只在小按钮上接指针，不挡画布平移 / 缩放；
- 路由器新增 `lensBlur / lensRange / lensFeather / lensFocusX / lensFocusY`：
  用户说「背景虚化一点」「焦点挪到左边」走 params，不走生成；
- 文案明确写「径向景深效果，不是人物抠图」，避免过度承诺。

## 5. 不做什么

- 不做主体 / 人脸分割；
- 不做椭圆 / 线性移轴的多点焦点；
- 不做真实光学散景形状（光圈叶片）；
- 不动小程序界面。

## 6. 验证

- `shared/adjustments.test.ts`：77 参数、镜头组、焦点范围、toUnit；
- `src/render/uniforms.test.ts`：80 个 uniform；
- `src/render/shader.test.ts`：镜头段在细节之后、色温之前，焦点用 `vUv`；
- `src/ui/LensFocusOverlay.test.tsx`：拖动、方向键、Home、边界夹取与卸载清理；
- `scripts/check-lut.ts`：真 Chrome 编译；
- 真浏览器：拖焦点后清晰区跟着移动；强度回 0 逐像素回基线。
