import { makeCanvas } from '../core/canvas'
import { fitToLimit, type RenderLimit } from '../render/limits'

/** 默认 2 倍；编辑器里可以选到 4 倍，真正落地的尺寸还要过设备画布闸门。 */
export const DEFAULT_UPSCALE_FACTOR = 2
export const MAX_UPSCALE_FACTOR = 4
/** 本机锐化会额外占一份像素缓冲，面积上限压在 12 MP。 */
export const MAX_UPSCALE_AREA = 12_000_000

export function upscaleTarget(
  width: number, height: number, limit: RenderLimit,
  factor = DEFAULT_UPSCALE_FACTOR,
): { width: number; height: number } | null {
  if (width <= 0 || height <= 0) return null
  const safeFactor = Math.min(MAX_UPSCALE_FACTOR, Math.max(1, factor))
  const desired = {
    width: Math.max(1, Math.round(width * safeFactor)),
    height: Math.max(1, Math.round(height * safeFactor)),
  }
  const fitted = fitToLimit(desired.width, desired.height, {
    maxSide: limit.maxSide,
    maxArea: Math.min(limit.maxArea ?? MAX_UPSCALE_AREA, MAX_UPSCALE_AREA),
  })
  if (fitted.width <= width || fitted.height <= height) return null
  return fitted
}

/**
 * 轻量 unsharp mask：只增强边缘反差，不碰 alpha。
 * `amount` 0 = 一个字节都不改；透明度为 0 的像素也跳过。
 */
export function unsharpPixels(
  data: Uint8ClampedArray, width: number, height: number, amount = 0.35,
): { changed: number } {
  if (amount <= 0 || width < 3 || height < 3) return { changed: 0 }
  const original = new Uint8ClampedArray(data)
  let changed = 0
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width
    const down = Math.min(height - 1, y + 1) * width
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - 1)
      const right = Math.min(width - 1, x + 1)
      const i = (y * width + x) * 4
      if (original[i + 3] === 0) continue
      let hit = false
      for (let c = 0; c < 3; c++) {
        const center = original[i + c]
        const blur = (
          original[(up + x) * 4 + c] +
          original[(down + x) * 4 + c] +
          original[(y * width + left) * 4 + c] +
          original[(y * width + right) * 4 + c] +
          center * 4
        ) / 8
        const diff = center - blur
        if (Math.abs(diff) >= 1) {
          data[i + c] = Math.max(0, Math.min(255, Math.round(center + diff * amount)))
          hit = true
        }
      }
      if (hit) changed++
    }
  }
  return { changed }
}

/** 高品质重采样 + 轻度锐化，返回新的位图。 */
export async function upscaleToBitmap(
  source: ImageBitmap, width: number, height: number,
): Promise<ImageBitmap> {
  const { canvas, ctx } = makeCanvas(width, height, '放大不了这张图', {
    willReadFrequently: true,
  })
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, width, height)
  const image = ctx.getImageData(0, 0, width, height)
  unsharpPixels(image.data, width, height)
  ctx.putImageData(image, 0, 0)
  return createImageBitmap(canvas)
}
