import { makeCanvas } from '../core/canvas'
import { BLEND_COMPOSITE } from './blend'
import {
  normalizeShapeOptions,
  shapeDrawing,
  type ShapeOptions,
} from '../../shared/shape.ts'

export {
  DEFAULT_SHAPE,
  SHAPE_RADIUS_MAX,
  SHAPE_STROKE_MAX,
  SHAPE_STROKE_MIN,
  normalizeShapeOptions,
  shapeDrawing,
  type ShapeDrawing,
  type ShapeKind,
  type ShapeOptions,
} from '../../shared/shape.ts'

const rgba = (hex: string, opacity: number) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity / 100})`
}

/** 把一层形状画进任意 2D 上下文（预览 / 导出共用）。 */
export function drawShapeOptions(
  ctx: CanvasRenderingContext2D,
  input: Partial<ShapeOptions>,
  width: number,
  height: number,
): void {
  const o = normalizeShapeOptions(input)
  if (o.opacity <= 0) return
  const drawing = shapeDrawing(width, height, o)
  ctx.save()
  ctx.globalAlpha = o.opacity / 100
  ctx.globalCompositeOperation = BLEND_COMPOSITE[o.blend]
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (drawing.fill && (o.fill || drawing.fillWithStroke)) {
    ctx.fillStyle = drawing.fillWithStroke ? o.color : rgba(o.fillColor, o.fillOpacity)
    ctx.fill(new Path2D(drawing.fill))
  }
  if (o.strokePct > 0) {
    ctx.strokeStyle = o.color
    ctx.lineWidth = drawing.strokePx
    ctx.stroke(new Path2D(drawing.stroke))
  }
  ctx.restore()
}

/** 把形状画进当前这一版底图，返回新位图（旧的烘焙路径）。 */
export async function shapeToBitmap(
  source: ImageBitmap, input: Partial<ShapeOptions> = {},
): Promise<{ bitmap: ImageBitmap }> {
  const { canvas, ctx } = makeCanvas(source.width, source.height, '画不上这个形状')
  ctx.drawImage(source, 0, 0)
  drawShapeOptions(ctx, input, source.width, source.height)
  return { bitmap: await createImageBitmap(canvas) }
}
