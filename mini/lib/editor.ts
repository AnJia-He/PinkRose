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

export type AdjustmentRow = {
  key: keyof Adjustments
  label: string
  value: number
  min: number
  max: number
}

type Control = {
  key: keyof Adjustments
  label: string
  min: number
  max: number
}

const TONE_CONTROLS: Record<ToneGroup, readonly Control[]> = {
  basic: [
    { key: 'exposure', label: '亮度', min: -100, max: 100 },
    { key: 'contrast', label: '对比度', min: -100, max: 100 },
    { key: 'saturation', label: '饱和度', min: -100, max: 100 },
  ],
  light: [
    { key: 'highlights', label: '高光', min: -100, max: 100 },
    { key: 'shadows', label: '阴影', min: -100, max: 100 },
  ],
  color: [
    { key: 'temperature', label: '色温', min: -100, max: 100 },
  ],
}

const PORTRAIT_CONTROLS: readonly Control[] = [
  { key: 'skinSmooth', label: '磨皮', min: 0, max: 100 },
  { key: 'skinBrighten', label: '美白', min: 0, max: 100 },
  { key: 'skinRosy', label: '红润', min: 0, max: 100 },
]

/** 当前工具面板该显示的滑杆行（AI / 裁剪没有普通滑杆）。 */
export function rowsForTool(
  tool: EditorTool,
  toneGroup: ToneGroup,
  params: Partial<Adjustments>,
): AdjustmentRow[] {
  const controls = tool === 'tone'
    ? TONE_CONTROLS[toneGroup]
    : tool === 'portrait' ? PORTRAIT_CONTROLS : []
  return controls.map(control => ({
    ...control,
    value: typeof params[control.key] === 'number' ? params[control.key] as number : 0,
  }))
}

/** 写一个参数并钳到滑杆范围；返回新对象，不原地修改。 */
export function setAdjustment<T extends Partial<Adjustments>>(
  params: T,
  key: keyof Adjustments,
  value: number,
): T {
  const all = ([] as Control[]).concat(
    TONE_CONTROLS.basic,
    TONE_CONTROLS.light,
    TONE_CONTROLS.color,
    [...PORTRAIT_CONTROLS],
  )
  const control = all.find(item => item.key === key)
  const min = control ? control.min : -100
  const max = control ? control.max : 100
  const number = Number.isFinite(value) ? value : 0
  return { ...params, [key]: Math.max(min, Math.min(max, number)) }
}

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
