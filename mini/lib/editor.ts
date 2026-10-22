import type { Adjustments } from './shared/adjustments'

/** 编辑页当前展开的工具；null = 收起所有工具面板。 */
export type EditorTool = 'ai' | 'tone' | 'portrait' | 'crop' | null

/** 手动调色面板的三组参数。 */
export type ToneGroup = 'basic' | 'light' | 'color'

export const TONE_GROUPS: Record<ToneGroup, readonly (keyof Adjustments)[]> = {
  basic: ['exposure', 'contrast', 'saturation'],
  light: ['highlights', 'shadows'],
  color: ['temperature'],
}

export const PORTRAIT_KEYS: readonly (keyof Adjustments)[] = [
  'skinSmooth',
  'skinBrighten',
  'skinRosy',
]

/** 只把指定参数归零，返回新对象；页面参数永远不原地改。 */
export function resetKeys<T extends Partial<Adjustments>>(
  params: T,
  keys: readonly (keyof Adjustments)[],
): T {
  const next = { ...params }
  for (const key of keys) next[key] = 0
  return next
}

/**
 * 按 0–100 强度缩放一整套预设。
 * 每次都从预设原值计算，不能拿已经混合过的参数反复再乘。
 */
export function mixPreset(
  amount: number,
  preset: Partial<Adjustments>,
): Partial<Adjustments> {
  const factor = Math.max(0, Math.min(100, Number.isFinite(amount) ? amount : 0)) / 100
  const out: Partial<Adjustments> = {}
  for (const key of Object.keys(preset) as (keyof Adjustments)[]) {
    const value = preset[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value * factor
  }
  return out
}
