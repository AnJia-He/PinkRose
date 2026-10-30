import { useEffect, useRef, type RefObject } from 'react'
import { duotonePixels, type DuotoneOptions } from '../image/duotone'

type Box = { left: number; top: number; width: number; height: number }

/**
 * 双色调预览：把当前 WebGL 画面（含调色结果）画到离屏画布上，映射颜色后再贴回来。
 * 只做预览、不接指针；成片在 `image/duotone.ts`。
 */
export default function DuotoneOverlay({
  box, options, sourceRef,
}: {
  box: Box
  options: DuotoneOptions
  sourceRef: RefObject<HTMLCanvasElement>
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const source = sourceRef.current
    if (!canvas || !source) return
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
    const pixelW = Math.max(1, Math.round(box.width * dpr))
    const pixelH = Math.max(1, Math.round(box.height * dpr))
    if (canvas.width !== pixelW) canvas.width = pixelW
    if (canvas.height !== pixelH) canvas.height = pixelH

    const off = document.createElement('canvas')
    off.width = pixelW
    off.height = pixelH
    const offCtx = off.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
    if (!offCtx) return
    offCtx.drawImage(source, 0, 0, pixelW, pixelH)
    const image = offCtx.getImageData(0, 0, pixelW, pixelH)
    duotonePixels(image.data, pixelW, pixelH, options)
    offCtx.putImageData(image, 0, 0)

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, pixelW, pixelH)
    ctx.drawImage(off, 0, 0)
  }, [box.width, box.height, options.shadow, options.highlight, options.intensity, sourceRef])

  return (
    <div
      className="duotone-preview"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="duotone-canvas" />
    </div>
  )
}
