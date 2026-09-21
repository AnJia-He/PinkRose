export type Adjustments = {
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  saturation: number
  temperature: number
  clarity: number
  vignette: number
}

export const PARAM_KEYS = [
  'exposure', 'contrast', 'highlights', 'shadows',
  'saturation', 'temperature', 'clarity', 'vignette',
] as const satisfies readonly (keyof Adjustments)[]

export const ZERO: Adjustments = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  saturation: 0, temperature: 0, clarity: 0, vignette: 0,
}

/** 参数统一范围：[-100, 100] */
export const PARAM_MIN = -100
export const PARAM_MAX = 100

const clampOne = (v: number): number =>
  Math.max(PARAM_MIN, Math.min(PARAM_MAX, v))

/** 把八个字段各自钳到 [-100, 100]。纯函数，不改入参。 */
export function clampAdjustments(a: Adjustments): Adjustments {
  return {
    exposure: clampOne(a.exposure),
    contrast: clampOne(a.contrast),
    highlights: clampOne(a.highlights),
    shadows: clampOne(a.shadows),
    saturation: clampOne(a.saturation),
    temperature: clampOne(a.temperature),
    clarity: clampOne(a.clarity),
    vignette: clampOne(a.vignette),
  }
}

/**
 * 把增量叠加到当前值上，再整体钳制。
 *
 * 为什么用增量而不是绝对值：LLM 做算术是经典翻车点。
 * 让它说"再暖一点 = +20"，累加和钳制交给这里的确定性代码。
 */
export function applyDeltas(base: Adjustments, deltas: Partial<Adjustments>): Adjustments {
  const out = { ...base }
  for (const k of PARAM_KEYS) {
    const d = deltas[k]
    if (typeof d === 'number') out[k] = out[k] + d
  }
  return clampAdjustments(out)
}

/** 换算到 [-1, 1]，供着色器 uniform 使用。 */
export function toUnit(a: Adjustments): Record<keyof Adjustments, number> {
  const c = clampAdjustments(a)
  return {
    exposure: c.exposure / 100,
    contrast: c.contrast / 100,
    highlights: c.highlights / 100,
    shadows: c.shadows / 100,
    saturation: c.saturation / 100,
    temperature: c.temperature / 100,
    clarity: c.clarity / 100,
    vignette: c.vignette / 100,
  }
}
