import { makeCanvas } from '../core/canvas'
import { penPressureScale } from '../core/retouch'

/**
 * 涂鸦画笔（★ 2026-10-18）。
 *
 * 用户在照片上自由画线，松手记一笔；「应用涂鸦」时把已完成的所有笔画
 * 画进当前这一版底图。坐标全部是 0~1 的归一化值，预览和成片共用
 * `drawDoodle`，缩放窗口不会让位置漂。
 */
export type DoodlePoint = {
  x: number
  y: number
  /** Apple Pencil pressure (0..1). Missing = mouse / finger / old stroke. */
  pressure?: number
}

export type DoodleStroke = {
  points: readonly DoodlePoint[]
  color: string
  /** 笔刷直径，按照片短边的百分比。 */
  sizePct: number
  /** 0~100。 */
  opacity: number
}

export const DEFAULT_DOODLE = {
  color: '#ff4d4d',
  sizePct: 3,
  opacity: 100,
} as const

export type DoodleContext = Pick<
  CanvasRenderingContext2D,
  'save' | 'restore' | 'beginPath' | 'moveTo' | 'lineTo' | 'arc' | 'stroke' | 'fill'
> & {
  globalAlpha: number
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function drawDoodle(
  ctx: DoodleContext, width: number, height: number,
  strokes: readonly DoodleStroke[],
): void {
  const short = Math.max(1, Math.min(width, height))
  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue
    const lineWidth = Math.max(1, short * clamp(stroke.sizePct, 0.1, 50) / 100)
    ctx.save()
    ctx.globalAlpha = clamp(stroke.opacity, 0, 100) / 100
    ctx.strokeStyle = stroke.color
    ctx.fillStyle = stroke.color
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (stroke.points.length === 1) {
      const p = stroke.points[0]!
      const pointWidth = lineWidth * (p.pressure === undefined ? 1 : penPressureScale('pen', p.pressure))
      ctx.lineWidth = pointWidth
      ctx.beginPath()
      ctx.arc(p.x * width, p.y * height, pointWidth / 2, 0, Math.PI * 2)
      ctx.fill()
    } else if (stroke.points.some(p => p.pressure !== undefined)) {
      // Pressure may change between samples, so each segment gets its own
      // width. Round caps keep the joins continuous.
      for (let i = 1; i < stroke.points.length; i++) {
        const a = stroke.points[i - 1]!
        const b = stroke.points[i]!
        const wa = lineWidth * (a.pressure === undefined ? 1 : penPressureScale('pen', a.pressure))
        const wb = lineWidth * (b.pressure === undefined ? 1 : penPressureScale('pen', b.pressure))
        ctx.lineWidth = (wa + wb) / 2
        ctx.beginPath()
        ctx.moveTo(a.x * width, a.y * height)
        ctx.lineTo(b.x * width, b.y * height)
        ctx.stroke()
      }
    } else {
      const first = stroke.points[0]!
      ctx.beginPath()
      ctx.moveTo(first.x * width, first.y * height)
      for (let i = 1; i < stroke.points.length; i++) {
        const p = stroke.points[i]!
        ctx.lineTo(p.x * width, p.y * height)
      }
      ctx.stroke()
    }
    ctx.restore()
  }
}

/** 把已完成笔画画进当前这一版底图，返回新位图。 */
export async function doodleToBitmap(
  source: ImageBitmap, strokes: readonly DoodleStroke[],
): Promise<ImageBitmap> {
  const { canvas, ctx } = makeCanvas(source.width, source.height, '涂鸦画不上去')
  ctx.drawImage(source, 0, 0)
  drawDoodle(ctx, source.width, source.height, strokes)
  return createImageBitmap(canvas)
}
