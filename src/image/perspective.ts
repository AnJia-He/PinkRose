import { makeCanvas } from '../core/canvas'
import {
  isIdentityPerspective, mapUnitSquare, perspectiveBounds, squareToQuad,
  type PerspectiveQuad,
} from '../core/perspective'

/** 纯函数：把四角透视落到像素缓冲。输出尺寸取四角外接框。 */
export function warpPerspectivePixels(
  data: Uint8ClampedArray, width: number, height: number, quad: PerspectiveQuad,
): { data: Uint8ClampedArray; width: number; height: number } {
  if (data.length !== width * height * 4) {
    throw new Error(`像素尺寸和照片对不上（像素 ${data.length} 字节，照片 ${width}×${height}）`)
  }
  const bounds = perspectiveBounds(quad, width, height)
  if (isIdentityPerspective(quad) && bounds.width === width && bounds.height === height) {
    return { data: data.slice(), width, height }
  }
  const m = squareToQuad(quad, width, height)
  const out = new Uint8ClampedArray(bounds.width * bounds.height * 4)
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const p = mapUnitSquare(m, x / bounds.width, y / bounds.height)
      const sx = Math.max(0, Math.min(width - 1, p.x))
      const sy = Math.max(0, Math.min(height - 1, p.y))
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const x1 = Math.min(width - 1, x0 + 1)
      const y1 = Math.min(height - 1, y0 + 1)
      const fx = sx - x0
      const fy = sy - y0
      const oi = (y * bounds.width + x) * 4
      for (let c = 0; c < 4; c++) {
        const a = data[(y0 * width + x0) * 4 + c]!
        const b = data[(y0 * width + x1) * 4 + c]!
        const d = data[(y1 * width + x0) * 4 + c]!
        const e = data[(y1 * width + x1) * 4 + c]!
        const top = a + (b - a) * fx
        const bottom = d + (e - d) * fx
        out[oi + c] = Math.round(top + (bottom - top) * fy)
      }
    }
  }
  return { data: out, width: bounds.width, height: bounds.height }
}

export async function perspectiveToBitmap(
  source: ImageBitmap, quad: PerspectiveQuad,
): Promise<ImageBitmap> {
  const w = source.width
  const h = source.height
  const { ctx } = makeCanvas(w, h, '透视不了', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0)
  const sourceImage = ctx.getImageData(0, 0, w, h)
  const warped = warpPerspectivePixels(sourceImage.data, w, h, quad)
  const { canvas: outCanvas, ctx: outCtx } = makeCanvas(warped.width, warped.height, '透视不了')
  const outImage = outCtx.createImageData(warped.width, warped.height)
  outImage.data.set(warped.data)
  outCtx.putImageData(outImage, 0, 0)
  return createImageBitmap(outCanvas, { premultiplyAlpha: 'none' })
}
