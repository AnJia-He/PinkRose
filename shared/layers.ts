import type { TextOptions } from './text.ts'
import type { ShapeOptions } from './shape.ts'
import type { StickerOptions } from './sticker.ts'
import type { LocalLayer } from './local.ts'
import { normalizeTextLayer } from './text.ts'
import { normalizeShapeOptions } from './shape.ts'
import { normalizeStickerOptions } from './sticker.ts'
import {
  LOCAL_LAYERS_MAX, LOCAL_MASKS_TOTAL_MAX, normalizeLocalLayer,
} from './local.ts'

export type TextLayer = {
  kind: 'text'; id: string; options: TextOptions
  visible?: boolean
}
export type ShapeLayer = {
  kind: 'shape'; id: string; options: ShapeOptions
  visible?: boolean
}
export type StickerLayer = {
  kind: 'sticker'
  id: string
  visible?: boolean
  options: StickerOptions
  /** 自定义图片贴纸的透明 PNG data URL；内置图形为空。 */
  image?: string | null
}
export type EditLayer = TextLayer | ShapeLayer | StickerLayer | LocalLayer

/** 缺省 = 显示；只有显式 `false` 才是隐藏。 */
export function isLayerVisible(layer: EditLayer): boolean {
  return layer.visible !== false
}

const ID_MAX = 64
const LAYERS_MAX = 40
const STICKER_IMAGE_MAX = 2_500_000

function shapeLayer(input: unknown): ShapeLayer | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const o = input as { id?: unknown; options?: unknown }
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  if (!o.options || typeof o.options !== 'object' || Array.isArray(o.options)) return null
  const options = normalizeShapeOptions(o.options as Partial<ShapeOptions>)
  if (options.opacity <= 0) return null
  return { kind: 'shape', id: o.id.slice(0, ID_MAX), options }
}

function stickerLayer(input: unknown): StickerLayer | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const o = input as { id?: unknown; options?: unknown; image?: unknown }
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  if (!o.options || typeof o.options !== 'object' || Array.isArray(o.options)) return null
  const options = normalizeStickerOptions(o.options as Partial<StickerOptions>)
  if (options.opacity <= 0) return null
  if (options.source === 'image') {
    if (typeof o.image !== 'string' || !o.image.startsWith('data:image/')
      || o.image.length > STICKER_IMAGE_MAX) return null
    return { kind: 'sticker', id: o.id.slice(0, ID_MAX), options, image: o.image }
  }
  return { kind: 'sticker', id: o.id.slice(0, ID_MAX), options, image: null }
}

/** 外部数组 → 去重后的合法层；坏层只丢自己。 */
export function normalizeEditLayers(input: unknown): EditLayer[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: EditLayer[] = []
  let locals = 0
  let maskChars = 0
  for (const item of input) {
    const kind = item && typeof item === 'object' && !Array.isArray(item)
      ? (item as { kind?: unknown }).kind
      : undefined
    const parsed = kind === 'shape'
      ? shapeLayer(item)
      : kind === 'sticker' ? stickerLayer(item)
        : kind === 'local' ? normalizeLocalLayer(item) : normalizeTextLayer(item)
    if (!parsed || seen.has(parsed.id)) continue
    const layer = (item as { visible?: unknown }).visible === false
      ? { ...parsed, visible: false }
      : parsed
    if (layer.kind === 'local') {
      if (locals >= LOCAL_LAYERS_MAX) continue
      if (maskChars + layer.mask.length > LOCAL_MASKS_TOTAL_MAX) continue
      locals++
      maskChars += layer.mask.length
    }
    seen.add(layer.id)
    out.push(layer)
    if (out.length >= LAYERS_MAX) break
  }
  return out
}

export function sameEditLayers(
  a?: readonly EditLayer[], b?: readonly EditLayer[],
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    const x = left[i]!
    const y = right[i]!
    if (x.id !== y.id) return false
    if (x.kind !== y.kind) return false
    if (isLayerVisible(x) !== isLayerVisible(y)) return false
    if (JSON.stringify(x.options) !== JSON.stringify(y.options)) return false
    if ((x.kind === 'sticker' ? x.image ?? null : null)
      !== (y.kind === 'sticker' ? y.image ?? null : null)) return false
    if (x.kind === 'local' && y.kind === 'local') {
      if (x.mask !== y.mask) return false
      if (x.maskWidth !== y.maskWidth) return false
      if (x.maskHeight !== y.maskHeight) return false
      if (x.feather !== y.feather) return false
      if ((x.opacity ?? 100) !== (y.opacity ?? 100)) return false
      if (JSON.stringify(x.color) !== JSON.stringify(y.color)) return false
      if (JSON.stringify(x.luminance) !== JSON.stringify(y.luminance)) return false
    }
  }
  return true
}
