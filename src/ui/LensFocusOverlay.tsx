/**
 * 镜头虚化的**可拖焦点**（★ 2026-10-19）。
 *
 * 只做一件事：把照片上那个小环的位置换算成 `lensFocusX/Y`（-100~100）。
 * 半径 / 过渡 / 强度仍然在面板里；这里只改焦点。
 *
 * ⚠️ 手势挂在 window 上（和裁剪 / 涂抹 / 对比把手同一条 `bindWindowDrag`），
 * 手拖出照片区也能继续拖；坐标最后夹在 0..1。
 * ⚠️ 容器本身 `pointer-events: none`，只有小环接事件 —— 不挡画布的平移/缩放。
 */
import {
  useEffect, useRef,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { bindWindowDrag } from './kit/windowDrag.ts'

export type LensFocusBox = { left: number; top: number; width: number; height: number }

type Props = {
  box: LensFocusBox
  /** 归一化焦点，0..1。 */
  x: number
  y: number
  onChange: (x: number, y: number) => void
  /** `tilt` = 移轴清晰带；清晰带只沿上下移动。 */
  shape?: 'radial' | 'tilt'
  /** 清晰带旋转角度（度）。 */
  angle?: number
  /** 清晰带半宽，0..1。 */
  band?: number
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

export default function LensFocusOverlay({
  box, x, y, onChange, shape = 'radial', angle = 0, band = 0.1,
}: Props) {
  const stopRef = useRef<(() => void) | null>(null)
  useEffect(() => () => stopRef.current?.(), [])
  const tilt = shape === 'tilt'

  const pointFrom = (clientX: number, clientY: number) => ({
    x: clamp01((clientX - box.left) / Math.max(1, box.width)),
    y: clamp01((clientY - box.top) / Math.max(1, box.height)),
  })
  const emit = (point: { x: number; y: number }) => {
    onChange(tilt ? 0.5 : point.x, point.y)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    stopRef.current?.()
    const first = pointFrom(e.clientX, e.clientY)
    emit(first)
    const drag = bindWindowDrag(ev => {
      const p = pointFrom(ev.clientX, ev.clientY)
      emit(p)
    }, () => {
      stopRef.current = null
    })
    stopRef.current = drag.stop
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02
    let nx = x
    let ny = y
    if (e.key === 'ArrowLeft') nx -= step
    else if (e.key === 'ArrowRight') nx += step
    else if (e.key === 'ArrowUp') ny -= step
    else if (e.key === 'ArrowDown') ny += step
    else if (e.key === 'Home') {
      e.preventDefault()
      onChange(0.5, 0.5)
      return
    } else return
    e.preventDefault()
    if (tilt && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return
    onChange(tilt ? 0.5 : clamp01(nx), clamp01(ny))
  }

  return (
    <div
      className="lens-focus"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      {tilt && (
        <div
          className="lens-focus-band"
          aria-hidden="true"
          style={{
            top: `${clamp01(y) * 100}%`,
            height: `${Math.max(2, clamp01(band) * 200)}%`,
            transform: `translate(-50%, -50%) rotate(${angle}deg)`,
          }}
        />
      )}
      <button
        type="button"
        className="lens-focus-handle"
        aria-label={tilt ? '移轴清晰带位置：上下拖动或方向键移动' : '镜头虚化焦点：拖动或方向键移动'}
        title={tilt ? '上下拖动清晰带' : '拖动虚化焦点'}
        style={{ left: `${clamp01(tilt ? 0.5 : x) * 100}%`, top: `${clamp01(y) * 100}%` }}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <span className="lens-focus-dot" aria-hidden="true" />
      </button>
    </div>
  )
}
