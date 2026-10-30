import { PARAM_RANGE } from '../../shared/adjustments.ts'
import type { Rgb } from './colorMatch'

/**
 * **一键自动**（★ 2026-10-17）—— 本地读一张缩小的底图，给出一组保守的
 * 曝光 / 对比度 / 高光 / 阴影 / 饱和度 / 自然饱和度 / 轻微白平衡。
 *
 * 它不做「识别这是什么照片」那类魔法：只按直方图和灰度世界假设，
 * 把过暗、过亮、发灰、偏色的常见问题往中间拉一点。所有值都夹在
 * `PARAM_RANGE` 里，并取整到滑块的一格。
 *
 * ⚠️ 它只产出**这八个键**：调用方用 `{...当前参数, ...result}` 覆盖这八项，
 *   清晰度、暗角、HSL、曲线、透视、镜头虚化等用户自己的选择原样保留。
 *   这样自动不会把一张已经精心调过的图重置成"平均照片"。
 */
export const AUTO_KEYS = [
  'temperature', 'exposure', 'contrast', 'highlights', 'shadows',
  'saturation', 'vibrance', 'cbMagentaGreen',
] as const

export type AutoTone = { [K in typeof AUTO_KEYS[number]]: number }

const ZERO_AUTO: AutoTone = {
  temperature: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  saturation: 0, vibrance: 0, cbMagentaGreen: 0,
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const luma = ([r, g, b]: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))]!

/**
 * `samples` 是 0~255 的 sRGB 采样（`image/sample.ts` 的产物）。
 * 空数组 = 没有可靠数据，返回全 0，绝不凭空猜一组参数。
 */
export function autoAdjustments(samples: readonly Rgb[]): AutoTone {
  if (samples.length === 0) return { ...ZERO_AUTO }

  const lumas = samples.map(luma).sort((a, b) => a - b)
  const p05 = quantile(lumas, 0.05)
  const median = quantile(lumas, 0.5)
  const p95 = quantile(lumas, 0.95)

  let sr = 0
  let sg = 0
  let sb = 0
  let chroma = 0
  for (const [r, g, b] of samples) {
    sr += r
    sg += g
    sb += b
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    chroma += (mx - mn) / 255
  }
  const n = samples.length
  const meanR = sr / n / 255
  const meanG = sg / n / 255
  const meanB = sb / n / 255
  const meanChroma = chroma / n
  const nearMono = meanChroma < 0.02
  const spread = p95 - p05

  const exposure = clamp(60 * Math.log2(0.48 / Math.max(median, 0.03)), -40, 45)
  // 曝光和对比度会互相抵消：暗图提亮之后，再按原来的"平图就加 32 对比"
  // 会把中灰又压回去（真机实测：曝光 +45、对比 +32，中间调反而更暗）。
  // 提亮越多，对比度就收得越多；暗部也不要再往下压。
  const contrast = clamp(
    clamp((0.62 - spread) * 90, -18, 32) - Math.max(0, exposure) * 0.65,
    -18, 32,
  )
  const highlights = clamp((0.88 - p95) * 90, -22, 12)
  const shadows = clamp((0.12 - p05) * 90 + Math.max(0, exposure) * 0.1, -10, 20)
  const saturation = nearMono ? 0 : clamp((0.30 - meanChroma) * 55, -12, 18)
  const vibrance = nearMono ? 0 : clamp((0.28 - meanChroma) * 35, -8, 10)

  // 灰度世界：只在整体明显偏色时轻轻回拉，夕阳 / 夜景不会被强行染回中性。
  const temperature = clamp((meanB - meanR) * 40, -12, 12)
  const cbMagentaGreen = clamp((meanG - (meanR + meanB) / 2) * -30, -8, 8)

  const out: AutoTone = {
    temperature: Math.round(temperature),
    exposure: Math.round(exposure),
    contrast: Math.round(contrast),
    highlights: Math.round(highlights),
    shadows: Math.round(shadows),
    saturation: Math.round(saturation),
    vibrance: Math.round(vibrance),
    cbMagentaGreen: Math.round(cbMagentaGreen),
  }
  // 范围表是唯一的上界来源；上面的 clamp 是算法自己的保守边界，
  // 这里再对一次防止将来改了算法忘了范围。
  for (const k of AUTO_KEYS) {
    const [lo, hi] = PARAM_RANGE[k]
    out[k] = clamp(out[k], lo, hi)
  }
  return out
}
