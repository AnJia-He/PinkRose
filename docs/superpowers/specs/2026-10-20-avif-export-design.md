# AVIF 导出（2026-10-20）

## 要解决什么

苹果用户拍的照片多是 HEIC，但分享出去常常要转 JPG；而 JPG 在同样观感下
体积大得多。浏览器 canvas 不会编 AVIF，本机的 ffmpeg 可以（libaom-av1）。
所以加一条**本机转码**的导出格式：

- 导出设置里可选 JPG / PNG / WebP / AVIF；
- AVIF 由客户端把修好的画面编成 PNG，POST 给服务端 `/api/convert/avif`；
- 服务端用固定参数转码（libaom-av1 静帧、yuv420p、avif 容器），临时文件用完即删；
- 批量处理和单张导出共用同一条 `buildExportBlob`，格式选择自动生效。

## 参数

- 质量 0–100 → CRF 17–55（线性映射，夹紧）；
- 源图上限 12MB（PNG/JPEG/WebP），请求体上限 24MB；
- 超时 60 秒；没有 ffmpeg 时回 503，并给出「换 JPG / WebP」的提示。

## 兼容性

- 导出文件是标准 AVIF（ffprobe 显示 codec=av1）；
- Safari 16.4+ / iOS 16.4+ 支持显示；更老的设备仍可下载，但预览会失败；
- 分享面板是否接受 AVIF 由系统决定；失败会退回下载（原有逻辑）。

## 验证

- `server/imageConvert.test.ts`：请求校验、质量→CRF、转码参数、临时目录清理；
- `src/export/avif.test.ts`：画布→PNG→请求体、错误透传；
- `src/export/save.test.ts`：`.avif` 文件名；
- Chromium 实测：1200×800 JPG → AVIF（av1，1638×2048，按导出设置裁切放大），
  平均色 123,133,124 → 123,133,125；71KB → 27KB。
