/**
 * 本地人脸框估计（不是神经网络）。
 *
 * 用肤色连通域找正脸：取画面中部面积最大的一块肤色，按脸形比例收住高度，
 * 再把左右和额头各留一点余量。它不是关键点检测；眼睛位置在后续塑形里
 * 按脸框比例估计，所以只对正脸、脸占画面一定比例的照片可靠。
 */
export type FaceBox = {
  x: number
  y: number
  w: number
  h: number
  /** 0~1；越高表示肤色连通域越大、越居中。 */
  confidence: number
}

type Component = {
  area: number
  sumX: number
  sumY: number
  x0: number
  y0: number
  x1: number
  y1: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function assertPixels(data: Uint8ClampedArray, width: number, height: number): void {
  if (data.length !== width * height * 4) {
    throw new Error(`像素尺寸和照片对不上（像素 ${data.length} 字节，照片 ${width}×${height}）`)
  }
}

function skinMask(
  data: Uint8ClampedArray, width: number, height: number,
): Uint8Array {
  const n = width * height
  const skin = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * 4
    const r = data[p]! / 255
    const g = data[p + 1]! / 255
    const b = data[p + 2]! / 255
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 0.5
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 0.5
    if (y > 0.16 && cb > 0.34 && cb < 0.5 && cr > 0.54 && cr < 0.7) skin[i] = 1
  }
  return skin
}

function connectedComponents(
  skin: Uint8Array, width: number, height: number,
): Component[] {
  const n = width * height
  const seen = new Uint8Array(n)
  const queue = new Int32Array(n)
  const comps: Component[] = []
  for (let start = 0; start < n; start++) {
    if (!skin[start] || seen[start]) continue
    let head = 0
    let tail = 0
    let area = 0
    let sumX = 0
    let sumY = 0
    let x0 = width
    let y0 = height
    let x1 = 0
    let y1 = 0
    seen[start] = 1
    queue[tail++] = start
    while (head < tail) {
      const idx = queue[head++]!
      const x = idx % width
      const y = (idx / width) | 0
      area++
      sumX += x
      sumY += y
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x + 1 > x1) x1 = x + 1
      if (y + 1 > y1) y1 = y + 1
      const visit = (ni: number) => {
        if (skin[ni] && !seen[ni]) {
          seen[ni] = 1
          queue[tail++] = ni
        }
      }
      if (x > 0) visit(idx - 1)
      if (x + 1 < width) visit(idx + 1)
      if (y > 0) visit(idx - width)
      if (y + 1 < height) visit(idx + width)
    }
    comps.push({ area, sumX, sumY, x0, y0, x1, y1 })
  }
  return comps
}

function faceFromComponent(
  face: Component, width: number, height: number, areaRatio: number,
): FaceBox {
  const skinW = face.x1 - face.x0
  const padX = Math.max(1, Math.round(skinW * 0.06))
  const padTop = Math.max(1, Math.round(skinW * 0.1))
  const x = clamp(face.x0 - padX, 0, width - 1)
  const y = clamp(face.y0 - padTop, 0, height - 1)
  const w = clamp(skinW + padX * 2, 1, width - x)
  // 人像的肤色连通域常把脖子 / 胸口连进来；脸框高度按宽度收住。
  const h = clamp(Math.min(face.y1 - y, w * 1.45), 1, height - y)
  const confidence = clamp(0.55 + areaRatio * 1.5, 0.55, 0.96)
  return { x, y, w, h, confidence }
}

export function detectFaceBox(
  data: Uint8ClampedArray, width: number, height: number,
): FaceBox | null {
  assertPixels(data, width, height)
  const n = width * height
  const skin = skinMask(data, width, height)
  const comps = connectedComponents(skin, width, height)
  const minArea = Math.max(24, Math.round(n * 0.004))
  const candidates = comps.filter(c => {
    const cx = c.sumX / c.area
    const cy = c.sumY / c.area
    return c.area >= minArea
      && cx >= width * 0.18 && cx <= width * 0.82
      && cy >= height * 0.08 && cy <= height * 0.88
      && c.x1 - c.x0 >= width * 0.08
      && c.y1 - c.y0 >= height * 0.08
  })
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const ac = a.sumX / a.area
    const bc = b.sumX / b.area
    const aCenter = 1 - Math.abs(ac - width / 2) / (width / 2)
    const bCenter = 1 - Math.abs(bc - width / 2) / (width / 2)
    return (b.area * (1 + bCenter)) - (a.area * (1 + aCenter))
  })
  return faceFromComponent(candidates[0]!, width, height, candidates[0]!.area / n)
}

/**
 * 合影用的多脸检测（★ 2026-10-19）。
 *
 * 仍然是同一套肤色连通域，不做神经网络；区别只有筛选口径：
 *   · 允许脸更小、更靠画面边缘；
 *   · 先按面积从大到小，再用重叠率去掉「一张脸被拆成两块」的重复框；
 *   · 最多返回 `maxFaces` 张，避免把背景暖色块当成无限多的人脸。
 *
 * 它不保证每张都是真脸；调用方只在用户主动开「多人脸」时使用，
 * 并且所有像素操作仍然被软边脸框限制，误检最多是少改 / 多改一块皮肤，
 * 不会把整张照片重画。
 */
export function detectFaceBoxes(
  data: Uint8ClampedArray, width: number, height: number, maxFaces = 6,
): FaceBox[] {
  assertPixels(data, width, height)
  const n = width * height
  const skin = skinMask(data, width, height)
  const comps = connectedComponents(skin, width, height)
  const minArea = Math.max(36, Math.round(n * 0.0018))
  const candidates = comps.filter(c => {
    const cx = c.sumX / c.area
    const cy = c.sumY / c.area
    return c.area >= minArea
      && cx >= width * 0.04 && cx <= width * 0.96
      && cy >= height * 0.04 && cy <= height * 0.96
      && c.x1 - c.x0 >= width * 0.045
      && c.y1 - c.y0 >= height * 0.045
  })
  // 同一张脸常被阴影 / 高光拆成“大块 + 碎片”。这时 IoU 很小（大框占满
  // 并集），但碎片几乎全落在大框里。先产出候选框，再按“交集 / 较小框”
  // 收簇；同一簇只保留更靠上的框，因为脖子、肩膀和身体碎片都在脸下方。
  const boxes = candidates.map(c => faceFromComponent(c, width, height, c.area / n))
    .sort((a, b) => a.y - b.y || b.w * b.h - a.w * a.h)

  const out: FaceBox[] = []
  for (const box of boxes) {
    const aspect = box.w / Math.max(1, box.h)
    // 太宽的多半是手臂 / 暖色背景；太扁的也不是正脸。正常脸框
    // 经过高度收口后大致落在 0.55~1.6 之间。
    if (aspect < 0.55 || aspect > 1.6) continue
    if (box.w > width * 0.75 || box.h > height * 0.95) continue
    const overlaps = out.some(other => {
      const x0 = Math.max(box.x, other.x)
      const y0 = Math.max(box.y, other.y)
      const x1 = Math.min(box.x + box.w, other.x + other.w)
      const y1 = Math.min(box.y + box.h, other.y + other.h)
      if (x1 <= x0 || y1 <= y0) return false
      const inter = (x1 - x0) * (y1 - y0)
      const smaller = Math.min(box.w * box.h, other.w * other.h)
      return smaller > 0 && inter / smaller > 0.18
    })
    if (!overlaps) out.push(box)
    if (out.length >= Math.max(1, Math.floor(maxFaces))) break
  }
  return out
}
