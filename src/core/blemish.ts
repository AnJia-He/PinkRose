import type { FaceBox } from './faceDetect'
import { featherMask } from './retouch'

/**
 * 脸框内的小暗点检测。
 *
 * 这不是神经网络，也不承诺“认出所有痘印”。它只做一件保守的事：
 * 在脸框软边内找比周围局部均值明显更暗、面积很小、又不在眼睛 /
 * 眉毛 / 嘴 / 鼻影区域里的连通块。大的阴影、头发和五官会被排除；
 * 真正的斑点仍由用户预览确认。
 */
export type BlemishSpot = {
  x0: number
  y0: number
  x1: number
  y1: number
  area: number
}

export type BlemishOptions = {
  /** 0~100；0 = 不动，越高越愿意接受弱一点的小暗点。 */
  strength?: number
}

export type BlemishResult = {
  /** 全图尺寸的软边蒙版，0~255。 */
  mask: Uint8Array
  /** 保留下来的斑点外接框；按从上到下、从左到右的顺序。 */
  spots: BlemishSpot[]
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const lumaOf = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b

function skinGate(r: number, g: number, b: number): boolean {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const y = 0.299 * rn + 0.587 * gn + 0.114 * bn
  const cb = -0.168736 * rn - 0.331264 * gn + 0.5 * bn + 0.5
  const cr = 0.5 * rn - 0.418688 * gn - 0.081312 * bn + 0.5
  return y > 0.16 && cb > 0.34 && cb < 0.5 && cr > 0.54 && cr < 0.7
}

/** 局部盒均值（可分离两趟），只处理脸框周围的小裁剪。 */
function boxMean(
  src: Float32Array, w: number, h: number, r: number,
  dst: Float32Array, tmp: Float32Array,
): void {
  const win = r * 2 + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let k = -r; k <= r; k++) sum += src[row + clamp(k, 0, w - 1)]!
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win
      sum -= src[row + clamp(x - r, 0, w - 1)]!
      sum += src[row + clamp(x + r + 1, 0, w - 1)]!
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += tmp[clamp(k, 0, h - 1) * w + x]!
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / win
      sum -= tmp[clamp(y - r, 0, h - 1) * w + x]!
      sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x]!
    }
  }
}

/**
 * 检测小暗点。
 *
 * `coverage` 是 `image/faceMask` 产出的脸框软边蒙版；本函数只遍历
 * 脸框外接框，不扫整张照片。为什么先排除五官：深色睫毛、眉毛和嘴角
 * 的高反差比痘印强得多，不排除的话它们会被当成最大的“斑”。
 */
export function detectBlemishes(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  face: FaceBox,
  coverage: Uint8Array,
  opts: BlemishOptions = {},
): BlemishResult {
  if (data.length !== width * height * 4) {
    throw new Error(`像素尺寸和照片对不上（像素 ${data.length} 字节，照片 ${width}×${height}）`)
  }
  if (coverage.length !== width * height) {
    throw new Error('去斑蒙版尺寸和照片对不上')
  }
  const empty = new Uint8Array(width * height)
  const strength = clamp(opts.strength ?? 60, 0, 100)
  if (strength <= 0 || face.w <= 0 || face.h <= 0) return { mask: empty, spots: [] }

  const pad = Math.max(8, Math.round(Math.max(face.w, face.h) * 0.12))
  const cx0 = Math.max(0, Math.floor(face.x - pad))
  const cy0 = Math.max(0, Math.floor(face.y - pad))
  const cx1 = Math.min(width, Math.ceil(face.x + face.w + pad))
  const cy1 = Math.min(height, Math.ceil(face.y + face.h + pad))
  const cw = cx1 - cx0
  const ch = cy1 - cy0
  if (cw <= 0 || ch <= 0) return { mask: empty, spots: [] }

  const lum = new Float32Array(cw * ch)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = ((cy0 + y) * width + cx0 + x) * 4
      lum[y * cw + x] = lumaOf(data[i]!, data[i + 1]!, data[i + 2]!)
    }
  }
  const radius = Math.max(2, Math.round(Math.min(face.w, face.h) * 0.018))
  const tmp = new Float32Array(cw * ch)
  const blur = new Float32Array(cw * ch)
  boxMean(lum, cw, ch, radius, blur, tmp)

  const threshold = Math.max(5, 16 - strength * 0.11)
  const candidate = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const gx = cx0 + x
      const gy = cy0 + y
      const gi = gy * width + gx
      if (coverage[gi]! < 32) continue
      const nx = (gx - face.x) / face.w
      const ny = (gy - face.y) / face.h
      if (ny < 0.12) continue
      if (ny > 0.22 && ny < 0.34 && nx > 0.15 && nx < 0.85) continue // 眉毛
      if (ny > 0.28 && ny < 0.48 && ((nx > 0.18 && nx < 0.42) || (nx > 0.58 && nx < 0.82))) continue // 眼睛
      if (ny > 0.48 && ny < 0.60 && nx > 0.42 && nx < 0.58) continue // 鼻影
      if (ny > 0.62 && ny < 0.80 && nx > 0.32 && nx < 0.68) continue // 嘴

      const i = gi * 4
      if (!skinGate(data[i]!, data[i + 1]!, data[i + 2]!)) continue
      const p = y * cw + x
      const local = lum[p]!
      const mean = blur[p]!
      if (mean < 25 || mean > 235) continue
      if (local - mean >= -threshold) continue
      candidate[p] = 1
    }
  }

  const seen = new Uint8Array(cw * ch)
  const queue = new Int32Array(cw * ch)
  const kept: BlemishSpot[] = []
  const maxArea = Math.max(24, Math.round(face.w * face.h * 0.0025))
  const maxW = Math.max(8, Math.round(face.w * 0.1))
  const maxH = Math.max(8, Math.round(face.h * 0.1))
  for (let start = 0; start < candidate.length; start++) {
    if (!candidate[start] || seen[start]) continue
    let head = 0
    let tail = 0
    let area = 0
    let sumDetail = 0
    let x0 = cw
    let y0 = ch
    let x1 = 0
    let y1 = 0
    seen[start] = 1
    queue[tail++] = start
    while (head < tail) {
      const p = queue[head++]!
      const x = p % cw
      const y = (p / cw) | 0
      area++
      sumDetail += lum[p]! - blur[p]!
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x + 1 > x1) x1 = x + 1
      if (y + 1 > y1) y1 = y + 1
      const visit = (np: number) => {
        if (candidate[np] && !seen[np]) {
          seen[np] = 1
          queue[tail++] = np
        }
      }
      if (x > 0) visit(p - 1)
      if (x + 1 < cw) visit(p + 1)
      if (y > 0) visit(p - cw)
      if (y + 1 < ch) visit(p + cw)
    }
    const bw = x1 - x0
    const bh = y1 - y0
    if (area < 3 || area > maxArea) continue
    if (bw > maxW || bh > maxH) continue
    if (Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)) > 2.5) continue
    if (sumDetail / area >= -threshold * 0.55) continue
    kept.push({ x0: cx0 + x0, y0: cy0 + y0, x1: cx0 + x1, y1: cy0 + y1, area })
  }
  if (kept.length === 0) return { mask: empty, spots: [] }

  const mask = new Uint8Array(width * height)
  for (const spot of kept) {
    for (let y = spot.y0; y < spot.y1; y++) {
      for (let x = spot.x0; x < spot.x1; x++) {
        const p = y * width + x
        if (candidate[(y - cy0) * cw + x - cx0]) mask[p] = 255
      }
    }
  }
  const soft = featherMask(mask, width, height, Math.max(1, Math.round(Math.min(face.w, face.h) * 0.004)))
  return { mask: soft, spots: kept }
}
