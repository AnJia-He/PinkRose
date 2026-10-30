# 双重曝光 / 图片叠加（设计）— 2026-10-17

## 0. 一句话

「装饰」新增第三种模式「叠加」：选第二张图片，按正常 / 滤色 / 正片叠底 /
叠加四种混合模式和不透明度盖到当前照片上，应用后写进当前这一版底图。

## 1. 分层

- 第二张图只在本次工具现场里存在（`ImageBitmap` + 预览 data URL）；
- 预览是 `ui/Canvas` 里的 `<img>`，用同样的 `mix-blend-mode` 和 opacity；
- 成片在 `image/doubleExposure.ts` 里用 Canvas 2D
  `globalCompositeOperation` + `globalAlpha` 合成；
- 提交走 `app/baseEdit.ts`：换底图、账本记一笔、可撤销；
- 不进转盘、不写对话、不改全局 `params`。

## 2. 铺图方式

第二张图按 **cover** 铺满当前照片：等比缩放到两边都盖住，再居中裁切。
`coverRect()` 是纯函数，横图和竖图各有单元测试。

## 3. 混合模式

```ts
normal   → source-over
screen   → screen
multiply → multiply
overlay  → overlay
```

不透明度 0~100，默认 50。主按钮只在「选过第二张图 + 不透明度 > 0 + 没在算」时可用。

## 4. 界面

- 不新增工具行格子：入口是「装饰 → 叠加」；
- 第二行：边框 / 贴纸 / 叠加、选第二张图（或换一张）、混合模式、不透明度、
  取消 / 应用叠加；
- 第二张图名字显示在第二行，方便确认选的是哪张；
- 预览图先按当前照片比例做 cover，再贴到画布上，保证边界完全对齐。

## 5. 验证

- `image/doubleExposure.test.ts`：cover 横图 / 竖图、四种混合映射；
- `App.tools.test.tsx`：装饰 → 叠加 → 选图 → 正片叠底 70% → 应用 → 新底图；
- 真浏览器：纯蓝底 + 纯橙图，正常模式 50% 叠出 `(150,100,125)`；
- `check:layout` / `check:copy` / 全量单测。

## 6. 不做什么

- 不做多图层混合；
- 不做逐像素蒙版；
- 不做位置 / 缩放手势（这一版固定 cover 居中）；
- 不动小程序界面。
