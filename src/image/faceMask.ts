import type { FaceBox } from '../core/faceDetect'

/**
 * 脸框内的一张软边蒙版。
 *
 * 只给「人像 → 磨皮」用：椭圆比脸框略收一点，边缘用 smoothstep 柔和过渡，
 * 这样磨皮不会把脸外的背景、头发和衣服一起抹平。它和局部画笔共用 0~255
 * 覆盖率约定，0 = 不动，255 = 全作用。
 */
export type FaceMaskOptions = {
  /** 横向半径 = face.w × rx，默认 0.56。 */
  rx?: number
  /** 纵向半径 = face.h × ry，默认 0.58。 */
  ry?: number
  /** 软边起点（椭圆归一化距离），默认 0.66。 */
  soft?: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smoothstep = (lo: number, hi: number, v: number) => {
  const t = clamp((v - lo) / Math.max(1e-8, hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}

export function faceMask(
  width: number,
  height: number,
  face: FaceBox,
  opts: FaceMaskOptions = {},
): Uint8Array {
  const mask = new Uint8Array(width * height)
  if (width <= 0 || height <= 0 || face.w <= 0 || face.h <= 0) return mask

  const cx = face.x + face.w / 2
  const cy = face.y + face.h * 0.52
  const rx = face.w * (opts.rx ?? 0.56)
  const ry = face.h * (opts.ry ?? 0.58)
  const soft = clamp(opts.soft ?? 0.66, 0, 0.95)
  if (rx <= 0 || ry <= 0) return mask

  const x0 = Math.max(0, Math.floor(cx - rx))
  const y0 = Math.max(0, Math.floor(cy - ry))
  const x1 = Math.min(width, Math.ceil(cx + rx))
  const y1 = Math.min(height, Math.ceil(cy + ry))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry)
      if (d >= 1) continue
      const cov = 1 - smoothstep(soft, 1, d)
      if (cov > 0) mask[y * width + x] = Math.round(255 * cov)
    }
  }
  return mask
}
