# 透明抠图（设计）— 2026-10-17

## 0. 一句话

「点修」第二行加「抠图」：点一下背景可按颜色连通区域自动选区，也可用现有画笔 /
橡皮修边，点「擦成透明」把掩码覆盖率写到 alpha 上，产出带透明通道的新底图。
这是颜色 + 连通性选择，不冒充 AI 自动识别主体。

## 1. 为什么复用点修现场

抠图和点修都是「涂一块 → 对这块落一个像素操作」，掩码协议完全一致：
`Uint8Array`、0~255 覆盖率、软笔刷、橡皮。因此复用：

- `ui/RetouchOverlay` 的涂抹层；
- `core/retouch` 的盖章 / 插值 / 边界；
- `app/baseEdit.ts` 的新底图 + 记一笔 + 可撤销；
- 面积上限和慢任务暗罩。

新增的是像素落点 `image/transparency.ts`，以及一键选背景的
`core/backgroundSelect.ts` / `image/backgroundSelect.ts`。

### 1.1 一键选背景

从种子像素做四连通洪泛：

- 只选和种子**连通**、颜色距离不超过容差的像素；
- 容差 0~100，默认 24；越大允许的背景色差越宽；
- 靠近容差边缘的像素给半覆盖，掩码边缘自然过渡；
- 同色但不相连的区域不会被一起选中；
- 选完掩码回到画笔层，用户可以继续补涂或擦回来。

## 2. 像素契约

`eraseAlphaPixels(data, w, h, coverage)`：

```
alpha' = round(alpha × (1 - coverage / 255))
```

- 只改 alpha，RGB 原样保留；浏览器预乘 alpha 时不会被提前抠成黑边；
- 掩码外逐字节不变；
- 已经透明的像素不会变回来；
- 覆盖率 128 = 半透明，软笔刷边缘自然过渡。

## 3. 渲染与导出

- WebGL context 开 `alpha: true`；
- shader 从源纹理取 alpha，调色链只改 RGB，最后
  `fragColor = vec4(rgb, sourceAlpha)`；
- 画布底下的棋盘格只在透明处露出来；
- PNG / WebP 直接走带 alpha 的画布；
- JPEG 没有 alpha，编码前先铺白底；
- 会话底图若检测到透明像素，`bitmapToDataUrl` 改存 PNG；
- 普通不透明照片仍走原 JPEG 路径。

## 4. 界面

- 工具行不加第八格：入口是「点修」第二行的「抠图」；
- 工具行那颗「点修」保持点亮；
- 第二行：修补（返回） / 点背景 / 容差 / 画笔 / 橡皮 / 笔刷 / 取消 / 「擦成透明」；
- 点「点背景」后画布进入取样态，提示「点一下要去掉的背景」；选完画笔层自动回来；
- 涂过或选过背景之前主按钮禁用；
- 应用后工具收掉，换底图、账本记一笔。

## 5. 测试与验收

- `image/transparency.test.ts`：alpha、RGB、软边、空掩码、尺寸错误；
- `core/backgroundSelect.test.ts`：连通性、主体隔离、断开同色块、容差单调性；
- `App.tools.test.tsx`：点修 → 抠图 → 涂 / 点背景 → 擦成透明 → 新底图；
- `render/shader.test.ts`：alpha 来自源纹理，不被写死为 1；
- `core/thumbnail.test.ts`：有透明像素时会话底图改存 PNG；
- 真浏览器：一键选背景只去掉背景、屏幕 alpha、PNG alpha、JPG 白底各验证一次；
- `check:lut`（GLSL 动了）、`check:layout`、`check:copy`、全量单测。

## 6. 不做什么

- 不做 AI 自动主体分割；
- 不做可回编辑的矢量蒙版层；
- 不动小程序界面。
