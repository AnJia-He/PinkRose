import type { FaceBox } from '../core/faceDetect'
import { makeCanvas } from '../core/canvas'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smoothstep = (lo: number, hi: number, v: number) => {
  const t = clamp((v - lo) / Math.max(1e-8, hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * 按正脸比例自动圈眼睛。眼睛位置是估计值（左右 30% / 70%，高度 42%），
 * 所以只做「亮眼」的初始选区，边缘仍可手动补涂。
 */
export function buildEyeMask(face: FaceBox, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height)
  const rx = Math.max(2, face.w * 0.19)
  const ry = Math.max(2, face.h * 0.11)
  const xs = [face.x + face.w * 0.3, face.x + face.w * 0.7]
  const cy = face.y + face.h * 0.42
  for (const cx of xs) {
    const x0 = clamp(Math.floor(cx - rx), 0, width)
    const y0 = clamp(Math.floor(cy - ry), 0, height)
    const x1 = clamp(Math.ceil(cx + rx), 0, width)
    const y1 = clamp(Math.ceil(cy + ry), 0, height)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = Math.hypot((x - cx) / rx, (y - cy) / ry)
        if (d >= 1) continue
        const cov = Math.round(255 * (1 - smoothstep(0.72, 1, d)))
        const i = y * width + x
        if (cov > mask[i]!) mask[i] = cov
      }
    }
  }
  return mask
}

/**
 * 按正脸比例自动圈眼下区域（黑眼圈 / 轻度眼袋）。
 *
 * 眼睛中心在脸高的 42%，所以眼下椭圆从 49% 铺到 63%：上缘不碰眼球，
 * 下缘停在鼻翼上方。左右两块的横向位置和自动眼一致，边缘留软过渡，
 * 用户仍可用画笔补涂或橡皮修回。
 */
export function buildUnderEyeMask(face: FaceBox, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height)
  const rx = Math.max(2, face.w * 0.17)
  const ry = Math.max(2, face.h * 0.07)
  const xs = [face.x + face.w * 0.3, face.x + face.w * 0.7]
  const cy = face.y + face.h * 0.56
  for (const cx of xs) {
    const x0 = clamp(Math.floor(cx - rx), 0, width)
    const y0 = clamp(Math.floor(cy - ry), 0, height)
    const x1 = clamp(Math.ceil(cx + rx), 0, width)
    const y1 = clamp(Math.ceil(cy + ry), 0, height)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = Math.hypot((x - cx) / rx, (y - cy) / ry)
        if (d >= 1) continue
        const cov = Math.round(255 * (1 - smoothstep(0.68, 1, d)))
        const i = y * width + x
        if (cov > mask[i]!) mask[i] = cov
      }
    }
  }
  return mask
}

/**
 * 牙齿不能只按嘴形圈：那会把红唇一起洗白。这里在嘴的椭圆内再加一道
 * 「亮 + 低饱和」颜色门，白牙留下，红唇压掉。
 */
export function buildTeethMask(
  data: Uint8ClampedArray, width: number, height: number, face: FaceBox,
): Uint8Array {
  const mask = new Uint8Array(width * height)
  const cx = face.x + face.w * 0.5
  const cy = face.y + face.h * 0.76
  const rx = Math.max(2, face.w * 0.25)
  const ry = Math.max(2, face.h * 0.12)
  const x0 = clamp(Math.floor(cx - rx), 0, width)
  const y0 = clamp(Math.floor(cy - ry), 0, height)
  const x1 = clamp(Math.ceil(cx + rx), 0, width)
  const y1 = clamp(Math.ceil(cy + ry), 0, height)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry)
      if (d >= 1) continue
      const i = y * width + x
      const p = i * 4
      const r = data[p]! / 255
      const g = data[p + 1]! / 255
      const b = data[p + 2]! / 255
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      const sat = mx <= 1e-6 ? 0 : (mx - mn) / mx
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const gate = smoothstep(0.25, 0.6, luma) * (1 - smoothstep(0.22, 0.5, sat))
      if (gate <= 0) continue
      mask[i] = Math.round(255 * gate * (1 - smoothstep(0.78, 1, d)))
    }
  }
  return mask
}

/** 从底图读一次像素，把自动眼 / 自动牙选区写进现有局部掩码。 */
export async function selectFacePartToMask(
  source: ImageBitmap, face: FaceBox, part: 'eyes' | 'teeth' | 'undereye', mask: Uint8Array,
): Promise<{ covered: number }> {
  const w = source.width
  const h = source.height
  if (mask.length !== w * h) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${mask.length} 字节，照片 ${w}×${h}）`)
  }
  let partMask: Uint8Array
  if (part === 'eyes') {
    partMask = buildEyeMask(face, w, h)
  } else if (part === 'undereye') {
    partMask = buildUnderEyeMask(face, w, h)
  } else {
    const { ctx } = makeCanvas(w, h, '找不到牙齿', { willReadFrequently: true })
    ctx.drawImage(source, 0, 0)
    const image = ctx.getImageData(0, 0, w, h)
    partMask = buildTeethMask(image.data, w, h, face)
  }
  mask.set(partMask)
  let covered = 0
  for (let i = 0; i < partMask.length; i++) if (partMask[i]! > 0) covered++
  return { covered }
}
