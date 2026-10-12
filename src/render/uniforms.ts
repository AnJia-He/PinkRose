import { toUnit, type Adjustments } from '../../shared/adjustments.ts'

/**
 * 「15 个调色参数 → 15 个 uniform 名字」的**唯一一份**映射：web 管线与小程序版
 * 管线共用同一份（本文件会被 `scripts/sync-mini-shared.mjs` 原样拷进小程序，
 * 两边各写一份一定会漂）。
 *
 * ⚠️ 正因如此，这里**不许 import 任何平台东西**：不碰 DOM、不碰 gl，
 * 只依赖 `shared/adjustments.ts`。
 */
export const UNIFORM_NAMES = [
  'uExposure', 'uContrast', 'uHighlights', 'uShadows',
  'uSaturation', 'uTemperature', 'uClarity', 'uVignette',
  'uVibrance', 'uCbCyanRed', 'uCbMagentaGreen', 'uCbYellowBlue',
  'uSplitHiHue', 'uSplitLoHue', 'uSplitAmount',
] as const

export type UniformName = typeof UNIFORM_NAMES[number]

/**
 * 入参是 `[-100, 100]` 的原始参数，不是 `[-1, 1]` 的 Unit：
 * 两者结构相同，传错了（比如 exposure: 100）类型也过，但画面会算成 2^100。
 * `toUnit`（「原始 → Unit」的唯一换算入口）只在这里调一次。
 */
export function uniformValues(a: Adjustments): Record<UniformName, number> {
  const u = toUnit(a)
  return {
    uExposure: u.exposure, uContrast: u.contrast, uHighlights: u.highlights,
    uShadows: u.shadows, uSaturation: u.saturation, uTemperature: u.temperature,
    uClarity: u.clarity, uVignette: u.vignette, uVibrance: u.vibrance,
    uCbCyanRed: u.cbCyanRed, uCbMagentaGreen: u.cbMagentaGreen, uCbYellowBlue: u.cbYellowBlue,
    uSplitHiHue: u.splitHiHue, uSplitLoHue: u.splitLoHue, uSplitAmount: u.splitAmount,
  }
}
