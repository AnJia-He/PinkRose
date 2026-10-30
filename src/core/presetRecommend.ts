import { PRESETS } from './presets'
import type { Rgb } from './colorMatch'

/**
 * 「推荐」的本地预设建议。
 *
 * 这不是场景识别模型，只看 96px 采样里的亮度、反差、彩度、暖色倾向和
 * 肤色比例，给一个**可解释的起点**。用户点完仍可继续拖滑杆，或者从左侧
 * 预设栏另选一套。空采样返回 null，绝不在没有数据时猜。
 */
export type PresetRecommendation = {
  id: string
  label: string
}

const luma = ([r, g, b]: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))]!

function isSkin([r, g, b]: Rgb): boolean {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const cb = -0.168736 * rr - 0.331264 * gg + 0.5 * bb + 0.5
  const cr = 0.5 * rr - 0.418688 * gg - 0.081312 * bb + 0.5
  return cb >= 0.28 && cb <= 0.54 && cr >= 0.50 && cr <= 0.72
    && luma([r, g, b]) > 0.08
}

export function recommendPreset(samples: readonly Rgb[]): PresetRecommendation | null {
  if (samples.length === 0) return null

  const lumas = samples.map(luma).sort((a, b) => a - b)
  const meanLuma = lumas.reduce((sum, v) => sum + v, 0) / lumas.length
  const spread = quantile(lumas, 0.95) - quantile(lumas, 0.05)
  let sr = 0
  let sg = 0
  let sb = 0
  let chroma = 0
  let skin = 0
  for (const sample of samples) {
    const [r, g, b] = sample
    sr += r
    sg += g
    sb += b
    chroma += (Math.max(r, g, b) - Math.min(r, g, b)) / 255
    if (isSkin(sample)) skin++
  }
  const n = samples.length
  const meanR = sr / n / 255
  const meanG = sg / n / 255
  const meanB = sb / n / 255
  const meanChroma = chroma / n
  const skinRatio = skin / n
  const warmth = meanR - meanB
  const coolNature = (meanG + meanB) / 2 > meanR * 1.08

  let id: string
  if (meanChroma < 0.018) id = 'bw'
  else if (meanLuma < 0.22 && skinRatio < 0.08) id = 'night'
  else if (skinRatio > 0.12 && meanR > meanB && meanChroma < 0.34) id = 'portrait'
  else if (warmth > 0.08 && meanLuma > 0.38 && meanChroma > 0.18) id = 'golden'
  else if (spread < 0.30 && meanLuma > 0.62) id = 'jp-clean'
  else if (meanChroma > 0.24 && !coolNature) id = 'vivid'
  else if (spread > 0.55 && meanLuma < 0.46) id = 'moody'
  else if (skinRatio < 0.07 && coolNature && meanChroma > 0.08) {
    id = meanLuma < 0.42 ? 'hdr-landscape' : 'landscape'
  } else if (warmth > 0.04 && meanLuma > 0.52 && meanChroma < 0.16) id = 'cream'
  else if (spread > 0.42) id = 'crisp'
  else if (meanLuma < 0.46) id = 'bright'
  else id = 'jp-clean'

  const preset = PRESETS.find(p => p.id === id)
  return preset ? { id: preset.id, label: preset.label } : null
}
