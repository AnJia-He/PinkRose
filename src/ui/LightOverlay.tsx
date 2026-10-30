import { useEffect, useRef } from 'react'
import { drawLight, type LightOptions } from '../image/light'

export type LightBox = { left: number; top: number; width: number; height: number }

/** 光效预览：只在照片可见矩形上画，不接指针；成片在 `image/light.ts`。 */
export default function LightOverlay({
  box, options,
}: { box: LightBox; options: LightOptions }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

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
    drawLight(ctx, w, h, options)
  }, [box.width, box.height, options.preset, options.intensity, options.angle, options.warmth])

  return (
    <div
      className="light-layer"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <canvas ref={canvasRef} className="light-canvas" aria-label="光效预览" />
    </div>
  )
}
