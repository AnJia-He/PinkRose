import { makeCanvas } from '../core/canvas'
import {
  normalizeTextOptions,
  textFontFamily,
  type TextLayer,
  type TextOptions,
} from '../../shared/text.ts'

export {
  DEFAULT_TEXT,
  TEXT_FONTS,
  TEXT_FONT_FAMILY,
  TEXT_FONT_MAX,
  TEXT_FONT_MIN,
  TEXT_LETTER_SPACING_MAX,
  TEXT_LETTER_SPACING_MIN,
  TEXT_LAYERS_MAX,
  TEXT_LAYER_CHARS_MAX,
  TEXT_LINE_HEIGHT_MAX,
  TEXT_LINE_HEIGHT_MIN,
  TEXT_OUTLINE_MAX,
  normalizeTextLayer,
  normalizeTextLayers,
  normalizeTextOptions,
  sameTextLayers,
  textFontFamily,
  type TextFontId,
  type TextLayer,
  type TextOptions,
} from '../../shared/text.ts'

/**
 * 文字模板（★ 2026-10-18）：六套常用的「标题 / 极简 / 胶片 / 杂志 / 旅行 / 手记」。
 *
 * `fontRatio` 是字号相对照片**短边**的比例，由 UI 换算成图片像素 ——
 * 同一份模板在 1200px 的旅行照和 4000px 的原图上不会一个太大一个太小。
 * 模板只碰样式，不改用户已经输入的 `text` / `x` / `y`。
 */
export const TEXT_STYLES = [
  {
    id: 'title', label: '标题', fontRatio: 0.10,
    patch: { color: '#ffffff', align: 'center', bold: true, shadow: true, outlineWidth: 0, background: false },
  },
  {
    id: 'minimal', label: '极简', fontRatio: 0.05,
    patch: { color: '#ffffff', align: 'left', bold: false, shadow: false, outlineWidth: 0, background: false },
  },
  {
    id: 'film', label: '胶片', fontRatio: 0.06,
    patch: {
      font: 'serif', color: '#fff4df', align: 'center', bold: false,
      shadow: true, outlineWidth: 0, background: false,
    },
  },
  {
    id: 'magazine', label: '杂志', fontRatio: 0.07,
    patch: {
      font: 'serif', color: '#ffffff', align: 'left', bold: true,
      shadow: false, outlineWidth: 0,
      background: true, backgroundColor: '#111111', backgroundOpacity: 68,
    },
  },
  {
    id: 'travel', label: '旅行', fontRatio: 0.065,
    patch: {
      color: '#ffffff', align: 'center', bold: true, shadow: true,
      outlineWidth: 3, outlineColor: '#111111', background: false,
    },
  },
  {
    id: 'note', label: '手记', fontRatio: 0.05,
    patch: {
      font: 'kai', color: '#1c1c1e', align: 'left', bold: false,
      shadow: false, outlineWidth: 0,
      background: true, backgroundColor: '#fff2d8', backgroundOpacity: 82,
    },
  },
] as const satisfies readonly {
  id: string
  label: string
  fontRatio: number
  patch: Partial<Omit<TextOptions, 'text' | 'x' | 'y' | 'fontPx'>>
}[]

/** 行高倍数。预览和成片共用，别在两处各写一个 1.2。 */
export const TEXT_LINE_HEIGHT = 1.2

export type TextLine = { text: string; x: number; y: number }
export type TextLayout = {
  lines: TextLine[]
  lineHeight: number
  fontPx: number
  color: string
}

/**
 * 多行文字按 `fontPx × lineHeight` 的行高、以 `(x, y)` 为中心排开。
 *
 * 空文字返回**零行**（调用方据此禁用主按钮）；有文字但含空行时保留空行，
 * 换行本身是排版的一部分。返回的坐标已经是**图片像素**。
 */
export function textLayout(options: TextOptions, width: number, height: number): TextLayout {
  const opts = normalizeTextOptions(options)
  const lineHeight = opts.fontPx * opts.lineHeight
  if (opts.text === '') {
    return { lines: [], lineHeight, fontPx: opts.fontPx, color: opts.color }
  }
  const raw = opts.text.split('\n')
  const cx = width * opts.x
  const cy = height * opts.y
  const first = cy - (raw.length - 1) * lineHeight / 2
  return {
    lines: raw.map((text, i) => ({ text, x: cx, y: first + i * lineHeight })),
    lineHeight,
    fontPx: opts.fontPx,
    color: opts.color,
  }
}

/**
 * 把一层文字画到任意 2D 上下文里。
 *
 * `width` / `height` 是**文字坐标系**的尺寸（通常就是底图像素）。
 * 调用方要缩放预览时，先把上下文 `scale()` 好再调它 —— 不要改 `fontPx`，
 * 否则量字宽和描边的换算会和成片不一致。
 */
export function drawTextOptions(
  ctx: CanvasRenderingContext2D,
  input: Partial<TextOptions>,
  width: number,
  height: number,
): void {
  const opts = normalizeTextOptions(input)
  const layout = textLayout(opts, width, height)
  if (layout.lines.length === 0) return

  ctx.save()
  ctx.font = `${opts.bold ? 'bold ' : ''}${layout.fontPx}px ${textFontFamily(opts.font)}`
  ctx.textBaseline = 'middle'
  const measured = layout.lines.map(line => {
    const chars = [...line.text]
    const charWidths = chars.map(char => ctx.measureText(char).width)
    const width = opts.letterSpacing === 0
      ? ctx.measureText(line.text).width
      : charWidths.reduce((sum, value) => sum + value, 0)
        + Math.max(0, chars.length - 1) * opts.letterSpacing
    return { line, chars, charWidths, width }
  })
  const blockW = Math.max(1, ...measured.map(item => item.width))
  const blockH = layout.lineHeight * layout.lines.length
  const pad = Math.max(6, layout.fontPx * 0.14)
  const left = layout.lines[0]!.x - blockW / 2
  const top = layout.lines[0]!.y - layout.lineHeight / 2

  if (opts.rotation !== 0) {
    ctx.translate(layout.lines[0]!.x, layout.lines[0]!.y)
    ctx.rotate(opts.rotation * Math.PI / 180)
    ctx.translate(-layout.lines[0]!.x, -layout.lines[0]!.y)
  }

  if (opts.background && opts.backgroundOpacity > 0) {
    const alpha = opts.backgroundOpacity / 100
    ctx.fillStyle = `${opts.backgroundColor}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`
    const r = Math.max(2, pad * 0.55)
    roundedPath(ctx, left - pad, top - pad, blockW + pad * 2, blockH + pad * 2, r)
    ctx.fill()
  }

  if (opts.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,.58)'
    ctx.shadowBlur = Math.max(2, layout.fontPx * 0.09)
    ctx.shadowOffsetY = Math.max(1, layout.fontPx * 0.035)
  }
  if (opts.outlineWidth > 0) {
    ctx.strokeStyle = opts.outlineColor
    ctx.lineWidth = opts.outlineWidth
    ctx.lineJoin = 'round'
  }
  ctx.fillStyle = layout.color
  for (const item of measured) {
    const line = item.line
    const x = opts.align === 'left' ? left
      : opts.align === 'right' ? left + blockW
        : line.x
    if (opts.letterSpacing === 0) {
      ctx.textAlign = opts.align
      if (opts.outlineWidth > 0) ctx.strokeText(line.text, x, line.y)
      ctx.fillText(line.text, x, line.y)
      continue
    }
    let cursor = opts.align === 'left' ? x
      : opts.align === 'right' ? x - item.width
        : x - item.width / 2
    ctx.textAlign = 'left'
    for (let i = 0; i < item.chars.length; i++) {
      if (opts.outlineWidth > 0) ctx.strokeText(item.chars[i]!, cursor, line.y)
      ctx.fillText(item.chars[i]!, cursor, line.y)
      cursor += item.charWidths[i]! + opts.letterSpacing
    }
  }
  ctx.restore()
}

/**
 * 把一组文字层画进已有上下文。
 *
 * `offsetX/Y` 用于导出时的裁切 / 画布扩展：图层坐标仍按原图尺寸算，
 * 只是整体平移到目标画布里的照片区域。
 */
export function drawTextLayers(
  ctx: CanvasRenderingContext2D,
  layers: readonly TextLayer[],
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0,
): void {
  if (layers.length === 0) return
  ctx.save()
  ctx.translate(offsetX, offsetY)
  for (const layer of layers) drawTextOptions(ctx, layer.options, width, height)
  ctx.restore()
}

/** 导出 / 封面用：复制一张底图并叠上文字层；没有图层时原样返回。 */
export function compositeTextLayers(
  source: CanvasImageSource & { width: number; height: number },
  layers: readonly TextLayer[],
): HTMLCanvasElement | (CanvasImageSource & { width: number; height: number }) {
  if (layers.length === 0) return source
  const { canvas, ctx } = makeCanvas(source.width, source.height, '叠不上文字层')
  ctx.drawImage(source, 0, 0)
  drawTextLayers(ctx, layers, source.width, source.height)
  return canvas
}

/**
 * 几何类工具（裁剪 / 扩画布 / 透视 / 放大）的入口：先把文字层合并进一张
 * **临时位图**，再让工具在它上面动。没有层时原样返回同一个对象 ——
 * 调用方据此决定要不要 `close()`。
 */
export async function textLayersToBitmap(
  source: ImageBitmap,
  layers: readonly TextLayer[],
): Promise<ImageBitmap> {
  if (layers.length === 0) return source
  const { canvas, ctx } = makeCanvas(source.width, source.height, '合并不了文字层')
  ctx.drawImage(source, 0, 0)
  drawTextLayers(ctx, layers, source.width, source.height)
  return createImageBitmap(canvas)
}

/**
 * 把文字画进一张新底图（旧的烘焙路径）。
 *
 * @deprecated 新的文字工具走文字层（`TextLayer`）；这个函数留给旧测试和
 * 一次性导出工具，别再往它上面加新能力。
 */
export async function textToBitmap(
  source: ImageBitmap, input: Partial<TextOptions>,
): Promise<{ bitmap: ImageBitmap }> {
  const w = source.width
  const h = source.height
  const { canvas, ctx } = makeCanvas(w, h, '加不上文字')
  ctx.drawImage(source, 0, 0)
  drawTextOptions(ctx, input, w, h)
  const bitmap = await createImageBitmap(canvas)
  return { bitmap }
}

function roundedPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}
