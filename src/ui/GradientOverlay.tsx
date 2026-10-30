import { useEffect, useId, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import type { GradientSpec } from '../core/gradientMask'

/**
 * 照片上的**线性 / 径向渐变蒙版预览层**（★ 2026-10-17）。
 *
 * 用户按住并拖一条线：
 * - 线性：起点之前全生效，终点之后归零，中间平滑过渡；
 * - 径向：起点是圆心，拖到哪儿就是外半径。
 *
 * 拖动过程只画预览，松手才把一次完整的 `GradientSpec` 交回上层。这样
 * 1200×800 的蒙版不会每帧重算；真正写掩码是在「应用局部」之前。
 */
export type GradientBox = { left: number; top: number; width: number; height: number }

type Props = {
  box: GradientBox
  spec: GradientSpec
  onChange: (spec: GradientSpec) => void
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

export default function GradientOverlay({
  box, spec, onChange,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const aliveRef = useRef(true)
  const [draft, setDraft] = useState<GradientSpec | null>(null)
  const gradientId = `gradient-mask-${useId().replace(/:/g, '')}`

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      stopRef.current?.()
    }
  }, [])

  const toNorm = (clientX: number, clientY: number, ox: number, oy: number) => ({
    x: clamp01((clientX - ox) / box.width),
    y: clamp01((clientY - oy) / box.height),
  })

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const rect = layerRef.current?.getBoundingClientRect()
    if (!rect) return
    const start = toNorm(e.clientX, e.clientY, rect.left, rect.top)
    const next: GradientSpec = { ...spec, start, end: start }
    setDraft(next)
    stopRef.current?.()

    let end = start
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      stopRef.current = null
    }
    const onMove = (ev: PointerEvent) => {
      end = toNorm(ev.clientX, ev.clientY, rect.left, rect.top)
      if (aliveRef.current) setDraft({ ...spec, start, end })
    }
    const onUp = (ev: PointerEvent) => {
      end = toNorm(ev.clientX, ev.clientY, rect.left, rect.top)
      cleanup()
      if (!aliveRef.current) return
      setDraft(null)
      const dx = (end.x - start.x) * box.width
      const dy = (end.y - start.y) * box.height
      if (Math.hypot(dx, dy) >= 4) onChange({ ...spec, start, end })
    }
    const onCancel = () => {
      cleanup()
      if (aliveRef.current) setDraft(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    stopRef.current = cleanup
  }

  const shown = draft ?? spec
  const sx = shown.start.x * box.width
  const sy = shown.start.y * box.height
  const ex = shown.end.x * box.width
  const ey = shown.end.y * box.height
  const radius = Math.hypot(ex - sx, ey - sy)
  const innerOffset = shown.kind === 'radial' && radius > 0
    ? clamp01(1 - shown.feather)
    : 0

  return (
    <div
      ref={layerRef}
      className="gradient-mask"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={onPointerDown}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <svg className="gradient-mask-svg" width={box.width} height={box.height} aria-hidden="true">
        <defs>
          {shown.kind === 'linear' ? (
            <linearGradient
              id={gradientId} gradientUnits="userSpaceOnUse"
              x1={sx} y1={sy} x2={ex} y2={ey}
            >
              <stop offset="0" stopColor="currentColor" stopOpacity=".28" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          ) : (
            <radialGradient
              id={gradientId} gradientUnits="userSpaceOnUse"
              cx={sx} cy={sy} r={Math.max(1, radius)}
            >
              <stop offset={innerOffset} stopColor="currentColor" stopOpacity=".28" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </radialGradient>
          )}
        </defs>
        <rect width={box.width} height={box.height} fill={`url(#${gradientId})`} />
        <line
          x1={sx} y1={sy} x2={ex} y2={ey}
          stroke="currentColor" strokeWidth="1.5" strokeDasharray="5 4"
        />
        <circle
          cx={sx} cy={sy} r="5"
          fill="currentColor" stroke="rgba(0,0,0,.55)" strokeWidth="1.5"
        />
        {shown.kind === 'radial' && radius > 0 && (
          <circle
            cx={sx} cy={sy} r={radius}
            fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="5 4"
          />
        )}
        {shown.kind === 'linear' && (
          <circle
            cx={ex} cy={ey} r="4"
            fill="none" stroke="currentColor" strokeWidth="1.5"
          />
        )}
        <title>{shown.kind === 'linear' ? '拖出线性渐变方向和范围' : '从圆心拖出径向渐变范围'}</title>
      </svg>
    </div>
  )
}
