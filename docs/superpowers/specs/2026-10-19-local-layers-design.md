# 可回改局部层设计 —— 2026-10-19

## 1. 为什么不再烘焙

2026-10-17 的「局部」是烘焙式：应用后像素写进底图，回来只能撤销重画。
这一轮把它补成主流修图产品的第二种形态：**蒙版和参数进会话，随时回来改**。

核心约束是**底图永远干净**：

- `image.bitmap` 只存没有局部效果的那一版；
- 画布和工具拿的是派生图 `effectiveImage = applyLocalLayers(image, localLayers)`；
- 一旦用户用裁剪 / 磨皮 / 液化 / 点修这类底图工具，派生图已经包含局部效果，
  新底图落地时**同时清空局部层**（`App.setBaseImage`），不会叠两遍。

## 2. 数据模型

`shared/local.ts`：

```ts
type LocalLayer = {
  kind: 'local'
  id: string
  mask: string        // 灰度 PNG data URL（R 通道，A=255）
  maskWidth: number
  maskHeight: number
  feather: number     // 0–100，渲染时按底图短边柔化
  opacity?: number    // 0–100，整层混合；缺省 100
  options: LocalAdjustOptions
  /** 色彩范围选出来的层：取色参数也带上，回来还能调容差 / 羽化。 */
  color?: {
    target: [number, number, number]
    tolerance: number
    feather: number
    invert?: boolean
    edge?: number
  }
}
```

它和文字 / 形状 / 贴纸一起进 `EditLayer`，所以账本、撤销 / 重做、会话落盘、
封面和导出都复用同一套路径。

`LocalAdjustOptions` 的调色字段是 `exposure` / `contrast` / `saturation` /
`temperature` / `highlights` / `shadows` / `vibrance` / `clarity`；高光和阴影
与全局共用 `applyTone`，自然饱和度按像素饱和度加权，清晰度在选区里做亮度高通。
它们都只作用于蒙版内，从不写进 `params`。

## 3. 掩码的存储与上限

- 编码时按最长边压到 **1280**，缩小时做区域平均（避免抽点锯齿）；
- 解码时用浏览器双线性放大回当前底图尺寸；
- 单条掩码 ≤ 2,000,000 字符；一版最多 **8** 条；一版掩码总量 ≤ 6,000,000 字符；
- 掩码尺寸 16–2560，超出或不是 `data:image/` 的层直接丢弃；
- 全零调色 / 强度 0 的层视为无效，不落盘。

这些上限让一次会话 PUT 仍远低于服务端 12 MB 的请求体上限。

## 4. 渲染顺序

1. 从干净底图开始，按 `layers` 里的局部层顺序逐层 `localAdjustPixels`；
2. 得到一张新的派生位图，交给 WebGL 管线跑全局参数 / 滤镜；
3. 文字 / 形状 / 贴纸继续作为叠图在画布上层预览；
4. 导出直接取 WebGL 画布（已含局部），再叠文字 / 形状 / 贴纸。

`drawEditLayers` / `editLayersToBitmap` **跳过局部层**：它们不是叠图。
`compositeEditLayers` 默认会补局部层（恢复旧步骤缩略图用），
源图已经是派生图时传 `{ localsAlreadyApplied: true }`。

## 5. 交互

- 「局部」第二行多一颗「存为层」：把当前掩码 + 参数存成可回改层，不换底图；
- 已存层显示成「局部层 1 / 2…」，点一下把掩码和参数接回现场；
- 回改时主按钮变「更新层」，覆盖同一层（id 不变）；
- 「删」删除该层，同样记一笔账，可撤销；
- 派生图算的时候挡住开底图工具（几百毫秒），避免拿到不含局部效果的底图。

## 6. 验证

- `shared/layers.test.ts`：归一化、坏层丢弃、8 层上限、掩码变化比较；
- `src/App.tools.test.tsx`：存为层不改底图 / 回改 / 更新 / 删除；
- 真浏览器（390px Chromium）：存层后画布变化、刷新后层和值恢复、删除生效、
  无横向溢出、控制台无错；
- 全量 `npm test` / `npm run typecheck` / `npm run build` / `npm run check:layout`。
