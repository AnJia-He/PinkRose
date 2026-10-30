import {
  useEffect, useRef, useState,
  type KeyboardEvent as RKeyboardEvent,
  type PointerEvent as RPointerEvent,
} from 'react'
import type { FaceBox } from '../core/faceDetect'
import { bindWindowDrag } from './kit/windowDrag.ts'

type Box = { left: number; top: number; width: number; height: number }
type Point = { x: number; y: number }

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * 自动人脸识别失败或认错时，让用户直接在照片上拖一个脸框。
 * 坐标统一换回原图像素；后续脸框蒙版和人像引擎仍消费同一个 FaceBox。
 */
export default function ManualFaceOverlay(props: {
  box: Box
  imageWidth: number
  imageHeight: number
  onPick: (face: FaceBox) => void
}) {
  const { box, imageWidth: W, imageHeight: H, onPick } = props
  const rootRef = useRef<HTMLDivElement | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const dragRef = useRef<{ start: Point; current: Point } | null>(null)
  const [preview, setPreview] = useState<{ start: Point; current: Point } | null>(null)
  const [keyboardFace, setKeyboardFace] = useState<FaceBox | null>(null)
  const minSide = Math.max(24, Math.min(W, H) * 0.035)

  const centeredFace = (): FaceBox => {
    const w = Math.min(W, Math.max(minSide, W * 0.32))
    const h = Math.min(H, Math.max(minSide, H * 0.48))
    return { x: (W - w) / 2, y: (H - h) / 2, w, h, confidence: 1 }
  }

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const toImage = (clientX: number, clientY: number, root: DOMRect): Point | null => {
    const sx = clientX - root.left - box.left
    const sy = clientY - root.top - box.top
    if (sx < 0 || sy < 0 || sx > box.width || sy > box.height) return null
    return {
      x: clamp((sx / Math.max(1, box.width)) * W, 0, W),
      y: clamp((sy / Math.max(1, box.height)) * H, 0, H),
    }
  }

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    setKeyboardFace(null)
    const root = rootRef.current?.getBoundingClientRect()
    if (!root) return
    const start = toImage(e.clientX, e.clientY, root)
    if (!start) return
    stopRef.current?.()
    dragRef.current = { start, current: start }
    setPreview({ start, current: start })

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const current = toImage(ev.clientX, ev.clientY, root)
      if (!current) return
      drag.current = current
      setPreview({ start: drag.start, current })
    }
    const onEnd = () => {
      const drag = dragRef.current
      dragRef.current = null
      stopRef.current = null
      setPreview(null)
      if (!drag) return
      const x0 = Math.min(drag.start.x, drag.current.x)
      const y0 = Math.min(drag.start.y, drag.current.y)
      const x1 = Math.max(drag.start.x, drag.current.x)
      const y1 = Math.max(drag.start.y, drag.current.y)
      if (x1 - x0 < minSide || y1 - y0 < minSide) return
      onPick({
        x: x0, y: y0, w: x1 - x0, h: y1 - y0, confidence: 1,
      })
    }
    stopRef.current = bindWindowDrag(onMove, onEnd).stop
  }

  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setKeyboardFace(null)
      setPreview(null)
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      e.stopPropagation()
      setPreview(null)
      setKeyboardFace(centeredFace())
      return
    }
    if (!keyboardFace) {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      e.stopPropagation()
      setKeyboardFace(centeredFace())
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      onPick(keyboardFace)
      setKeyboardFace(null)
      return
    }
    const moveStep = e.shiftKey ? 10 : 1
    const resizeStep = e.shiftKey ? 20 : 4
    let next = keyboardFace
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'
      || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const x = e.key === 'ArrowLeft' ? keyboardFace.x - moveStep
        : e.key === 'ArrowRight' ? keyboardFace.x + moveStep : keyboardFace.x
      const y = e.key === 'ArrowUp' ? keyboardFace.y - moveStep
        : e.key === 'ArrowDown' ? keyboardFace.y + moveStep : keyboardFace.y
      next = {
        ...keyboardFace,
        x: clamp(x, 0, Math.max(0, W - keyboardFace.w)),
        y: clamp(y, 0, Math.max(0, H - keyboardFace.h)),
      }
      e.preventDefault()
    } else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
      const grow = e.key === '+' || e.key === '='
      const delta = grow ? resizeStep : -resizeStep
      next = {
        ...keyboardFace,
        w: clamp(keyboardFace.w + delta, Math.min(minSide, W), W - keyboardFace.x),
        h: clamp(keyboardFace.h + delta, Math.min(minSide, H), H - keyboardFace.y),
      }
      e.preventDefault()
    } else {
      return
    }
    e.stopPropagation()
    setKeyboardFace(next)
  }

  useEffect(() => () => stopRef.current?.(), [])

  const shownFace = preview
    ? {
        x: Math.min(preview.start.x, preview.current.x),
        y: Math.min(preview.start.y, preview.current.y),
        w: Math.abs(preview.current.x - preview.start.x),
        h: Math.abs(preview.current.y - preview.start.y),
      }
    : keyboardFace
  const rect = shownFace && (() => {
    return {
      left: box.left + (shownFace.x / W) * box.width,
      top: box.top + (shownFace.y / H) * box.height,
      width: (shownFace.w / W) * box.width,
      height: (shownFace.h / H) * box.height,
    }
  })()

  return (
    <div
      ref={rootRef}
      className="face-pick"
      role="group"
      tabIndex={0}
      aria-label="手动圈脸"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <div className="face-pick-hint" role="status" aria-live="polite">
        {keyboardFace
          ? '方向键移动脸框，+ / − 调整大小，Enter 确定，Esc 取消'
          : '在照片上拖一个脸框，或按 Enter 放一个居中脸框'}
      </div>
      {rect && <div className="face-pick-frame" style={rect} />}
    </div>
  )
}
