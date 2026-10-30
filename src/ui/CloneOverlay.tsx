import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { bindWindowDrag } from './kit/windowDrag.ts'

export type ClonePoint = { x: number; y: number }

/**
 * 克隆图章的涂抹层。和液化层共用照片盒坐标、window 拖动收场；
 * 松手时把整条折线交给 App，避免拖动过程每帧重算整张画布。
 */
type Props = {
  box: { left: number; top: number; width: number; height: number }
  imageWidth: number
  imageHeight: number
  radius: number
  source: ClonePoint | null
  offset: ClonePoint | null
  onStroke: (points: ClonePoint[]) => void
}

export default function CloneOverlay({
  box, imageWidth: W, imageHeight: H, radius, source, offset, onStroke,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const aliveRef = useRef(true)
  const strokeRef = useRef<ClonePoint[] | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      stopRef.current?.()
    }
  }, [])

  const toImage = (clientX: number, clientY: number, ox: number, oy: number): ClonePoint => ({
    x: ((clientX - ox) / box.width) * W,
    y: ((clientY - oy) / box.height) * H,
  })

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const r = layerRef.current?.getBoundingClientRect()
    if (!r) return
    const p = toImage(e.clientX, e.clientY, r.left, r.top)
    if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) return
    stopRef.current?.()
    strokeRef.current = [p]
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })

    const onMove = (ev: PointerEvent) => {
      const pts = strokeRef.current
      if (!pts) return
      const q = toImage(ev.clientX, ev.clientY, r.left, r.top)
      const last = pts[pts.length - 1]!
      if (Math.hypot(q.x - last.x, q.y - last.y) >= Math.max(1, radius * 0.2)) pts.push(q)
      setCursor({ x: ev.clientX - r.left, y: ev.clientY - r.top })
    }
    const finish = () => {
      const pts = strokeRef.current
      strokeRef.current = null
      if (!pts || !aliveRef.current) return
      if (pts.length > 0) onStroke(pts)
    }
    const bound = bindWindowDrag(onMove, () => {
      stopRef.current = null
      finish()
    })
    stopRef.current = bound.stop
  }

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const r = layerRef.current?.getBoundingClientRect()
    if (!r || strokeRef.current) return
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })
  }

  const scale = W > 0 ? box.width / W : 1
  const size = Math.max(6, radius * scale * 2)
  const at = (p: ClonePoint) => ({
    left: (p.x / W) * box.width,
    top: (p.y / H) * box.height,
  })
  const sourcePos = source ? at(source) : null
  const follows = cursor && offset
    ? {
      left: cursor.x + (offset.x / W) * box.width,
      top: cursor.y + (offset.y / H) * box.height,
    }
    : null

  return (
    <div
      ref={layerRef}
      className="clone"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => { if (!strokeRef.current) setCursor(null) }}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      {sourcePos && (
        <span className="clone-source" style={sourcePos}>
          <span>源</span>
        </span>
      )}
      {follows && (
        <span
          className="clone-source-ring"
          style={{
            ...follows, width: size, height: size,
            marginLeft: -size / 2, marginTop: -size / 2,
          }}
        />
      )}
      {cursor && (
        <span
          className="clone-cursor"
          style={{
            left: cursor.x, top: cursor.y,
            width: size, height: size,
            marginLeft: -size / 2, marginTop: -size / 2,
          }}
        />
      )}
    </div>
  )
}
