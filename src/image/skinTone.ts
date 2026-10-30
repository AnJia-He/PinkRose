import type { FaceBox } from '../core/faceDetect'
import { maskBounds } from '../core/retouch'
import { faceMask } from './faceMask'
import { makeCanvas } from '../core/canvas'

/**
 * 人像肤色：在脸框软边蒙版里再做一层肤色判断，只提亮 / 加红润皮肤，
 * 避开眼睛、嘴唇、头发和背景。
 *
 * 美白走「向白抬升、越亮越收」的路子，保留毛孔和明暗；红润只抬红通道并
 * 轻收绿 / 蓝，避免整张脸变成统一的粉色。0 = 一个字节都不动。
 */
export type SkinToneOptions = {
  /** 美白 0~100；0 = 不动。 */
  whiten?: number
  /** 红润 0~100；0 = 不动。 */
  rosy?: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smoothstep = (lo: number, hi: number, v: number) => {
  const t = clamp((v - lo) / Math.max(1e-8, hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}
const luma = (r: number, g: number, b: number) => (0.299 * r + 0.587 * g + 0.114 * b) / 255

/** 软边椭圆排除区：中心 0，边缘 1。用于眼睛和嘴唇。 */
function outsideEllipse(
  x: number, y: number, cx: number, cy: number, rx: number, ry: number,
): number {
  const d = Math.hypot((x - cx) / Math.max(1e-6, rx), (y - cy) / Math.max(1e-6, ry))
  return smoothstep(0.82, 1.18, d)
}

/** YCbCr 肤色门：暖肤色在门内，黑发 / 眼白 / 牙齿在门外。 */
function skinGate(r: number, g: number, b: number): number {
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  const chroma = smoothstep(70, 82, cb) * (1 - smoothstep(128, 140, cb))
    * smoothstep(128, 136, cr) * (1 - smoothstep(178, 190, cr))
  const light = smoothstep(0.10, 0.20, luma(r, g, b))
  return chroma * light
}

/** 原地调肤色；返回 RGB 真正变化的像素数。alpha 不参与计算。 */
export function skinTonePixels(
  data: Uint8ClampedArray, width: number, height: number,
  face: FaceBox, opts: SkinToneOptions = {},
): { changed: number } {
  if (data.length !== width * height * 4) {
    throw new Error(`像素尺寸和照片对不上（像素 ${data.length} 字节，照片 ${width}×${height}）`)
  }
  const whiten = clamp(
    typeof opts.whiten === 'number' && Number.isFinite(opts.whiten) ? opts.whiten : 0,
    0, 100,
  ) / 100
  const rosy = clamp(
    typeof opts.rosy === 'number' && Number.isFinite(opts.rosy) ? opts.rosy : 0,
    0, 100,
  ) / 100
  if ((whiten <= 0 && rosy <= 0) || face.w <= 0 || face.h <= 0) return { changed: 0 }

  const mask = faceMask(width, height, face)
  const bounds = maskBounds(mask, width, height)
  if (!bounds) return { changed: 0 }

  const cx = face.x + face.w / 2
  const eyeY = face.y + face.h * 0.38
  const mouthY = face.y + face.h * 0.76
  let changed = 0
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const base = mask[mi]! / 255
      if (base <= 0) continue
      const i = mi * 4
      const r0 = data[i]!
      const g0 = data[i + 1]!
      const b0 = data[i + 2]!
      const skin = skinGate(r0, g0, b0)
      if (skin <= 0) continue
      const eyes = outsideEllipse(x, y, cx - face.w * 0.22, eyeY, face.w * 0.11, face.h * 0.07)
        * outsideEllipse(x, y, cx + face.w * 0.22, eyeY, face.w * 0.11, face.h * 0.07)
      const mouth = outsideEllipse(x, y, cx, mouthY, face.w * 0.19, face.h * 0.085)
      const cov = base * skin * eyes * mouth
      if (cov <= 0) continue

      let r = r0
      let g = g0
      let b = b0
      if (whiten > 0) {
        const l = luma(r0, g0, b0)
        const protect = 1 - smoothstep(0.72, 0.96, l)
        const amount = whiten * 0.24 * cov * protect
        r += (255 - r) * amount
        g += (255 - g) * amount * 0.98
        b += (255 - b) * amount * 0.94
      }
      if (rosy > 0) {
        const amount = rosy * 0.22 * cov
        r += (255 - r) * amount
        g -= g * 0.020 * amount
        b -= b * 0.008 * amount
      }

      const nr = Math.round(r)
      const ng = Math.round(g)
      const nb = Math.round(b)
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
export async function skinToneToBitmap(
  source: ImageBitmap, face: FaceBox, opts: SkinToneOptions,
  maxSide = Number.POSITIVE_INFINITY,
): Promise<{ bitmap: ImageBitmap; changed: number; scale: number; face: FaceBox }> {
  const scale = Math.min(1, maxSide / Math.max(1, Math.max(source.width, source.height)))
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const { canvas, ctx } = makeCanvas(w, h, '肤色调整失败', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  const image = ctx.getImageData(0, 0, w, h)
  const scaled: FaceBox = {
    x: face.x * scale, y: face.y * scale, w: face.w * scale, h: face.h * scale,
    confidence: face.confidence,
  }
  const { changed } = skinTonePixels(image.data, w, h, scaled, opts)
  if (changed > 0) ctx.putImageData(image, 0, 0)
  const bitmap = await createImageBitmap(canvas)
  return { bitmap, changed, scale, face: scaled }
}
