/**
 * GL 读回来的像素 → 2D 画布（**翻行**之后贴进去）。
 *
 * **翻行这一步的规矩只有这一份**（2026-10-12 Task 9 收口）：`gl.readPixels` 的行序
 * 自下而上（GL 约定，见 `tonePipeline.readPixels` 的注释），直接把字节当图片用会
 * 上下颠倒 —— 而且看着像"照片本来就那样"。两个调用点都走这里：
 *   · 风格栏的格子（`thumbs.ts` 的拼图）；
 *   · 保存的像素兜底路（`export.ts` 的 `pixelsToFile`，全尺寸一读一写）。
 *
 * 逐行逐字节搬（不走整块 subarray/set）：换来的是不依赖任何 TypedArray 方法在
 * 小程序这边实现的差异（thumbs 当年就是这么写的，全尺寸那一路多花的是一次
 * 48 MB 级的内存拷贝，可以忽略）。
 *
 * @param ctx 2D 画布上下文（离屏画布）：`createImageData` / `putImageData` 都从它拿
 * @param px  `readPixels` 读回来的 RGBA 8bit 像素（**自下而上**）
 * @param w   像素宽（px）
 * @param h   像素高（px）
 * @param x   贴到 2D 画布的哪个 x（风格栏拼图用；导出固定 0）
 * @param y   贴到 2D 画布的哪个 y（同上）
 */
export function putPixelsFlipped(
  ctx: WechatMiniprogram.IAnyObject,
  px: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
): void {
  const img = ctx.createImageData(w, h)
  const dst: Uint8Array = img.data
  const row = w * 4
  for (let r = 0; r < h; r++) {
    const s = (h - 1 - r) * row
    const d = r * row
    for (let k = 0; k < row; k++) dst[d + k] = px[s + k]
  }
  ctx.putImageData(img, x, y)
}
