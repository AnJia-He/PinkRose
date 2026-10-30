import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { bindWindowDrag } from './kit/windowDrag.ts'

/**
 * 照片上的**液化画笔层**（★ 2026-10-17）。
 *
 * 和涂抹层共用照片盒子坐标：指针 → 图片像素；拖动时画一圈笔刷和一条方向线，
 * **松手后**才把这一笔交给 App（`useLiquify` 在 pointerup 时落后一帧计算），
 * 所以拖动过程不会每帧做全图重采样。
 */
export type LiquifyBox = { left: number; top: number; width: number; height: number }
export type LiquifyDrag = {
  x0: number
  y0: number
  x1: number
  y1: number
}

type Props = {
  box: LiquifyBox
  imageWidth: number
  imageHeight: number
  radius: number
  onStroke: (stroke: LiquifyDrag) => void
}

export default function LiquifyOverlay({
  box, imageWidth: W, imageHeight: H, radius, onStroke,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const aliveRef = useRef(true)
  const dragRef = useRef<{
    start: LiquifyDrag; origin: { x: number; y: number }
  } | null>(null)
  const [drag, setDrag] = useState<LiquifyDrag | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    // ⚠️ StrictMode 会「挂载 → 卸载 → 再挂载」：第一次 cleanup 把 alive 置 false
    //    之后，重挂的 effect 必须把它拨回 true，否则松手那一笔永远被这里吞掉
    //    （2026-10-17 真机探针抓到：画笔有圈、方向线也有，就是 dirty 不亮）。
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      stopRef.current?.()
    }
  }, [])

  const toImage = (clientX: number, clientY: number, ox: number, oy: number): LiquifyDrag => ({
    // `ox/oy` 是这一层自己的屏幕原点（它已经被摆在 `box.left/top` 上），
    // 所以这里**不能再减一次 box 偏移**。
    x0: ((clientX - ox) / box.width) * W,
    y0: ((clientY - oy) / box.height) * H,
    x1: ((clientX - ox) / box.width) * W,
    y1: ((clientY - oy) / box.height) * H,
  })

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const r = layerRef.current?.getBoundingClientRect()
    if (!r) return
    const p = toImage(e.clientX, e.clientY, r.left, r.top)
    if (p.x0 < 0 || p.y0 < 0 || p.x0 > W || p.y0 > H) return
    stopRef.current?.()
    const start = { x0: p.x0, y0: p.y0, x1: p.x0, y1: p.y0 }
    dragRef.current = { start, origin: { x: r.left, y: r.top } }
    setDrag(start)
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const q = toImage(ev.clientX, ev.clientY, d.origin.x, d.origin.y)
      const next: LiquifyDrag = { ...d.start, x1: q.x0, y1: q.y0 }
      dragRef.current = { ...d, start: next }
      setDrag(next)
      setCursor({ x: ev.clientX - d.origin.x, y: ev.clientY - d.origin.y })
    }
    const finish = () => {
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!d || !aliveRef.current) return
      if (Math.hypot(d.start.x1 - d.start.x0, d.start.y1 - d.start.y0) >= 1) {
        onStroke(d.start)
      }
    }
    const bound = bindWindowDrag(onMove, () => {
      stopRef.current = null
      finish()
    })
    stopRef.current = bound.stop
  }

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const r = layerRef.current?.getBoundingClientRect()
    if (!r || dragRef.current) return
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })
  }

  const scale = W > 0 ? box.width / W : 1
  const cursorSize = Math.max(6, radius * scale * 2)
  const line = drag && (() => {
    const sx = (drag.x0 / W) * box.width
    const sy = (drag.y0 / H) * box.height
    const ex = (drag.x1 / W) * box.width
    const ey = (drag.y1 / H) * box.height
    return {
      left: sx, top: sy,
      width: Math.hypot(ex - sx, ey - sy),
      angle: Math.atan2(ey - sy, ex - sx) * 180 / Math.PI,
    }
  })()

  return (
    <div
      ref={layerRef}
      className="liquify"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => { if (!dragRef.current) setCursor(null) }}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      {line && (
        <span
          className="liquify-arrow"
          style={{
            left: line.left, top: line.top, width: line.width,
            transform: `rotate(${line.angle}deg)`,
          }}
        />
      )}
      {cursor && (
        <span
          className="liquify-cursor"
          style={{
            left: cursor.x, top: cursor.y,
            width: cursorSize, height: cursorSize,
            marginLeft: -cursorSize / 2, marginTop: -cursorSize / 2,
          }}
        />
      )}
    </div>
  )
}
