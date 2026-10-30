# 浏览器端 TIFF 导出 — 2026-10-20

## 目标

给摄影、打印和继续后期提供无损交付格式，同时保持本地优先：像素在浏览器内编码，
不把成片上传到云端。

## 格式

- 小端 TIFF，单 strip；浏览器支持 `CompressionStream('deflate')` 时写 Deflate，
  不支持或压缩后反而变大时回退无压缩。
- 没有透明像素时写 8 位 RGB（3 通道）。
- 检测到透明像素时写 8 位 RGBA（4 通道），`ExtraSamples=2` 表示未预乘 alpha。
- 文件名扩展名为 `.tif`，MIME 为 `image/tiff`。
- 质量滑杆不作用于 TIFF；面板明确说明无损、可用时压缩且保留透明区域。

## 边界

- 当前不把原图 EXIF 写进 TIFF；面板对非 JPG 明确显示“不写入拍摄信息”。
- 不写多页 / LZW / 16 位 TIFF。Deflate 用浏览器原生流实现，Pillow 独立解码验证；
  没有原生流时保留无压缩回退，避免老 Safari 导出失败。
- 文件仍受画布尺寸和浏览器内存限制；编码前检查 4GB 单文件上限。

## 验证

- `src/export/tiff.test.ts`：TIFF 头、宽高、RGB 像素顺序、RGBA 透明通道和统一导出入口。
- `src/export/save.test.ts` / `prefs.test.ts` / `ExportSettings.test.tsx`：格式、文件名、默认偏好和 UI。
- `npm run check:safari`：iPhone 390px WebKit 实际下载 `.tif`，并读取文件头
  `49 49 2a 00`；批量页也实际生成 ZIP，条目为 `.tif` 且文件头正确；完整探针
  54/54 通过。
