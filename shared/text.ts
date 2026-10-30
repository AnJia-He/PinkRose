/**
 * 文字层协议（★ 2026-10-19）。
 *
 * 这一份住在 `shared/` 里，因为同一份文字选项要同时被三处读：
 *   · 前端画布 / 导出（`src/image/text.ts`）；
 *   · 会话步骤的 JSON 落盘（`server/sessions.ts`）；
 *   · 恢复会话时的归一化（`useLoadSession`）。
 *
 * 位置 `(x, y)` 是**归一化中心点**（相对照片左上角），字号是**图片像素**。
 * 这些字段全部是 JSON 可序列化的；不进数据库表结构，只进 steps 那列 JSON。
 */
import type { TextLayer } from './layers.ts'
export type { TextLayer } from './layers.ts'

export type TextFontId = 'sans' | 'serif' | 'kai' | 'mono'

export type TextOptions = {
  /** 原文。**保留两侧空格与换行**。 */
  text: string
  /** 文字块中心，0~1。 */
  x: number
  y: number
  /** 字号，图片像素。 */
  fontPx: number
  font: TextFontId
  /** 只接受 `#rrggbb`。 */
  color: string
  align: 'left' | 'center' | 'right'
  bold: boolean
  /** 整块文字绕中心旋转，单位度；-180~180。 */
  rotation: number
  lineHeight: number
  letterSpacing: number
  outlineWidth: number
  outlineColor: string
  shadow: boolean
  background: boolean
  backgroundColor: string
  backgroundOpacity: number
}

export const DEFAULT_TEXT: TextOptions = {
  text: '', x: 0.5, y: 0.5, fontPx: 64, font: 'sans', color: '#ffffff',
  align: 'center', bold: false, rotation: 0, lineHeight: 1.2, letterSpacing: 0,
  outlineWidth: 0, outlineColor: '#000000',
  shadow: false, background: false, backgroundColor: '#000000', backgroundOpacity: 55,
}

export const TEXT_FONT_MIN = 12
export const TEXT_FONT_MAX = 400
export const TEXT_OUTLINE_MAX = 20
export const TEXT_LINE_HEIGHT_MIN = 0.8
export const TEXT_LINE_HEIGHT_MAX = 2
export const TEXT_LETTER_SPACING_MIN = -20
export const TEXT_LETTER_SPACING_MAX = 40

/** 一层最多 2000 字；一次最多 40 层。这是落盘 JSON 的体量闸。 */
export const TEXT_LAYER_CHARS_MAX = 2000
export const TEXT_LAYERS_MAX = 40

export const TEXT_FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

export const TEXT_FONTS = [
  { id: 'sans', label: '黑体', family: TEXT_FONT_FAMILY },
  {
    id: 'serif', label: '宋体',
    family: '"Songti SC", "STSong", "SimSun", Georgia, "Times New Roman", serif',
  },
  {
    id: 'kai', label: '楷体',
    family: '"Kaiti SC", "STKaiti", "KaiTi", "楷体", "KaiTi_GB2312", serif',
  },
  {
    id: 'mono', label: '等宽',
    family: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Courier New", monospace',
  },
] as const satisfies readonly { id: TextFontId; label: string; family: string }[]

export function textFontFamily(id: TextFontId): string {
  return TEXT_FONTS.find(f => f.id === id)?.family ?? TEXT_FONT_FAMILY
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const finiteOr = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** 把外部输入收成一份可以安全交给画布 / 落盘的选项。 */
export function normalizeTextOptions(input: Partial<TextOptions> = {}): TextOptions {
  const color = (v: unknown, fallback: string) =>
    typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback
  return {
    text: typeof input.text === 'string'
      ? input.text.slice(0, TEXT_LAYER_CHARS_MAX)
      : DEFAULT_TEXT.text,
    x: clamp01(finiteOr(input.x, DEFAULT_TEXT.x)),
    y: clamp01(finiteOr(input.y, DEFAULT_TEXT.y)),
    fontPx: Math.max(
      TEXT_FONT_MIN,
      Math.min(TEXT_FONT_MAX, finiteOr(input.fontPx, DEFAULT_TEXT.fontPx)),
    ),
    font: TEXT_FONTS.some(f => f.id === input.font) ? input.font! : DEFAULT_TEXT.font,
    color: color(input.color, DEFAULT_TEXT.color),
    align: input.align === 'left' || input.align === 'right' || input.align === 'center'
      ? input.align : DEFAULT_TEXT.align,
    bold: typeof input.bold === 'boolean' ? input.bold : DEFAULT_TEXT.bold,
    rotation: Math.max(-180, Math.min(180,
      finiteOr(input.rotation, DEFAULT_TEXT.rotation))),
    lineHeight: Math.max(TEXT_LINE_HEIGHT_MIN, Math.min(TEXT_LINE_HEIGHT_MAX,
      finiteOr(input.lineHeight, DEFAULT_TEXT.lineHeight))),
    letterSpacing: Math.max(TEXT_LETTER_SPACING_MIN, Math.min(TEXT_LETTER_SPACING_MAX,
      finiteOr(input.letterSpacing, DEFAULT_TEXT.letterSpacing))),
    outlineWidth: Math.max(0, Math.min(TEXT_OUTLINE_MAX,
      finiteOr(input.outlineWidth, DEFAULT_TEXT.outlineWidth))),
    outlineColor: color(input.outlineColor, DEFAULT_TEXT.outlineColor),
    shadow: typeof input.shadow === 'boolean' ? input.shadow : DEFAULT_TEXT.shadow,
    background: typeof input.background === 'boolean' ? input.background : DEFAULT_TEXT.background,
    backgroundColor: color(input.backgroundColor, DEFAULT_TEXT.backgroundColor),
    backgroundOpacity: Math.max(0, Math.min(100,
      finiteOr(input.backgroundOpacity, DEFAULT_TEXT.backgroundOpacity))),
  }
}

/** 一层坏数据只丢这一层，不拖垮整条会话。 */
export function normalizeTextLayer(input: unknown): TextLayer | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const o = input as { id?: unknown; options?: unknown }
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  if (!o.options || typeof o.options !== 'object' || Array.isArray(o.options)) return null
  const options = normalizeTextOptions(o.options as Partial<TextOptions>)
  if (options.text.trim() === '') return null
  return { kind: 'text', id: o.id.slice(0, 64), options }
}

/** 外部数组 → 去重后的合法层；最多 40 层。 */
export function normalizeTextLayers(input: unknown): TextLayer[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: TextLayer[] = []
  for (const item of input) {
    const layer = normalizeTextLayer(item)
    if (!layer || seen.has(layer.id)) continue
    seen.add(layer.id)
    out.push(layer)
    if (out.length >= TEXT_LAYERS_MAX) break
  }
  return out
}

/** 账本判"这一笔有没有变"用；空数组和 undefined 等价。 */
export function sameTextLayers(a?: readonly TextLayer[], b?: readonly TextLayer[]): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    const x = left[i]!
    const y = right[i]!
    if (x.id !== y.id) return false
    if (JSON.stringify(x.options) !== JSON.stringify(y.options)) return false
  }
  return true
}
