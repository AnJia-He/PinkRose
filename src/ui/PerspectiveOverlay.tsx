import {
  useEffect, useRef,
  type KeyboardEvent as RKeyboardEvent,
  type PointerEvent as RPointerEvent,
} from 'react'
import { movePerspectiveHandle, type PerspectiveQuad } from '../core/perspective'
import { bindWindowDrag } from './kit/windowDrag.ts'

export type PerspectiveBox = { left: number; top: number; width: number; height: number }

const LABELS = ['左上', '右上', '右下', '左下'] as const

export default function PerspectiveOverlay(props: {
  box: PerspectiveBox
  quad: PerspectiveQuad
  onChange: (quad: PerspectiveQuad) => void
}) {
  const { box, quad, onChange } = props
  const layerRef = useRef<HTMLDivElement | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const workingRef = useRef<PerspectiveQuad>(quad)
  const aliveRef = useRef(true)

  useEffect(() => { workingRef.current = quad }, [quad])
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      stopRef.current?.()
    }
  }, [])

  const begin = (index: 0 | 1 | 2 | 3) => (e: RPointerEvent<HTMLSpanElement>) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const rect = layerRef.current?.getBoundingClientRect()
    if (!rect) return
    stopRef.current?.()
    workingRef.current = quad
    const onMove = (ev: PointerEvent) => {
      const next = movePerspectiveHandle(workingRef.current, index, {
        x: (ev.clientX - rect.left) / rect.width,
        y: (ev.clientY - rect.top) / rect.height,
      })
      workingRef.current = next
      if (aliveRef.current) onChange(next)
    }
    const d = bindWindowDrag(onMove, () => { stopRef.current = null })
    stopRef.current = d.stop
  }

  const onKey = (index: 0 | 1 | 2 | 3, e: RKeyboardEvent<HTMLSpanElement>) => {
    const pixels = e.shiftKey ? 10 : 1
    const current = quad[index]
    let x = current.x
    let y = current.y
    if (e.key === 'ArrowLeft') x -= pixels / Math.max(1, box.width)
    else if (e.key === 'ArrowRight') x += pixels / Math.max(1, box.width)
    else if (e.key === 'ArrowUp') y -= pixels / Math.max(1, box.height)
    else if (e.key === 'ArrowDown') y += pixels / Math.max(1, box.height)
    else return
    e.preventDefault()
    e.stopPropagation()
    onChange(movePerspectiveHandle(quad, index, { x, y }))
  }

  const points = quad.map(p => `${p.x * box.width},${p.y * box.height}`).join(' ')
  return (
    <div
      ref={layerRef}
      className="perspective"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <svg className="perspective-svg" width={box.width} height={box.height} aria-hidden="true">
        <polygon points={points} />
        <line
          x1={quad[0].x * box.width} y1={quad[0].y * box.height}
          x2={quad[2].x * box.width} y2={quad[2].y * box.height}
        />
        <line
          x1={quad[1].x * box.width} y1={quad[1].y * box.height}
          x2={quad[3].x * box.width} y2={quad[3].y * box.height}
        />
      </svg>
      {quad.map((p, i) => (
        <span
          key={LABELS[i]}
          className="perspective-handle"
          role="button"
          tabIndex={0}
          aria-label={`透视${LABELS[i]}角；方向键调整`}
          style={{ left: p.x * box.width, top: p.y * box.height }}
          onPointerDown={begin(i as 0 | 1 | 2 | 3)}
          onKeyDown={e => onKey(i as 0 | 1 | 2 | 3, e)}
        />
      ))}
    </div>
  )
}
