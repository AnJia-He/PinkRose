import { isBlendMode, type BlendMode } from './blend.ts'

export type StickerShape =
  'star' | 'heart' | 'sparkle' | 'arrow' | 'speech'
  | 'flower' | 'cloud' | 'crown' | 'music' | 'lightning' | 'check' | 'sun'
export type StickerSource = 'shape' | 'image'

export const STICKER_PATHS: Record<StickerShape, string> = {
  star: 'M .50 .04 L .61 .35 L .95 .35 L .68 .56 L .79 .91 L .50 .70 L .21 .91 L .32 .56 L .05 .35 L .39 .35 Z',
  heart: 'M .50 .92 C .18 .69 .04 .49 .04 .30 C .04 .12 .28 .07 .50 .28 C .72 .07 .96 .12 .96 .30 C .96 .49 .82 .69 .50 .92 Z',
  sparkle: 'M .50 .02 C .55 .32 .68 .45 .98 .50 C .68 .55 .55 .68 .50 .98 C .45 .68 .32 .55 .02 .50 C .32 .45 .45 .32 .50 .02 Z',
  arrow: 'M .06 .38 L .54 .38 L .54 .16 L .96 .50 L .54 .84 L .54 .62 L .06 .62 Z',
  speech: 'M .08 .18 Q .08 .07 .20 .07 L .80 .07 Q .92 .07 .92 .18 L .92 .58 Q .92 .69 .80 .69 L .46 .69 L .26 .90 L .30 .69 L .20 .69 Q .08 .69 .08 .58 Z',
  flower:
    'M .50 .08 C .62 .22 .78 .14 .80 .28 C .66 .34 .82 .48 .68 .58 '
    + 'C .54 .54 .54 .72 .42 .72 C .36 .58 .18 .64 .16 .50 '
    + 'C .30 .42 .16 .28 .30 .20 C .42 .26 .44 .08 .50 .08 Z',
  cloud:
    'M .22 .72 C .10 .72 .04 .62 .10 .52 C .04 .40 .16 .30 .28 .34 '
    + 'C .34 .20 .52 .16 .64 .26 C .78 .18 .92 .28 .92 .42 '
    + 'C .98 .50 .94 .66 .80 .70 L .80 .72 Z',
  crown: 'M .10 .72 L .18 .30 L .34 .48 L .50 .22 L .66 .48 L .82 .30 L .90 .72 Z',
  music:
    'M .58 .18 L .58 .62 C .58 .74 .44 .80 .36 .72 C .28 .64 .32 .52 .44 .50 '
    + 'C .50 .49 .54 .52 .58 .56 L .58 .18 L .82 .12 L .82 .26 L .64 .30 Z',
  lightning: 'M .56 .04 L .20 .56 L .46 .56 L .36 .96 L .80 .40 L .52 .40 Z',
  check: 'M .12 .52 L .28 .36 L .44 .52 L .76 .18 L .92 .34 L .44 .84 Z',
  sun:
    'M .50 .02 L .58 .20 L .76 .10 L .70 .30 L .92 .30 L .76 .46 '
    + 'L .96 .58 L .74 .64 L .82 .86 L .60 .74 L .50 .98 L .40 .74 '
    + 'L .18 .86 L .26 .64 L .04 .58 L .24 .46 L .08 .30 L .30 .30 L .24 .10 L .42 .20 Z',
}

export type StickerOptions = {
  source: StickerSource
  shape: StickerShape
  x: number
  y: number
  sizePct: number
  rotation: number
  color: string
  opacity: number
  blend: BlendMode
  fit: 'contain' | 'cover'
  flipH: boolean
  flipV: boolean
}

export const DEFAULT_STICKER: StickerOptions = {
  source: 'shape', shape: 'star', x: 0.5, y: 0.5, sizePct: 18, rotation: 0,
  color: '#ffffff', opacity: 100, blend: 'normal', fit: 'contain',
  flipH: false, flipV: false,
}

const SHAPES: readonly StickerShape[] = [
  'star', 'heart', 'sparkle', 'arrow', 'speech',
  'flower', 'cloud', 'crown', 'music', 'lightning', 'check', 'sun',
]
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const finiteOr = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

export function normalizeStickerOptions(
  input: Partial<StickerOptions> = {},
): StickerOptions {
  return {
    source: input.source === 'image' ? 'image' : 'shape',
    shape: SHAPES.includes(input.shape as StickerShape)
      ? input.shape as StickerShape : DEFAULT_STICKER.shape,
    x: clamp(finiteOr(input.x, DEFAULT_STICKER.x), 0, 1),
    y: clamp(finiteOr(input.y, DEFAULT_STICKER.y), 0, 1),
    sizePct: clamp(finiteOr(input.sizePct, DEFAULT_STICKER.sizePct), 2, 60),
    rotation: clamp(finiteOr(input.rotation, DEFAULT_STICKER.rotation), -180, 180),
    color: typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color)
      ? input.color.toLowerCase() : DEFAULT_STICKER.color,
    opacity: clamp(finiteOr(input.opacity, DEFAULT_STICKER.opacity), 0, 100),
    blend: isBlendMode(input.blend) ? input.blend : DEFAULT_STICKER.blend,
    fit: input.fit === 'cover' ? 'cover' : DEFAULT_STICKER.fit,
    flipH: typeof input.flipH === 'boolean' ? input.flipH : DEFAULT_STICKER.flipH,
    flipV: typeof input.flipV === 'boolean' ? input.flipV : DEFAULT_STICKER.flipV,
  }
}

export type StickerLayout = {
  cx: number
  cy: number
  size: number
  rotation: number
}

export function stickerLayout(
  width: number, height: number, input: Partial<StickerOptions>,
): StickerLayout {
  const o = normalizeStickerOptions(input)
  return {
    cx: width * o.x,
    cy: height * o.y,
    size: Math.max(1, Math.min(width, height) * o.sizePct / 100),
    rotation: o.rotation,
  }
}
