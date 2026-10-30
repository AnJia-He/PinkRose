import { HSL_BANDS } from '../../shared/adjustments.ts'
import type { Rgb } from './colorMatch'

export type HslBandId = (typeof HSL_BANDS)[number]['id']

export type HslBandPick = {
  id: HslBandId
  label: string
  hue: number
}

/**
 * 把照片上取到的一个颜色映射到最近的 HSL 色带。
 *
 * 只做「选哪条色带」这一件事；三根滑杆仍然写真实的 `hslXxx` 参数。
 * 太灰（没有可靠色相）或太暗（色相噪声大）的颜色返回 null，让调用方
 * 明确请用户换一块有颜色的地方，而不是硬猜一条色带。
 */
export function hslBandForRgb(
  rgb: Rgb, minSaturation = 0.12, minValue = 0.08,
): HslBandPick | null {
  const r = rgb[0] / 255
  const g = rgb[1] / 255
  const b = rgb[2] / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (max < minValue || (max > 0 && delta / max < minSaturation)) return null

  let hue: number
  if (delta <= 1e-9) return null
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  hue = ((hue / 6) % 1 + 1) % 1

  let best: (typeof HSL_BANDS)[number] = HSL_BANDS[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const band of HSL_BANDS) {
    const raw = Math.abs(hue - band.hue)
    const distance = Math.min(raw, 1 - raw)
    if (distance < bestDistance) {
      bestDistance = distance
      best = band
    }
  }
  return { id: best.id, label: best.label, hue: best.hue }
}
