import { useEffect, useRef, type RefObject } from 'react'
import {
  canvasFrameLayout, paintCanvasFrame, type CanvasFrameOptions,
} from '../image/canvasFrame'

/**
 * 画布扩展的准确预览：把当前 WebGL 画布（含调色结果）重新排进目标画布。
 * 外层盖住原来的照片区，内层画布按目标比例居中；透明背景显示棋盘格。
 */
export default function CanvasFrameOverlay(props: {
  box: { left: number; top: number; width: number; height: number }
  imageWidth: number
  imageHeight: number
  options: CanvasFrameOptions
  sourceRef: RefObject<HTMLCanvasElement>
}) {
  const { box, imageWidth, imageHeight, options, sourceRef } = props
  const previewRef = useRef<HTMLCanvasElement | null>(null)
  const layout = canvasFrameLayout(imageWidth, imageHeight, options)
  const aspect = layout.width / Math.max(1, layout.height)
  const targetW = Math.max(1, Math.min(box.width, box.height * aspect))
  const targetH = Math.max(1, targetW / aspect)
  const dpr = typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1)

  useEffect(() => {
    const canvas = previewRef.current
    const source = sourceRef.current
    if (!canvas || !source) return
    const pixelW = Math.max(1, Math.round(targetW * dpr))
    const pixelH = Math.max(1, Math.round(targetH * dpr))
    if (canvas.width !== pixelW) canvas.width = pixelW
    if (canvas.height !== pixelH) canvas.height = pixelH
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, pixelW, pixelH)
    ctx.scale(dpr, dpr)
    const scale = targetW / Math.max(1, layout.width)
    ctx.scale(scale, scale)
    paintCanvasFrame(ctx, source, imageWidth, imageHeight, layout, options)
  })

  return (
    <div
      className="canvas-frame-preview"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      aria-hidden="true"
    >
      <canvas
        ref={previewRef}
        className={`canvas-frame-preview-canvas${options.background === 'transparent' ? ' transparent' : ''}`}
        style={{ width: targetW, height: targetH }}
      />
    </div>
  )
}
