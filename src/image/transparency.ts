import { makeCanvas } from '../core/canvas'
import { maskBounds } from '../core/retouch'
import type { BackgroundSource } from './backgroundReplace'

/**
 * **透明擦除的像素引擎**（★ 2026-10-17）—— 「点修 → 抠图」的落点。
 *
 * 和磨皮 / 局部共用同一张覆盖率掩码，但只改 alpha：
 * `alpha' = alpha × (1 - coverage)`。RGB 原样留着，边缘在浏览器预乘 alpha
 * 时不会先被抠成黑边；掩码外一个字节都不写。
 */
export function eraseAlphaPixels(
  data: Uint8ClampedArray, width: number, height: number,
  coverage: Uint8Array,
): { covered: number } {
  if (coverage.length !== width * height) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${coverage.length} 字节，照片 ${width}×${height}）`)
  }
  const bounds = maskBounds(coverage, width, height)
  if (!bounds) return { covered: 0 }
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255
      if (cov <= 0) continue
      const i = mi * 4 + 3
      data[i] = Math.round(data[i]! * (1 - cov))
    }
  }
  return { covered: bounds.count }
}

export async function transparentToBitmap(
  source: BackgroundSource, mask: Uint8Array,
): Promise<{ bitmap: ImageBitmap; covered: number }> {
  const w = source.width
  const h = source.height
  if (mask.length !== w * h) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${mask.length} 字节，照片 ${w}×${h}）`)
  }
  const { canvas, ctx } = makeCanvas(w, h, '抠不了这张图', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, w, h)
  const { covered } = eraseAlphaPixels(image.data, w, h, mask)
  if (covered > 0) ctx.putImageData(image, 0, 0)
  // 不让浏览器在中间偷偷预乘 alpha —— 上游纹理是 unpremultiplied 的。
  const bitmap = await createImageBitmap(canvas, { premultiplyAlpha: 'none' })
  return { bitmap, covered }
}
