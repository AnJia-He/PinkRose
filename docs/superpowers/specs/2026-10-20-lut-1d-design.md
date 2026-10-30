# 1D `.cube` LUT 支持 — 2026-10-20

## 目标

让当前只接受 3D 表的 Lut 导入同时支持常见的 1D `.cube`，并且不在编辑器、
批量、缩略图、GPU 渲染和作品恢复中维护第二条特效链。

## 方案

- `shared/lut.ts` 解析 `LUT_1D_SIZE n`，数据行仍为每行三个浮点值。
- 1D 表表示 R / G / B 三条彼此独立的通道曲线：输入 `(r,g,b)` 分别查询
  R / G / B 曲线，再组合成输出颜色。
- 解析时把三条曲线展开成一张 3D RGBA8 表，级数为 `min(64, max(2, n))`；
  因此现有 `TEXTURE_3D`、三线性采样、强度混合、批量和缩略图完全复用。
- 展开时按归一化网格取样，并保留原文件的 `TITLE`、`DOMAIN_MIN` 和
  `DOMAIN_MAX`。
- 1D 原始级数上限 65536；文件仍受现有 8 MB 和 Lut 数量配额限制。

## 错误处理

- 级数非法、数据行数不对、数值越界和 3D 文件使用同一套中文错误。
- 同一文件同时声明 `LUT_1D_SIZE` 与 `LUT_3D_SIZE` 时拒绝，避免猜测用户意图。

## 验证

- `shared/lut.test.ts`：三通道独立曲线、1D domain 保留。
- `src/core/lut.test.ts`：解析后直接进入现有 CPU 查表。
- `server/luts.test.ts`：导入、存储和接口回归。
- `npm run check:lut`：真实 Chrome / WebGL2 上传 1D `.cube`，GPU 像素与 CPU
  对照逐像素一致（22/22）。
