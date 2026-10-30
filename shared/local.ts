/**
 * **可回改局部层的共享数据模型**（★ 2026-10-19）。
 *
 * 和服务端共用的只有「怎么校验 / 怎么归一化」这一层：本地像素引擎在
 * `src/image/localAdjust.ts`，这里不 import 任何浏览器代码。
 *
 * 一条局部层 = 一张掩码 PNG + 一组局部参数。掩码按最长边压到 1280 再存，
 * 软边画笔在放大回原图时由浏览器做双线性插值，肉眼看不出差别；换来的是一条
 * 会话里的蒙版体积可控（body 上限 12 MB）。
 */

export type LocalEffect =
  'tone' | 'teeth' | 'eyes' | 'redeye' | 'hair' | 'eyeshadow' | 'eyebrow'
  | 'iris' | 'wrinkle' | 'darkcircle' | 'contour' | 'highlight' | 'aegyoSal' | 'eyeliner'
  | 'antiglare' | 'blur' | 'motionBlur' | 'mosaic' | 'dodge' | 'burn'

/** 减淡 / 加深作用的亮度范围。 */
export type ToneRange = 'shadows' | 'midtones' | 'highlights'

export type HairShadeId = 'natural' | 'brown' | 'flaxen' | 'wine' | 'blue' | 'rose'
export type EyeShadowShadeId = 'earth' | 'coral' | 'rose' | 'violet' | 'blue' | 'champagne'
export type EyebrowShadeId = 'black' | 'brown' | 'ash' | 'auburn'
export type ContourShadeId = 'cool' | 'warm' | 'ash'
export type HighlightShadeId = 'champagne' | 'pearl' | 'peach'
export type AegyoSalShadeId = 'pearl' | 'champagne' | 'peach'
export type EyelinerShadeId = 'black' | 'brown' | 'charcoal'
export type IrisShadeId = 'brown' | 'gray' | 'blue' | 'green' | 'violet' | 'amber'

export type LocalAdjustOptions = {
  /** 这些色调滑杆都是 -100 ~ 100；0 = 不动。 */
  exposure?: number
  contrast?: number
  saturation?: number
  temperature?: number
  tint?: number
  whites?: number
  blacks?: number
  dehaze?: number
  highlights?: number
  shadows?: number
  vibrance?: number
  clarity?: number
  /** 局部效果：默认调色；固定预设忽略上面四个滑杆值。 */
  effect?: LocalEffect
  /** 固定预设的强度 0~100。 */
  effectStrength?: number
  /** 减淡 / 加深作用范围；缺省 = 中间调。 */
  toneRange?: ToneRange
  /** 动感模糊方向：0 = 水平、90 = 垂直，0~360 度。 */
  angle?: number
  hairShade?: HairShadeId
  eyeShadowShade?: EyeShadowShadeId
  eyebrowShade?: EyebrowShadeId
  contourShade?: ContourShadeId
  highlightShade?: HighlightShadeId
  aegyoSalShade?: AegyoSalShadeId
  eyelinerShade?: EyelinerShadeId
  irisShade?: IrisShadeId
}

export type LocalColorRange = {
  target: readonly [number, number, number]
  tolerance: number
  feather: number
  /** 反选：选中的是"和这个颜色不相近"的部分。 */
  invert?: boolean
  /** 蒙版扩展 / 收缩（图片像素，正数外扩、负数内收）。 */
  edge?: number
  /** 只选和点击种子相连的同色区域。 */
  connected?: boolean
  /** 归一化点击种子；用于回改容差 / 羽化时保持同一块。 */
  seed?: readonly [number, number]
}

export type LocalLuminanceRange = {
  /** 主选区落在阴影 / 中间调 / 高光。 */
  range: ToneRange
  /** 0~100：选区覆盖宽度；越大，相邻亮度也一起选进来。 */
  width: number
  /** 0~100：亮度边缘过渡。 */
  feather: number
  invert?: boolean
  edge?: number
}

export type LocalLayer = {
  kind: 'local'
  id: string
  /** 缺省 = 显示；false = 暂时不参与渲染（层还留着，随时能打开）。 */
  visible?: boolean
  /** 灰度掩码 PNG data URL；灰度写在 R 通道，alpha 固定 255。 */
  mask: string
  /** 掩码自己的像素尺寸（不是底图尺寸）。 */
  maskWidth: number
  maskHeight: number
  /** 0~100：渲染时按底图短边再柔化一圈。 */
  feather: number
  /** 0~100：整层不透明度；缺省 100。 */
  opacity?: number
  options: LocalAdjustOptions
  /** 如果是「色彩范围」选出来的：把取色参数也带上，回来还能调容差。 */
  color?: LocalColorRange
  /** 如果是「明暗范围」选出来的：把亮度范围和软边参数带上。 */
  luminance?: LocalLuminanceRange
}

const EFFECTS: readonly LocalEffect[] = [
  'tone', 'teeth', 'eyes', 'redeye', 'hair', 'eyeshadow', 'eyebrow',
  'iris', 'wrinkle', 'darkcircle', 'contour', 'highlight', 'aegyoSal', 'eyeliner',
  'antiglare', 'blur', 'motionBlur', 'mosaic', 'dodge', 'burn',
]
const TONE_RANGES: readonly ToneRange[] = ['shadows', 'midtones', 'highlights']
const HAIR: readonly HairShadeId[] = ['natural', 'brown', 'flaxen', 'wine', 'blue', 'rose']
const EYE_SHADOW: readonly EyeShadowShadeId[] =
  ['earth', 'coral', 'rose', 'violet', 'blue', 'champagne']
const EYEBROW: readonly EyebrowShadeId[] = ['black', 'brown', 'ash', 'auburn']
const CONTOUR: readonly ContourShadeId[] = ['cool', 'warm', 'ash']
const HIGHLIGHT: readonly HighlightShadeId[] = ['champagne', 'pearl', 'peach']
const AEGYO_SAL: readonly AegyoSalShadeId[] = ['pearl', 'champagne', 'peach']
const EYELINER: readonly EyelinerShadeId[] = ['black', 'brown', 'charcoal']
const IRIS: readonly IrisShadeId[] = ['brown', 'gray', 'blue', 'green', 'violet', 'amber']

/** 一条掩码 data URL 的字符上限。1280 长边的画笔掩码通常远小于它。 */
export const LOCAL_MASK_MAX_CHARS = 2_000_000
/** 掩码最长边（存的时候压到它以内）。 */
export const LOCAL_MASK_MAX_SIDE = 1280
/** 一版最多几个可回改局部层。 */
export const LOCAL_LAYERS_MAX = 8
/** 一版所有局部层掩码加起来的上限（字符）。 */
export const LOCAL_MASKS_TOTAL_MAX = 6_000_000

const num = (v: unknown, fallback = 0): number =>
  Number.isFinite(Number(v)) ? Number(v) : fallback
const clamp = (v: unknown, min: number, max: number): number =>
  Math.max(min, Math.min(max, num(v)))
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback

export function normalizeLocalAdjustOptions(input: unknown): LocalAdjustOptions {
  const o = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
  const effect = pick(o.effect, EFFECTS, 'tone')
  const out: LocalAdjustOptions = { effect }
  if (effect === 'tone') {
    out.exposure = clamp(o.exposure, -100, 100)
    out.contrast = clamp(o.contrast, -100, 100)
    out.saturation = clamp(o.saturation, -100, 100)
    out.temperature = clamp(o.temperature, -100, 100)
    out.tint = clamp(o.tint, -100, 100)
    out.whites = clamp(o.whites, -100, 100)
    out.blacks = clamp(o.blacks, -100, 100)
    out.dehaze = clamp(o.dehaze, -100, 100)
    out.highlights = clamp(o.highlights, -100, 100)
    out.shadows = clamp(o.shadows, -100, 100)
    out.vibrance = clamp(o.vibrance, -100, 100)
    out.clarity = clamp(o.clarity, -100, 100)
    return out
  }
  out.effectStrength = clamp(o.effectStrength ?? 60, 0, 100)
  if (effect === 'dodge' || effect === 'burn') {
    out.toneRange = pick(o.toneRange, TONE_RANGES, 'midtones')
  }
  if (effect === 'motionBlur') out.angle = clamp(o.angle, 0, 360)
  if (effect === 'hair') out.hairShade = pick(o.hairShade, HAIR, 'brown')
  if (effect === 'eyeshadow') out.eyeShadowShade = pick(o.eyeShadowShade, EYE_SHADOW, 'earth')
  if (effect === 'eyebrow') out.eyebrowShade = pick(o.eyebrowShade, EYEBROW, 'brown')
  if (effect === 'contour') out.contourShade = pick(o.contourShade, CONTOUR, 'cool')
  if (effect === 'highlight') out.highlightShade = pick(o.highlightShade, HIGHLIGHT, 'champagne')
  if (effect === 'aegyoSal') out.aegyoSalShade = pick(o.aegyoSalShade, AEGYO_SAL, 'pearl')
  if (effect === 'eyeliner') out.eyelinerShade = pick(o.eyelinerShade, EYELINER, 'black')
  if (effect === 'iris') out.irisShade = pick(o.irisShade, IRIS, 'brown')
  return out
}

/** 这组参数会不会改变任何像素。全零 / 强度 0 的层没有存的必要。 */
export function isNoopLocalOptions(options: LocalAdjustOptions): boolean {
  if ((options.effect ?? 'tone') === 'tone') {
    return !options.exposure && !options.contrast && !options.saturation && !options.temperature
      && !options.tint
      && !options.whites && !options.blacks
      && !options.dehaze
      && !options.highlights && !options.shadows
      && !options.vibrance && !options.clarity
  }
  return !(options.effectStrength ?? 60)
}

export function normalizeLocalLayer(input: unknown): LocalLayer | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const o = input as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  if (typeof o.mask !== 'string' || !o.mask.startsWith('data:image/')) return null
  if (o.mask.length > LOCAL_MASK_MAX_CHARS) return null
  const maskWidth = Math.round(num(o.maskWidth))
  const maskHeight = Math.round(num(o.maskHeight))
  if (maskWidth < 16 || maskHeight < 16
    || maskWidth > LOCAL_MASK_MAX_SIDE * 2 || maskHeight > LOCAL_MASK_MAX_SIDE * 2) return null
  const options = normalizeLocalAdjustOptions(o.options)
  if (isNoopLocalOptions(options)) return null
  let color: LocalColorRange | undefined
  if (o.color && typeof o.color === 'object' && !Array.isArray(o.color)) {
    const c = o.color as Record<string, unknown>
    if (Array.isArray(c.target) && c.target.length === 3
      && c.target.every(v => Number.isFinite(Number(v)))) {
      color = {
        target: [
          Math.round(clamp(c.target[0], 0, 255)),
          Math.round(clamp(c.target[1], 0, 255)),
          Math.round(clamp(c.target[2], 0, 255)),
        ],
        tolerance: clamp(c.tolerance, 0, 100),
        feather: clamp(c.feather, 0, 100),
        ...(c.invert === true ? { invert: true } : {}),
        ...(Number(c.edge) ? { edge: clamp(c.edge, -64, 64) } : {}),
        ...(c.connected === true ? { connected: true } : {}),
        ...(Array.isArray(c.seed) && c.seed.length === 2
          && c.seed.every(v => Number.isFinite(Number(v)))
          ? {
            seed: [
              Math.round(clamp(c.seed[0], 0, 1) * 1000) / 1000,
              Math.round(clamp(c.seed[1], 0, 1) * 1000) / 1000,
            ] as const,
          }
          : {}),
      }
    }
  }
  let luminance: LocalLuminanceRange | undefined
  if (o.luminance && typeof o.luminance === 'object' && !Array.isArray(o.luminance)) {
    const l = o.luminance as Record<string, unknown>
    luminance = {
      range: pick(l.range, TONE_RANGES, 'midtones'),
      width: clamp(l.width ?? 35, 0, 100),
      feather: clamp(l.feather ?? 30, 0, 100),
      ...(l.invert === true ? { invert: true } : {}),
      ...(Number(l.edge) ? { edge: clamp(l.edge, -64, 64) } : {}),
    }
  }
  return {
    kind: 'local',
    id: o.id.slice(0, 64),
    mask: o.mask,
    maskWidth,
    maskHeight,
    feather: clamp(o.feather, 0, 100),
    ...(o.opacity === undefined ? {} : { opacity: clamp(o.opacity, 0, 100) }),
    options,
    ...(color ? { color } : {}),
    ...(luminance ? { luminance } : {}),
  }
}
