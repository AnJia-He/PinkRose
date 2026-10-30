import { useEffect, useRef, type PointerEvent as RPointerEvent } from 'react'
import {
  normalizeShapeOptions, shapeDrawing, type ShapeOptions,
} from '../image/shape'
import { bindWindowDrag } from './kit/windowDrag.ts'

/**
 * 照片上的**形状绘制层**（★ 2026-10-19）。
 *
 * 按下是起点、拖到哪里是终点；松手后形状留在原地，继续改颜色 / 线宽 /
 * 圆角 / 填充都只改选项，不重画像素。预览和成片共用 `image/shape.ts`
 * 的同一份 path。
 */
export type ShapeBox = { left: number; top: number; width: number; height: number }

type Props = {
  box: ShapeBox
  imageWidth: number
  imageHeight: number
  options: ShapeOptions
  onChange: (patch: Partial<ShapeOptions>) => void
  /** 已提交的形状层：只显示、不接收绘制手势。 */
  readOnly?: boolean
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const rgba = (hex: string, opacity: number) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity / 100})`
}

export default function ShapeOverlay({
  box, imageWidth, imageHeight, options, onChange, readOnly = false,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const stopRef = useRef<(() => void) | null>(null)

  useEffect(() => () => stopRef.current?.(), [])

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = layerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const point = (clientX: number, clientY: number) => ({
      x: clamp01((clientX - r.left) / r.width),
      y: clamp01((clientY - r.top) / r.height),
    })
    const start = point(e.clientX, e.clientY)
    onChange({ x1: start.x, y1: start.y, x2: start.x, y2: start.y })
    const onDrag = (ev: PointerEvent) => {
      const next = point(ev.clientX, ev.clientY)
      onChange({ x2: next.x, y2: next.y })
    }
    const d = bindWindowDrag(onDrag, () => { stopRef.current = null })
    stopRef.current = d.stop
  }

  const o = normalizeShapeOptions(options)
  const drawing = shapeDrawing(imageWidth, imageHeight, o)
  const fill = drawing.fill && (o.fill || drawing.fillWithStroke)
  return (
    <div
      ref={layerRef}
      className={`shape-layer${readOnly ? ' committed' : ''}`}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={readOnly ? undefined : onPointerDown}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <svg
        className="shape-preview"
        viewBox={`0 0 ${Math.max(1, imageWidth)} ${Math.max(1, imageHeight)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <g opacity={o.opacity / 100} style={{ mixBlendMode: o.blend }}>
          {fill && (
            <path
              d={drawing.fill!}
              fill={drawing.fillWithStroke ? o.color : rgba(o.fillColor, o.fillOpacity)}
            />
          )}
          <path
            d={drawing.stroke}
            fill="none"
            stroke={o.color}
            strokeWidth={drawing.strokePx}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </div>
  )
}
