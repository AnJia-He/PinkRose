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

/**
 * 八个参数在**界面上**叫什么。
 *
 * ⚠️ **这是唯一的一份。** 微调面板和作品详情页都从这里取 ——
 * 两处各写一份的话一定会漂，而漂了之后没人会发现（两边各自都"看起来对"）。
 * `src/ui/AdjustmentPanel.test.ts` 会读面板的源码，断言它没有自己写死一份。
 *
 * `exposure` 显示成「亮度」而不是「曝光」，两条理由（§3.5.2）：
 * - 我们的用户（醒图 / 美图那一类）**找的是「亮度」**，找不着，教学就断在这儿
 * - **Lightroom 里"曝光"是 EV（-5.00 ~ +5.00）**，而我们是 -100 ~ +100 ——
 *   挂在"曝光"这个名字下会让用过 Lightroom 的人**误判数量级**
 *
 * ⚠️ **只改显示名，字段名 `exposure` 一个字不动** —— 改字段名会牵动 shader。
 */
export const PARAM_LABELS: Record<keyof Adjustments, string> = {
  exposure: '亮度',
  contrast: '对比度',
  highlights: '高光',
  shadows: '阴影',
  saturation: '饱和度',
  temperature: '色温',
  clarity: '清晰度',
  vignette: '暗角',
}

/**
 * 全零参数。
 *
 * Object.freeze 是必须的：它是模块级单例，被 React state 按引用持有、
 * 又被当成重置目标（`setParams(ZERO)`）。谁要是原地改了它（`ZERO.x = 1`），
 * 污染的是所有人的重置目标，而且现象极难查。冻结后这类写法会立刻报错。
 * 正常的更新路径（`{...ZERO, x: 1}`）不受影响。
 */
export const ZERO: Adjustments = Object.freeze({
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  saturation: 0, temperature: 0, clarity: 0, vignette: 0,
})

/** 参数统一范围：[-100, 100] */
export const PARAM_MIN = -100
export const PARAM_MAX = 100

/**
 * 非有限值（NaN / ±Infinity）一律当中立 0。
 *
 * 只写 Math.min(100, NaN) 是没用的——结果还是 NaN，它会一路穿过
 * clampAdjustments / toUnit 进到 shader uniform 里，画面整体坏掉且无从排查。
 */
const clampOne = (v: number): number =>
  Number.isFinite(v) ? Math.max(PARAM_MIN, Math.min(PARAM_MAX, v)) : 0

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
    exposure: c.exposure / PARAM_MAX,
    contrast: c.contrast / PARAM_MAX,
    highlights: c.highlights / PARAM_MAX,
    shadows: c.shadows / PARAM_MAX,
    saturation: c.saturation / PARAM_MAX,
    temperature: c.temperature / PARAM_MAX,
    clarity: c.clarity / PARAM_MAX,
    vignette: c.vignette / PARAM_MAX,
  }
}
