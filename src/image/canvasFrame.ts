import { makeCanvas } from '../core/canvas'

/**
 * 单张照片的**画布扩展**：把原图放进不同比例、不同边距的画布，背景可以是
 * 纯色、当前照片的模糊版本，或透明。
 *
 * 和导出里的「模糊扩展」不同，这里先给用户一张准确预览，再作为当前版本的
 * 一笔像素修改写进账本；应用后仍可继续裁剪、文字、水印或导出。
 */
export type CanvasFrameAspect = 'original' | '1:1' | '4:5' | '3:4' | '9:16' | '16:9'
export type CanvasFrameBackground = 'color' | 'blur' | 'transparent'

export type CanvasFrameOptions = {
  aspect: CanvasFrameAspect
  background: CanvasFrameBackground
  /** `#rrggbb`，纯色背景和模糊背景的兜底色。 */
  color: string
  /** 照片四周留白，占最终画布宽高的百分比；0~20。 */
  paddingPct: number
}

export const DEFAULT_CANVAS_FRAME: CanvasFrameOptions = {
  aspect: '1:1', background: 'color', color: '#ffffff', paddingPct: 0,
}

export const CANVAS_FRAME_MAX_SIDE = 4096
export const CANVAS_FRAME_PADDING_MAX = 20

const ASPECTS: readonly CanvasFrameAspect[] = [
  'original', '1:1', '4:5', '3:4', '9:16', '16:9',
]
const BACKGROUNDS: readonly CanvasFrameBackground[] = ['color', 'blur', 'transparent']
const RATIOS: Record<Exclude<CanvasFrameAspect, 'original'>, number> = {
  '1:1': 1,
  '4:5': 4 / 5,
  '3:4': 3 / 4,
  '9:16': 9 / 16,
  '16:9': 16 / 9,
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const finiteOr = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

export function normalizeCanvasFrameOptions(
  input: Partial<CanvasFrameOptions> = {},
): CanvasFrameOptions {
  return {
    aspect: ASPECTS.includes(input.aspect as CanvasFrameAspect)
      ? input.aspect as CanvasFrameAspect : DEFAULT_CANVAS_FRAME.aspect,
    background: BACKGROUNDS.includes(input.background as CanvasFrameBackground)
      ? input.background as CanvasFrameBackground : DEFAULT_CANVAS_FRAME.background,
    color: typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color)
      ? input.color.toLowerCase() : DEFAULT_CANVAS_FRAME.color,
    paddingPct: clamp(
      finiteOr(input.paddingPct, DEFAULT_CANVAS_FRAME.paddingPct),
      0, CANVAS_FRAME_PADDING_MAX,
    ),
  }
}

export type CanvasFrameLayout = {
  width: number
  height: number
  photo: { x: number; y: number; w: number; h: number }
}

/**
 * 先按“照片不缩小”算出内容盒，再把它放进带边距的画布；最后如果超过长边
 * 上限，整张画布等比缩小。照片始终居中，不拉伸。
 */
export function canvasFrameLayout(
  sourceWidth: number,
  sourceHeight: number,
  input: Partial<CanvasFrameOptions> = {},
  maxSide = CANVAS_FRAME_MAX_SIDE,
): CanvasFrameLayout {
  const sw = Math.max(1, Math.round(sourceWidth))
  const sh = Math.max(1, Math.round(sourceHeight))
  const o = normalizeCanvasFrameOptions(input)
  const ratio = o.aspect === 'original' ? sw / sh : RATIOS[o.aspect]

  let contentW: number
  let contentH: number
  if (ratio >= sw / sh) {
    contentH = sh
    contentW = sh * ratio
  } else {
    contentW = sw
    contentH = sw / ratio
  }

  const pad = o.paddingPct / 100
  let width = contentW / (1 - pad * 2)
  let height = contentH / (1 - pad * 2)
  const cap = Math.max(1, maxSide)
  const shrink = Math.min(1, cap / Math.max(width, height))
  width = Math.max(1, Math.round(width * shrink))
  height = Math.max(1, Math.round(height * shrink))

  const padX = width * pad
  const padY = height * pad
  const content = {
    w: Math.max(1, width - padX * 2),
    h: Math.max(1, height - padY * 2),
  }
  const scale = Math.min(content.w / sw, content.h / sh)
  const photoW = Math.max(1, Math.round(sw * scale))
  const photoH = Math.max(1, Math.round(sh * scale))
  return {
    width, height,
    photo: {
      x: Math.round((width - photoW) / 2),
      y: Math.round((height - photoH) / 2),
      w: photoW,
      h: photoH,
    },
  }
}

/** 画一张铺满目标区域的 cover 图，给模糊背景用。 */
function drawCover(
  ctx: CanvasRenderingContext2D, source: CanvasImageSource,
  sourceWidth: number, sourceHeight: number,
  x: number, y: number, width: number, height: number,
): void {
  const scale = Math.max(width / sourceWidth, height / sourceHeight)
  const w = sourceWidth * scale
  const h = sourceHeight * scale
  ctx.drawImage(source, x + (width - w) / 2, y + (height - h) / 2, w, h)
}

/** 预览和成片共用同一套画法；调用方负责把布局缩放到自己的画布尺寸。 */
export function paintCanvasFrame(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  layout: CanvasFrameLayout,
  input: Partial<CanvasFrameOptions> = {},
): void {
  const o = normalizeCanvasFrameOptions(input)
  if (o.background === 'color') {
    ctx.fillStyle = o.color
    ctx.fillRect(0, 0, layout.width, layout.height)
  } else if (o.background === 'blur') {
    ctx.fillStyle = o.color
    ctx.fillRect(0, 0, layout.width, layout.height)
    const blur = Math.max(6, Math.min(layout.width, layout.height) * 0.035)
    ctx.save()
    ctx.filter = `blur(${blur}px)`
    const over = blur * 2
    drawCover(
      ctx, source, sourceWidth, sourceHeight,
      -over, -over, layout.width + over * 2, layout.height + over * 2,
    )
    ctx.restore()
  }

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(
    source,
    layout.photo.x, layout.photo.y, layout.photo.w, layout.photo.h,
  )
}

export async function canvasFrameToBitmap(
  source: ImageBitmap,
  input: Partial<CanvasFrameOptions> = {},
): Promise<{ bitmap: ImageBitmap }> {
  const o = normalizeCanvasFrameOptions(input)
  const layout = canvasFrameLayout(source.width, source.height, o)
  const { canvas, ctx } = makeCanvas(layout.width, layout.height, '做不了这张画布')
  paintCanvasFrame(ctx, source, source.width, source.height, layout, o)
  return { bitmap: await createImageBitmap(canvas) }
}
