import {
  TEXT_FONTS, textFontFamily, type TextFontId,
} from '../../shared/text.ts'

export type WatermarkPosition =
  | 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center'

export type WatermarkKind = 'text' | 'logo'

export type WatermarkOptions = {
  text: string
  position: WatermarkPosition
  /** 10~100。 */
  opacity: number
  /** 字号占短边百分比：1~12。 */
  sizePct: number
  color: string
  /** 与文字图层共用同一组字体；缺省黑体。 */
  font?: TextFontId
  /** 文字水印或图片 Logo；缺省按文字处理。 */
  kind?: WatermarkKind
  /** 单个 / 平铺；缺省单个。 */
  tile?: boolean
  /** Logo 宽度占画面宽度的百分比：5~40。 */
  logoSizePct?: number
}

export type WatermarkLogo = {
  source: CanvasImageSource
  width: number
  height: number
  name: string
  /** ImageBitmap 需要显式释放；HTMLImageElement 走对象 URL 时也会带一个。 */
  close?: () => void
}

export const DEFAULT_WATERMARK: WatermarkOptions = {
  text: '', position: 'bottom-right', opacity: 70, sizePct: 4, color: '#ffffff',
  font: 'sans', kind: 'text', tile: false, logoSizePct: 18,
}

const WATERMARK_PREF_KEY = 'pinkrose.watermark.text.v1'
const COLOR_RE = /^#[0-9a-f]{6}$/i
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const POSITIONS = new Set<WatermarkPosition>([
  'bottom-right', 'bottom-left', 'top-right', 'top-left', 'center',
])

/** 只恢复文字水印；Logo 的位图源没有稳定持久化路径，不会假装恢复。 */
export function loadTextWatermark(): WatermarkOptions {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_WATERMARK }
    const raw = localStorage.getItem(WATERMARK_PREF_KEY)
    if (!raw) return { ...DEFAULT_WATERMARK }
    const value = JSON.parse(raw) as Partial<WatermarkOptions>
    return {
      ...DEFAULT_WATERMARK,
      text: typeof value.text === 'string' ? value.text.slice(0, 200) : '',
      position: value.position && POSITIONS.has(value.position)
        ? value.position : DEFAULT_WATERMARK.position,
      opacity: clamp(Number(value.opacity) || DEFAULT_WATERMARK.opacity, 10, 100),
      sizePct: clamp(Number(value.sizePct) || DEFAULT_WATERMARK.sizePct, 1, 12),
      color: typeof value.color === 'string' && COLOR_RE.test(value.color)
        ? value.color : DEFAULT_WATERMARK.color,
      font: TEXT_FONTS.some(font => font.id === value.font)
        ? value.font : DEFAULT_WATERMARK.font,
      kind: 'text',
      tile: value.tile === true,
    }
  } catch {
    return { ...DEFAULT_WATERMARK }
  }
}

export function saveTextWatermark(options: WatermarkOptions): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (options.kind === 'logo') return
    if (!options.text.trim()) {
      localStorage.removeItem(WATERMARK_PREF_KEY)
      return
    }
    localStorage.setItem(WATERMARK_PREF_KEY, JSON.stringify({
      text: options.text.slice(0, 200),
      position: options.position,
      opacity: clamp(options.opacity, 10, 100),
      sizePct: clamp(options.sizePct, 1, 12),
      color: COLOR_RE.test(options.color) ? options.color : DEFAULT_WATERMARK.color,
      font: options.font ?? 'sans',
      tile: options.tile === true,
    }))
  } catch {
    // 隐私模式 / 禁用存储：水印仍可用，只是不记住。
  }
}

function approxWidth(text: string, size: number, font: TextFontId): number {
  const latin = font === 'mono' ? 0.62 : font === 'serif' ? 0.52 : 0.56
  let units = 0
  for (const ch of text) units += /[\u3400-\u9fff]/.test(ch) ? 1 : latin
  return Math.max(size, units * size)
}

export function watermarkLayout(
  text: string, width: number, height: number, options: WatermarkOptions,
) {
  const value = text.trim()
  const size = Math.max(8, Math.round(Math.min(width, height) * clamp(options.sizePct, 1, 12) / 100))
  const w = Math.min(width * 0.86, approxWidth(value, size, options.font ?? 'sans'))
  const margin = Math.max(8, Math.round(Math.min(width, height) * 0.025))
  const x = options.position.endsWith('right')
    ? width - margin - w
    : options.position.endsWith('left') ? margin : (width - w) / 2
  const y = options.position.startsWith('top')
    ? margin + size
    : options.position.startsWith('bottom') ? height - margin : (height + size) / 2
  return { x: Math.round(x), y: Math.round(y), size, width: Math.round(w) }
}

export function watermarkLogoLayout(
  width: number, height: number, logoWidth: number, logoHeight: number,
  options: WatermarkOptions,
) {
  const safeW = Math.max(1, logoWidth)
  const safeH = Math.max(1, logoHeight)
  const pct = clamp(options.logoSizePct ?? 18, 5, 40)
  const w = Math.min(width * 0.86, Math.max(8, Math.round(width * pct / 100)))
  const h = Math.max(1, Math.round(w * safeH / safeW))
  const margin = Math.max(8, Math.round(Math.min(width, height) * 0.025))
  const x = options.position.endsWith('right')
    ? width - margin - w
    : options.position.endsWith('left') ? margin : (width - w) / 2
  const y = options.position.startsWith('top')
    ? margin
    : options.position.startsWith('bottom') ? height - margin - h : (height - h) / 2
  return {
    x: Math.round(Math.max(0, x)),
    y: Math.round(Math.max(0, y)),
    w: Math.round(w),
    h: Math.round(h),
  }
}

export type WatermarkTileBox = { x: number; y: number; w: number; h: number }

/** 平铺位置按半个步长交错，盖住画面又不至于在边上留一条空带。 */
export function watermarkTileLayout(
  width: number, height: number, markWidth: number, markHeight: number,
): WatermarkTileBox[] {
  const w = Math.max(1, Math.min(markWidth, width * 0.9))
  const h = Math.max(1, Math.min(markHeight, height * 0.9))
  const stepX = Math.max(32, Math.round(w * 1.8))
  const stepY = Math.max(32, Math.round(h * 3))
  const cols = Math.ceil(width / stepX) + 2
  const rows = Math.ceil(height / stepY) + 2
  const boxes: WatermarkTileBox[] = []
  for (let row = 0; row < rows; row++) {
    const y = -h - stepY + row * stepY
    const offset = row % 2 === 0 ? 0 : stepX / 2
    for (let col = 0; col < cols; col++) {
      boxes.push({
        x: Math.round(-w - stepX + offset + col * stepX),
        y: Math.round(y),
        w: Math.round(w),
        h: Math.round(h),
      })
    }
  }
  return boxes
}

export function hasWatermark(
  options: WatermarkOptions | null | undefined,
  logo: WatermarkLogo | null | undefined,
): boolean {
  if (!options) return false
  return options.kind === 'logo' ? !!logo : options.text.trim().length > 0
}

/** 在已调色的成品画布上写水印；留空 = 一个字节都不写。 */
export function drawWatermark(
  canvas: HTMLCanvasElement,
  options: WatermarkOptions | null | undefined,
  logo?: WatermarkLogo | null,
): void {
  const text = options?.text.trim() ?? ''
  if (!options || !hasWatermark(options, logo)) return
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('拿不到 2D 上下文，写不了水印')
  ctx.save()
  ctx.globalAlpha = clamp(options.opacity, 10, 100) / 100

  if (options.kind === 'logo' && logo) {
    const layout = watermarkLogoLayout(
      canvas.width, canvas.height, logo.width, logo.height, options,
    )
    const boxes = options.tile
      ? watermarkTileLayout(canvas.width, canvas.height, layout.w, layout.h)
      : [layout]
    for (const box of boxes) {
      ctx.drawImage(logo.source, box.x, box.y, box.w, box.h)
    }
  } else {
    const layout = watermarkLayout(text, canvas.width, canvas.height, options)
    const color = COLOR_RE.test(options.color) ? options.color : '#ffffff'
    ctx.font = `600 ${layout.size}px ${textFontFamily(options.font ?? 'sans')}`
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = color
    ctx.shadowColor = 'rgba(0, 0, 0, .55)'
    ctx.shadowBlur = Math.max(2, layout.size * 0.12)
    ctx.shadowOffsetY = Math.max(1, layout.size * 0.04)
    if (options.tile) {
      const boxes = watermarkTileLayout(
        canvas.width, canvas.height, layout.width, layout.size,
      )
      for (const box of boxes) {
        ctx.save()
        ctx.translate(box.x + box.w / 2, box.y + box.h / 2)
        ctx.rotate(-Math.PI / 9)
        ctx.fillText(text, -box.w / 2, box.h * 0.35)
        ctx.restore()
      }
    } else {
      ctx.fillText(text, layout.x, layout.y)
    }
  }
  ctx.restore()
}

/** 浏览器里的 Logo 读取：优先 ImageBitmap，老浏览器退回 <img>。 */
export async function loadWatermarkLogo(file: File): Promise<WatermarkLogo> {
  if (!file.type.startsWith('image/')) throw new Error('这不是图片')
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      name: file.name,
      close: () => bitmap.close(),
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('这张 Logo 打不开'))
      img.src = url
    })
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      name: file.name,
      close: () => URL.revokeObjectURL(url),
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}
