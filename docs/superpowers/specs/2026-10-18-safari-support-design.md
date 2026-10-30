# Apple / Safari 支持（设计）— 2026-10-18

## 0. 一句话

Web 产品要能被 iPhone / Mac 的 Safari 正常使用。用 Playwright 的 WebKit
内核（和 iPhone Safari 同源）跑真实用户路径，覆盖上传、调色、实时直方图、
文字工具和 390px 布局；同时补上 Safari 需要的 `-webkit-backdrop-filter`。

## 1. 已确认可用的能力

在 WebKit 26.5（Safari 引擎）实测：

- WebGL2、`createImageBitmap`、`Path2D` 都可用；
- 照片上传 → Canvas 渲染 → 直方图离屏回读 → 调亮度实时更新；
- 390×844 iPhone 视口不横向溢出；
- 文字工具能输入、能启用「加上文字」；
- 控制台无错误。
- 画布扩展把底图改成 1000×1000 后，WebKit 曾出现绘图缓冲有像素、合成层却整块透明。
  修复方式是底图尺寸变化时替换 `<canvas>` 元素并重建 WebGL 管线；
  `Canvas.zoom.test.tsx` 钉住这条，Chromium / WebKit 探针验证最终画布显示正常。

现有导出路径已经考虑过 Safari：`canShareImage()` 用真实的图片 `File`
询问 `navigator.canShare`，不支持文件分享时退回下载。

## 2. 本次改动

- 新增 `scripts/check-safari.mjs` 和 `npm run check:safari`；
- `landing.css` 的磨砂导航补 `-webkit-backdrop-filter`；
- 文档记录 Apple 端的验证入口。

## 3. 兼容边界

主题令牌使用 CSS `light-dark()`，需要 **Safari 17.5+ / iOS 17.5+**。
这是 2026 年现行 Safari 的基线；更老的 iOS 若要支持，需要另做一套
主题回退，不在本轮范围。

## 4. 验证

```bash
npx playwright install webkit   # 第一次
npm run dev                     # 另一个窗口
npm run check:safari
```

探针输出必须是全绿；另外继续跑全量测试、typecheck、build、check:layout、
check:copy、check:lut。

## 5. 不做

- 不为 iOS 16 及更早版本补主题回退；
- 不改小程序界面；
- 不引入原生 App；⚠️ 2026-10-18 后续补了 Web App Manifest 与 iOS 主屏元数据（standalone 启动、固定图标和名称），仍不引入 service worker 离线缓存。
