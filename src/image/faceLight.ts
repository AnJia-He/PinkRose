import type { FaceBox } from '../core/faceDetect'
import { makeCanvas } from '../core/canvas'

/**
 * 人像面部补光：在本地正脸框上做一层柔和的填充光。
 *
 * 暗处提得多、亮处提得少，接近白色的高光几乎不动 —— 这样逆光、窗边和
 * 夜景人像能把脸从阴影里拉出来，又不会把鼻梁 / 额头打成一片白。作用范围
 * 是脸框内的软边椭圆，脸外逐字节不变；0 = 不动。
 */
export type FaceLightOptions = {
  /** 补光强度 0~100；0 = 不动。 */
  strength?: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smoothstep = (lo: number, hi: number, v: number) => {
  const t = clamp((v - lo) / Math.max(1e-8, hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}
const luma = (r: number, g: number, b: number) => (0.299 * r + 0.587 * g + 0.114 * b) / 255

function ellipse(
  x: number, y: number, cx: number, cy: number, rx: number, ry: number,
): number {
  const d = Math.hypot((x - cx) / Math.max(1e-6, rx), (y - cy) / Math.max(1e-6, ry))
  if (d >= 1) return 0
  return 1 - smoothstep(0.66, 1, d)
}

/**
 * 原地补光。只扫脸框内椭圆的并集外接框，返回 RGB 真的变了的像素数。
 * alpha 不参与计算。
 */
export function faceLightPixels(
  data: Uint8ClampedArray, width: number, height: number,
  face: FaceBox, opts: FaceLightOptions = {},
): { changed: number } {
  if (data.length !== width * height * 4) {
    throw new Error(`像素尺寸和照片对不上（像素 ${data.length} 字节，照片 ${width}×${height}）`)
  }
  const raw = typeof opts.strength === 'number' && Number.isFinite(opts.strength)
    ? opts.strength
    : 0
  const strength = clamp(raw, 0, 100)
  if (strength <= 0 || face.w <= 0 || face.h <= 0) return { changed: 0 }

  const cx = face.x + face.w / 2
  const cy = face.y + face.h * 0.52
  const rx = face.w * 0.56
  const ry = face.h * 0.58
  const x0 = Math.max(0, Math.floor(cx - rx))
  const y0 = Math.max(0, Math.floor(cy - ry))
  const x1 = Math.min(width, Math.ceil(cx + rx))
  const y1 = Math.min(height, Math.ceil(cy + ry))
  if (x1 <= x0 || y1 <= y0) return { changed: 0 }

  let changed = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cov = ellipse(x, y, cx, cy, rx, ry)
      if (cov <= 0) continue
      const i = (y * width + x) * 4
      const r0 = data[i]!
      const g0 = data[i + 1]!
      const b0 = data[i + 2]!
      const l = luma(r0, g0, b0)
      const shadow = 1 - smoothstep(0.18, 0.82, l)
      const protect = 1 - smoothstep(0.70, 0.98, l)
      const amount = (strength / 100) * 0.38 * cov * shadow * protect
      if (amount <= 0) continue
      const nr = Math.round(r0 + (255 - r0) * amount)
      const ng = Math.round(g0 + (255 - g0) * amount)
      const nb = Math.round(b0 + (255 - b0) * amount)
      if (nr !== r0 || ng !== g0 || nb !== b0) {
        data[i] = nr
        data[i + 1] = ng
        data[i + 2] = nb
        changed++
      }
    }
  }
  return { changed }
}

/** 落到画布；`maxSide` 用于实时预览，提交时省略 = 原尺寸。 */
export async function faceLightToBitmap(
  source: ImageBitmap, face: FaceBox, opts: FaceLightOptions,
  maxSide = Number.POSITIVE_INFINITY,
): Promise<{ bitmap: ImageBitmap; changed: number; scale: number; face: FaceBox }> {
  const scale = Math.min(1, maxSide / Math.max(1, Math.max(source.width, source.height)))
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const { canvas, ctx } = makeCanvas(w, h, '补光失败', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  const image = ctx.getImageData(0, 0, w, h)
  const scaled: FaceBox = {
    x: face.x * scale, y: face.y * scale, w: face.w * scale, h: face.h * scale,
    confidence: face.confidence,
  }
  const { changed } = faceLightPixels(image.data, w, h, scaled, opts)
  if (changed > 0) ctx.putImageData(image, 0, 0)
  const bitmap = await createImageBitmap(canvas)
  return { bitmap, changed, scale, face: scaled }
}
