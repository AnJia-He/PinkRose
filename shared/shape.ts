import { isBlendMode, type BlendMode } from './blend.ts'

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow'

export type ShapeOptions = {
  kind: ShapeKind
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  strokePct: number
  fill: boolean
  fillColor: string
  fillOpacity: number
  radiusPct: number
  opacity: number
  blend: BlendMode
}

export const DEFAULT_SHAPE: ShapeOptions = {
  kind: 'rect',
  x1: 0.18, y1: 0.2, x2: 0.82, y2: 0.8,
  color: '#ff3b30',
  strokePct: 0.8,
  fill: false,
  fillColor: '#ffffff',
  fillOpacity: 30,
  radiusPct: 0,
  opacity: 100,
  blend: 'normal',
}

export const SHAPE_STROKE_MIN = 0.2
export const SHAPE_STROKE_MAX = 8
export const SHAPE_RADIUS_MAX = 30

const SHAPES: readonly ShapeKind[] = ['rect', 'ellipse', 'line', 'arrow']
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const finiteOr = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const color = (v: unknown, fallback: string) =>
  typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback

export function normalizeShapeOptions(input: Partial<ShapeOptions> = {}): ShapeOptions {
  return {
    kind: SHAPES.includes(input.kind as ShapeKind) ? input.kind as ShapeKind : DEFAULT_SHAPE.kind,
    x1: clamp(finiteOr(input.x1, DEFAULT_SHAPE.x1), 0, 1),
    y1: clamp(finiteOr(input.y1, DEFAULT_SHAPE.y1), 0, 1),
    x2: clamp(finiteOr(input.x2, DEFAULT_SHAPE.x2), 0, 1),
    y2: clamp(finiteOr(input.y2, DEFAULT_SHAPE.y2), 0, 1),
    color: color(input.color, DEFAULT_SHAPE.color),
    strokePct: clamp(finiteOr(input.strokePct, DEFAULT_SHAPE.strokePct),
      SHAPE_STROKE_MIN, SHAPE_STROKE_MAX),
    fill: typeof input.fill === 'boolean' ? input.fill : DEFAULT_SHAPE.fill,
    fillColor: color(input.fillColor, DEFAULT_SHAPE.fillColor),
    fillOpacity: clamp(finiteOr(input.fillOpacity, DEFAULT_SHAPE.fillOpacity), 0, 100),
    radiusPct: clamp(finiteOr(input.radiusPct, DEFAULT_SHAPE.radiusPct), 0, SHAPE_RADIUS_MAX),
    opacity: clamp(finiteOr(input.opacity, DEFAULT_SHAPE.opacity), 0, 100),
    blend: isBlendMode(input.blend) ? input.blend : DEFAULT_SHAPE.blend,
  }
}

export type ShapeDrawing = {
  stroke: string
  fill: string | null
  strokePx: number
  fillWithStroke: boolean
}

const round = (v: number) => Math.round(v * 100) / 100

function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  x = round(x)
  y = round(y)
  w = round(w)
  h = round(h)
  r = round(Math.max(0, Math.min(r, w / 2, h / 2)))
  if (r <= 0.5) return `M ${x} ${y} H ${round(x + w)} V ${round(y + h)} H ${x} Z`
  return `M ${round(x + r)} ${y} H ${round(x + w - r)}`
    + ` Q ${round(x + w)} ${y} ${round(x + w)} ${round(y + r)}`
    + ` V ${round(y + h - r)} Q ${round(x + w)} ${round(y + h)} ${round(x + w - r)} ${round(y + h)}`
    + ` H ${round(x + r)} Q ${x} ${round(y + h)} ${x} ${round(y + h - r)}`
    + ` V ${round(y + r)} Q ${x} ${y} ${round(x + r)} ${y} Z`
}

/** 预览和成片共用的几何；坐标是图片像素。 */
export function shapeDrawing(
  width: number, height: number, input: Partial<ShapeOptions> = {},
): ShapeDrawing {
  const o = normalizeShapeOptions(input)
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const short = Math.min(w, h)
  const strokePx = Math.max(1, short * o.strokePct / 100)
  const x1 = o.x1 * w
  const y1 = o.y1 * h
  const x2 = o.x2 * w
  const y2 = o.y2 * h

  if (o.kind === 'line') {
    return {
      stroke: `M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}`,
      fill: null, strokePx, fillWithStroke: false,
    }
  }
  if (o.kind === 'arrow') {
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy)
    if (len < 0.001) {
      return { stroke: `M ${round(x1)} ${round(y1)}`, fill: null, strokePx, fillWithStroke: true }
    }
    const ux = dx / len
    const uy = dy / len
    const head = Math.min(Math.max(8, strokePx * 4.2), Math.max(1, len * 0.55))
    const half = head * 0.62
    const bx = x2 - ux * head
    const by = y2 - uy * head
    const px = -uy
    const py = ux
    return {
      stroke: `M ${round(x1)} ${round(y1)} L ${round(bx)} ${round(by)}`,
      fill: `M ${round(x2)} ${round(y2)}`
        + ` L ${round(bx + px * half)} ${round(by + py * half)}`
        + ` L ${round(bx - px * half)} ${round(by - py * half)} Z`,
      strokePx, fillWithStroke: true,
    }
  }

  const left = Math.min(x1, x2)
  const top = Math.min(y1, y2)
  const rw = Math.abs(x2 - x1)
  const rh = Math.abs(y2 - y1)
  if (o.kind === 'ellipse') {
    const cx = round((x1 + x2) / 2)
    const cy = round((y1 + y2) / 2)
    const rx = round(rw / 2)
    const ry = round(rh / 2)
    const d = `M ${round(cx - rx)} ${cy} A ${rx} ${ry} 0 1 0 ${round(cx + rx)} ${cy}`
      + ` A ${rx} ${ry} 0 1 0 ${round(cx - rx)} ${cy} Z`
    return { stroke: d, fill: d, strokePx, fillWithStroke: false }
  }
  const radius = short * o.radiusPct / 100
  const d = roundedRect(left, top, rw, rh, radius)
  return { stroke: d, fill: d, strokePx, fillWithStroke: false }
}
