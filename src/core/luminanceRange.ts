import type { ToneRange } from '../../shared/local.ts'

/**
 * **按亮度选蒙版**（★ 2026-10-22）。
 *
 * 主流修图软件里的 Luminance Range Mask：先选高光、阴影或中间调，
 * 再用宽度和羽化决定相邻亮度进入多少。它不按颜色判断，所以同一种颜色的
 * 亮部和暗部可以分开处理。
 */
export type LuminanceRangeOptions = {
  range?: ToneRange
  /** 0~100：越大，主亮度两侧覆盖越宽。缺省 35。 */
  width?: number
  /** 0~100：软边过渡。缺省 30。 */
  feather?: number
}

const CENTERS: Record<ToneRange, number> = {
  shadows: 0.18,
  midtones: 0.5,
  highlights: 0.82,
}

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v)
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback))
}

const smoothstep = (t: number): number => {
  const u = Math.max(0, Math.min(1, t))
  return u * u * (3 - 2 * u)
}

/**
 * 返回和照片同尺寸的 0~255 覆盖率。全透明像素不选。
 * 亮度用 sRGB 感知权重；与调色预览的视感接近，但计算完全在本机。
 */
export function luminanceRangeMaskPixels(
  data: Uint8ClampedArray, width: number, height: number,
  opts: LuminanceRangeOptions = {},
): Uint8Array {
  if (data.length < width * height * 4) {
    throw new Error(`像素尺寸和照片对不上（${data.length} 字节，照片 ${width}×${height}）`)
  }
  const range = opts.range && opts.range in CENTERS ? opts.range : 'midtones'
  const center = CENTERS[range]
  const widthSetting = clamp(opts.width, 0, 100, 35) / 100
  const feather = clamp(opts.feather, 0, 100, 30) / 100
  const halfWidth = Math.max(0.01, 0.05 + widthSetting * 0.45)
  const soft = halfWidth * feather
  const inner = Math.max(0, halfWidth - soft)
  const span = Math.max(1e-6, halfWidth - inner)
  const mask = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (data[p + 3]! < 8) continue
    const luma = (
      data[p]! * 0.2126 + data[p + 1]! * 0.7152 + data[p + 2]! * 0.0722
    ) / 255
    const distance = Math.abs(luma - center)
    if (distance <= inner) {
      mask[i] = 255
    } else if (distance < halfWidth) {
      mask[i] = Math.round(255 * (1 - smoothstep((distance - inner) / span)))
    }
  }
  return mask
}
