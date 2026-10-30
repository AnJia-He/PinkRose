import {
  CURVE_KEYS, RGB_CURVE_CHANNELS, type Adjustments,
} from '../../shared/adjustments.ts'

/**
 * 影调曲线的五个控制点（★ 2026-10-17）。
 *
 * 五根参数不是五根普通滑杆，而是曲线在 x = 0 / .25 / .5 / .75 / 1 处的
 * 纵向位移：
 *   · `curveBlack` 只能把黑场**向上抬**（负值无意义，夹回 0）；
 *   · `curveWhite` 只能把白场**向下压**（正值无意义，夹回 0）；
 *   · 中间三个点可以在 ±100 内上下走。
 *
 * 控制点算完后再做一次单调夹取：用户把阴影拖到中间调上面时，曲线不会
 * 翻折成 S 形倒挂（渲染出来会像坏掉）。着色器里的同一段逻辑在
 * `render/shader.ts` 的 `curveAt()`，两边必须保持同一组常数。
 */
export const CURVE_POINTS = [0, 0.25, 0.5, 0.75, 1] as const
export type CurvePoints = [number, number, number, number, number]
export type CurveChannel = 'rgb' | 'red' | 'green' | 'blue'
export type CurvePresetId = 'soft' | 'contrast' | 'matte' | 'lift'
export type CurvePreset = {
  id: CurvePresetId
  label: string
  values: CurvePoints
}

/**
 * 一个通道的五个参数键。`rgb` 是整体影调曲线，红 / 绿 / 蓝是分通道曲线。
 * `ToneCurve` 和着色器共用这份映射，别在组件里另抄一份。
 */
export const CHANNEL_CURVE_KEYS: Record<CurveChannel, readonly (keyof Adjustments)[]> = {
  rgb: CURVE_KEYS,
  red: RGB_CURVE_CHANNELS[0].keys,
  green: RGB_CURVE_CHANNELS[1].keys,
  blue: RGB_CURVE_CHANNELS[2].keys,
}

/** 预设值直接使用参数量纲，避免 UI 再维护一套 0~1 的反解。 */
export const CURVE_PRESETS: readonly CurvePreset[] = [
  { id: 'soft', label: '柔和 S', values: [0, -12, 0, 12, 0] },
  { id: 'contrast', label: '强对比', values: [4, -28, 0, 28, -4] },
  { id: 'matte', label: '哑光', values: [12, 6, -6, -10, -12] },
  { id: 'lift', label: '提亮', values: [0, 6, 12, 8, 0] },
]

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** 某个通道的五个参数 → 五个 y 控制点（0~1，按 x 单调不减）。 */
export function channelCurvePoints(a: Adjustments, channel: CurveChannel): CurvePoints {
  const keys = CHANNEL_CURVE_KEYS[channel]
  const y: CurvePoints = [
    clamp(Math.max(0, a[keys[0]!]!) / 100 * 0.25, 0, 1),
    clamp(0.25 + a[keys[1]!]! / 100 * 0.25, 0, 1),
    clamp(0.5 + a[keys[2]!]! / 100 * 0.25, 0, 1),
    clamp(0.75 + a[keys[3]!]! / 100 * 0.25, 0, 1),
    clamp(1 + Math.min(0, a[keys[4]!]!) / 100 * 0.25, 0, 1),
  ]
  for (let i = 1; i < y.length; i++) y[i] = Math.max(y[i]!, y[i - 1]!)
  return y
}

/** 整体影调曲线（老调用点保持不变）。 */
export function curvePoints(a: Adjustments): CurvePoints {
  return channelCurvePoints(a, 'rgb')
}

/**
 * 拖点反解：把某个控制点的 y（0~1）换算回参数值。
 * 黑场 / 白场只接受各自有意义的半个方向，越界夹回 0。
 */
export function paramForChannelCurveY(
  _channel: CurveChannel, index: 0 | 1 | 2 | 3 | 4, y: number,
): number {
  const v = clamp(y, 0, 1)
  if (index === 0) return Math.round(clamp(v / 0.25 * 100, 0, 100))
  if (index === 4) return Math.round(clamp((v - 1) / 0.25 * 100, -100, 0))
  return Math.round(clamp((v - CURVE_POINTS[index]!) / 0.25 * 100, -100, 100))
}

export function paramForCurveY(index: 0 | 1 | 2 | 3 | 4, y: number): number {
  return paramForChannelCurveY('rgb', index, y)
}

/**
 * 曲线在 x（0~1）处的 y。段内用 smoothstep，控制点处精确落点。
 * 全零时曲线不会进入渲染（`uCurveOn` 为 0），所以这里不需要为恒等做特判。
 */
export function channelCurveValueAt(a: Adjustments, channel: CurveChannel, x: number): number {
  const ys = channelCurvePoints(a, channel)
  if (x <= 0) return ys[0]!
  if (x >= 1) return ys[4]!
  const i = Math.min(3, Math.floor(x * 4))
  const t = (x - CURVE_POINTS[i]!) / 0.25
  const s = t * t * (3 - 2 * t)
  return ys[i]! + (ys[i + 1]! - ys[i]!) * s
}

export function curveValueAt(a: Adjustments, x: number): number {
  return channelCurveValueAt(a, 'rgb', x)
}

/** 五个控制点里有没有一个动过 —— 和 `uCurveOn` 同一个判据。 */
export function channelCurveActive(a: Adjustments, channel: CurveChannel): boolean {
  return CHANNEL_CURVE_KEYS[channel].some(k => a[k] !== 0)
}

export function curveActive(a: Adjustments): boolean {
  return channelCurveActive(a, 'rgb')
}

/** 把一套预设写到指定通道；曝光和其他通道保持原样。 */
export function applyChannelCurvePreset(
  a: Adjustments, channel: CurveChannel, id: CurvePresetId,
): Adjustments {
  const preset = CURVE_PRESETS.find(item => item.id === id)
  if (!preset) return a
  const patch: Partial<Adjustments> = {}
  CHANNEL_CURVE_KEYS[channel].forEach((key, index) => {
    patch[key] = preset.values[index]!
  })
  return { ...a, ...patch }
}
