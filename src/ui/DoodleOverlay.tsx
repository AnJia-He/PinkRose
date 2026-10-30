import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { drawDoodle, type DoodlePoint, type DoodleStroke } from '../image/doodle'
import { bindWindowDrag } from './kit/windowDrag.ts'

export type DoodleBox = { left: number; top: number; width: number; height: number }

type Props = {
  box: DoodleBox
  strokes: readonly DoodleStroke[]
  color: string
  sizePct: number
  opacity: number
  onStroke: (stroke: DoodleStroke) => void
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/**
 * 照片上的涂鸦层（★ 2026-10-18）。
 *
 * 和贴纸 / 文字同一套盒子坐标：预览画布和照片可见矩形完全重合。
 * 拖动时只把归一化点交给父层；松手时交一整笔。预览和成片共用
 * `drawDoodle`，笔刷粗细、颜色、不透明度不会预览一套、导出另一套。
 */
export default function DoodleOverlay({
  box, strokes, color, sizePct, opacity, onStroke,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pointsRef = useRef<DoodlePoint[]>([])
  const stopRef = useRef<(() => void) | null>(null)
  const [current, setCurrent] = useState<DoodlePoint[] | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
    const w = Math.max(1, Math.round(box.width))
    const h = Math.max(1, Math.round(box.height))
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    drawDoodle(ctx, w, h, strokes)
    if (current && current.length > 0) {
      drawDoodle(ctx, w, h, [{ points: current, color, sizePct, opacity }])
    }
  }, [box.width, box.height, strokes, current, color, sizePct, opacity])

  useEffect(() => () => stopRef.current?.(), [])

  const pointOf = (
    clientX: number, clientY: number, left: number, top: number, pressure?: number,
  ): DoodlePoint => ({
      x: clamp01((clientX - left) / Math.max(1, box.width)),
      y: clamp01((clientY - top) / Math.max(1, box.height)),
      ...(pressure === undefined ? {} : { pressure }),
    })

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    stopRef.current?.()
    const rect = e.currentTarget.getBoundingClientRect()
    const first = pointOf(
      e.clientX, e.clientY, rect.left, rect.top,
      e.pointerType === 'pen' ? e.pressure : undefined,
    )
    pointsRef.current = [first]
    setCurrent([first])

    const onMove = (ev: PointerEvent) => {
      let added = false
      let samples: PointerEvent[]
      try {
        samples = ev.getCoalescedEvents?.() ?? [ev]
      } catch {
        samples = [ev]
      }
      for (const sample of samples) {
        const q = pointOf(
          sample.clientX, sample.clientY, rect.left, rect.top,
          sample.pointerType === 'pen' ? sample.pressure : undefined,
        )
        const last = pointsRef.current.at(-1)
        if (last && Math.hypot((q.x - last.x) * box.width, (q.y - last.y) * box.height) < 1) {
          continue
        }
        pointsRef.current.push(q)
        added = true
      }
      if (added) setCurrent([...pointsRef.current])
    }
    const d = bindWindowDrag(onMove, () => {
      const points = pointsRef.current
      if (points.length > 0) onStroke({ points, color, sizePct, opacity })
      pointsRef.current = []
      setCurrent(null)
      stopRef.current = null
    })
    stopRef.current = d.stop
  }

  return (
    <div
      className="doodle-layer"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={onPointerDown}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <canvas ref={canvasRef} className="doodle-canvas" aria-label="涂鸦预览" />
    </div>
  )
}
