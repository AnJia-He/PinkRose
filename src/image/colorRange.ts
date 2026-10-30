/**
 * 按颜色选蒙版的**画布胶水**（★ 2026-10-19）。
 *
 * 纯判据在 `core/colorRange.ts`。这里负责：
 *   ① 把底图缩到最长边 1280，读一份 RGBA 缓存（滑杆连续改时不用重读原图）；
 *   ② 在缓存上取一小块平均色；
 *   ③ 算完小蒙版后放大回当前底图尺寸（软边掩码经得起双线性放大）。
 *
 * ⚠️ 读像素 / 放大都要 `willReadFrequently`，否则 Canvas 会在 GPU / CPU
 *   之间来回搬，第一次点颜色就明显卡一下。
 */
import { makeCanvas } from '../core/canvas'
import { colorRangeMaskPixels, type ColorRangeOptions } from '../core/colorRange'
import type { Rgb } from '../core/colorMatch'

export const COLOR_RANGE_MAX_SIDE = 1280

export type ColorSource = {
  data: Uint8ClampedArray
  width: number
  height: number
}

export function prepareColorSource(
  source: ImageBitmap, maxSide = COLOR_RANGE_MAX_SIDE,
): ColorSource {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height))
  const width = Math.max(1, Math.round(source.width * scale))
  const height = Math.max(1, Math.round(source.height * scale))
  const { ctx } = makeCanvas(width, height, '选不了颜色范围', { willReadFrequently: true })
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, width, height)
  return {
    data: ctx.getImageData(0, 0, width, height).data,
    width,
    height,
  }
}

/** 在缓存图上取一小块的平均色（归一化坐标）。 */
export function sampleColorSource(src: ColorSource, nx: number, ny: number): Rgb {
  const cx = Math.min(src.width - 1, Math.max(0, Math.floor(nx * src.width)))
  const cy = Math.min(src.height - 1, Math.max(0, Math.floor(ny * src.height)))
  const radius = Math.max(1, Math.round(Math.min(src.width, src.height) * 0.005))
  const x0 = Math.max(0, cx - radius)
  const y0 = Math.max(0, cy - radius)
  const x1 = Math.min(src.width, cx + radius + 1)
  const y1 = Math.min(src.height, cy + radius + 1)
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * src.width + x) * 4
      r += src.data[i]!
      g += src.data[i + 1]!
      b += src.data[i + 2]!
      n++
    }
  }
  return n > 0 ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0]
}

/** 小图蒙版 → 当前底图尺寸。尺寸相同就直接返回，不做无谓的画布往返。 */
export function upscaleMask(
  mask: Uint8Array, src: ColorSource, width: number, height: number,
): Uint8Array {
  if (src.width === width && src.height === height) return mask
  const gray = makeCanvas(src.width, src.height, '放不大颜色范围').ctx
  const img = gray.createImageData(src.width, src.height)
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i]!
    const p = i * 4
    img.data[p] = v
    img.data[p + 1] = v
    img.data[p + 2] = v
    img.data[p + 3] = 255
  }
  gray.putImageData(img, 0, 0)

  const dst = makeCanvas(width, height, '放不大颜色范围', { willReadFrequently: true }).ctx
  dst.imageSmoothingQuality = 'high'
  dst.drawImage(gray.canvas, 0, 0, width, height)
  const data = dst.getImageData(0, 0, width, height).data
  const out = new Uint8Array(width * height)
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4]!
  return out
}

export function maskFromColorSource(
  src: ColorSource, target: readonly [number, number, number],
  opts: ColorRangeOptions, width: number, height: number,
): Uint8Array {
  const small = colorRangeMaskPixels(src.data, src.width, src.height, target, opts)
  return upscaleMask(small, src, width, height)
}
