/**
 * **一键选背景**（★ 2026-10-17）—— 从种子像素做四连通颜色洪泛。
 *
 * 只选和种子**连通**且颜色接近的像素，所以同色的不相连区域（白墙 + 白衣服）
 * 不会被一起选中。掩码协议和点修 / 抠图共用：0~255，越大越透明。
 */
export type BackgroundPickResult = {
  mask: Uint8Array
  covered: number
  seed: [number, number, number]
  /** 实际用到的最大颜色距离（0~1，RGB 欧氏距离 / √3）。 */
  threshold: number
}

const dist = (
  r: number, g: number, b: number,
  sr: number, sg: number, sb: number,
): number => Math.hypot(r - sr, g - sg, b - sb) / 441.67295593

const smoothstep = (t: number) => {
  const u = Math.max(0, Math.min(1, t))
  return u * u * (3 - 2 * u)
}

export function selectBackgroundMask(
  data: Uint8ClampedArray, width: number, height: number,
  seedX: number, seedY: number, tolerance: number,
): BackgroundPickResult {
  if (data.length !== width * height * 4) {
    throw new Error(`像素尺寸和照片对不上（像素 ${data.length} 字节，照片 ${width}×${height}）`)
  }
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(seedX)))
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(seedY)))
  const seedIndex = y0 * width + x0
  const si = seedIndex * 4
  const seed: [number, number, number] = [data[si]!, data[si + 1]!, data[si + 2]!]
  const t = Math.max(0, Math.min(100, Number.isFinite(tolerance) ? tolerance : 0))
  // 0 = 只选完全同色；100 = 允许很宽的背景差异（但仍会受连通性约束）。
  const threshold = (t / 100) * 0.55
  const softStart = threshold * 0.7
  const mask = new Uint8Array(width * height)
  const seen = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0
  let covered = 0

  seen[seedIndex] = 1
  queue[tail++] = seedIndex
  while (head < tail) {
    const idx = queue[head++]!
    const x = idx % width
    const y = (idx / width) | 0
    const i = idx * 4
    const d = dist(data[i]!, data[i + 1]!, data[i + 2]!, seed[0], seed[1], seed[2])
    if (d > threshold) continue
    const soft = threshold <= 1e-8
      ? 1
      : d <= softStart
        ? 1
        : 1 - smoothstep((d - softStart) / Math.max(1e-8, threshold - softStart))
    const cov = Math.round(255 * soft)
    if (cov > 0) {
      mask[idx] = cov
      covered++
    }
    const push = (nx: number, ny: number) => {
      const ni = ny * width + nx
      if (seen[ni]) return
      seen[ni] = 1
      queue[tail++] = ni
    }
    if (x > 0) push(x - 1, y)
    if (x + 1 < width) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y + 1 < height) push(x, y + 1)
  }
  return { mask, covered, seed, threshold }
}
