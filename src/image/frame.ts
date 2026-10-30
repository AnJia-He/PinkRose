import { makeCanvas } from '../core/canvas'

/**
 * **相框 / 边框**（★ 2026-10-17）—— 工具行「边框」的像素引擎。
 *
 * 四种样式：纯色边、拍立得（下边更厚）、胶片（上下黑边 + 齿孔）、圆角。
 * 边框宽度按**短边**的百分比算，所以横竖图看起来一样粗。
 *
 * 和裁剪 / 点修 / 磨皮 / 文字一样：产出新底图、账本记一笔、可撤销；
 * 不进转盘、不写对话、不碰 `params`。预览用的比例和成片共用
 * `frameFractions` —— 两处各写一份公式就会"框看着对、成片不对"。
 */
export type FrameStyle = 'solid' | 'polaroid' | 'film' | 'rounded'

export type FrameOptions = {
  style: FrameStyle
  /** `#rrggbb`。 */
  color: string
  /** 边框宽度，占短边的百分比，0~20。 */
  widthPct: number
}

export const DEFAULT_FRAME: FrameOptions = {
  style: 'solid', color: '#ffffff', widthPct: 4,
}

const STYLES: readonly FrameStyle[] = ['solid', 'polaroid', 'film', 'rounded']
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function normalizeFrameOptions(input: Partial<FrameOptions> = {}): FrameOptions {
  return {
    style: STYLES.includes(input.style as FrameStyle) ? input.style as FrameStyle : DEFAULT_FRAME.style,
    color: typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color)
      ? input.color.toLowerCase()
      : DEFAULT_FRAME.color,
    widthPct: clamp(
      typeof input.widthPct === 'number' && Number.isFinite(input.widthPct)
        ? input.widthPct : DEFAULT_FRAME.widthPct,
      0, 20,
    ),
  }
}

export type FrameFractions = {
  left: number
  top: number
  right: number
  bottom: number
  /** 圆角半径，按画布短边归一化；非圆角样式是 0。 */
  radius: number
}

/** 归一化的四条边（相对画布宽高）。预览和成片共用这一份。 */
export function frameFractions(
  width: number, height: number, input: Partial<FrameOptions>,
): FrameFractions {
  const o = normalizeFrameOptions(input)
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const side = (o.widthPct / 100) * Math.min(w, h)
  if (o.style === 'film') {
    return { left: 0, top: (side * 1.4) / h, right: 0, bottom: (side * 1.4) / h, radius: 0 }
  }
  const bottom = o.style === 'polaroid' ? side * 2.5 : side
  const left = side / w
  const top = side / h
  const right = side / w
  const bottomF = bottom / h
  const photoW = Math.max(1, w - side * 2)
  const photoH = Math.max(1, h - side - bottom)
  return {
    left, top, right, bottom: bottomF,
    radius: o.style === 'rounded' ? (Math.min(photoW, photoH) * 0.08) / Math.min(w, h) : 0,
  }
}

export type FrameLayout = {
  width: number
  height: number
  photo: { x: number; y: number; w: number; h: number }
  /** 圆角半径，像素。 */
  radius: number
}

/** 像素版的同一套框：预览比例 × 画布尺寸。 */
export function frameLayout(
  width: number, height: number, input: Partial<FrameOptions>,
): FrameLayout {
  const f = frameFractions(width, height, input)
  const x = Math.round(f.left * width)
  const y = Math.round(f.top * height)
  return {
    width, height,
    photo: {
      x, y,
      w: Math.max(1, Math.round(width - x - f.right * width)),
      h: Math.max(1, Math.round(height - y - f.bottom * height)),
    },
    radius: Math.round(f.radius * Math.min(width, height)),
  }
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

/** 把边框烤进一张新底图。 */
export async function frameToBitmap(
  source: ImageBitmap, input: Partial<FrameOptions>,
): Promise<{ bitmap: ImageBitmap }> {
  const o = normalizeFrameOptions(input)
  const w = source.width
  const h = source.height
  const { canvas, ctx } = makeCanvas(w, h, '加不上边框')
  const l = frameLayout(w, h, o)

  ctx.fillStyle = o.color
  ctx.fillRect(0, 0, w, h)
  ctx.imageSmoothingQuality = 'high'

  if (o.style === 'rounded' && l.radius > 0) {
    ctx.save()
    roundedPath(ctx, l.photo.x, l.photo.y, l.photo.w, l.photo.h, l.radius)
    ctx.clip()
    ctx.drawImage(source, l.photo.x, l.photo.y, l.photo.w, l.photo.h)
    ctx.restore()
  } else {
    ctx.drawImage(source, l.photo.x, l.photo.y, l.photo.w, l.photo.h)
  }

  if (o.style === 'film') {
    // 齿孔：上下两条各一排，按宽度均分。它们只是"胶片"的视觉记号。
    const bar = l.photo.y
    const count = Math.max(4, Math.floor(w / 90))
    const holeW = Math.min(26, (w / count) * 0.45)
    const holeH = Math.min(bar * 0.42, holeW * 0.6)
    ctx.fillStyle = '#f4f1e8'
    for (let i = 0; i < count; i++) {
      const cx = (w / count) * (i + 0.5)
      const top = (bar - holeH) / 2
      const bottom = h - bar + (bar - holeH) / 2
      ctx.fillRect(cx - holeW / 2, top, holeW, holeH)
      ctx.fillRect(cx - holeW / 2, bottom, holeW, holeH)
    }
  }

  return { bitmap: await createImageBitmap(canvas) }
}
