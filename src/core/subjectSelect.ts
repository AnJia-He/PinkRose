/**
 * 本地「智能主体」前景估计。
 *
 * 这不是神经网络分割：从画面顶部和左右上缘学一套背景色模型，按颜色距离生成
 * 候选前景，再由边缘向内洪泛、连通域过滤和软边收口。它适合背景相对干净的
 * 人像 / 商品图；发丝、透明物体等边缘仍交给现有画笔修。
 *
 * 输出沿用抠图掩码协议：`mask[i] = 255` 表示这块背景要去掉，0 表示主体保留。
 */
export type SubjectMaskResult = {
  mask: Uint8Array
  /** 主体像素 / 全图像素（按低分辨率候选掩码算）。 */
  subjectRatio: number
  /** 实际使用的颜色距离阈值（0~1）。 */
  threshold: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const MAX_BORDER_SAMPLES = 3000
const KMEANS_K = 5
const KMEANS_ITERATIONS = 8
/** 相邻像素最大通道差超过这个值 = 一道边，洪泛不许跨过去。 */
const EDGE_STEP = 0.035

type Center = [number, number, number]

/**
 * 从顶部和左右上缘取背景样本。底部故意少取：人像、商品常常触底，
 * 把主体颜色当成背景会直接把它删掉。
 */
function borderSamples(data: Uint8ClampedArray, w: number, h: number): Center[] {
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.045))
  const sideBottom = Math.max(1, Math.round(h * 0.8))
  const count = w * band + band * sideBottom * 2
  const stride = Math.max(1, Math.ceil(count / MAX_BORDER_SAMPLES))
  const out: Center[] = []
  let n = 0
  const push = (x: number, y: number) => {
    if (n++ % stride !== 0) return
    const i = (y * w + x) * 4
    out.push([data[i]!, data[i + 1]!, data[i + 2]!])
  }
  for (let y = 0; y < band; y++) {
    for (let x = 0; x < w; x++) push(x, y)
  }
  for (let y = band; y < sideBottom; y++) {
    for (let x = 0; x < band; x++) push(x, y)
    for (let x = Math.max(band, w - band); x < w; x++) push(x, y)
  }
  return out
}

function nearestCenterDistance(
  r: number, g: number, b: number, centers: readonly Center[],
): number {
  let best = Number.POSITIVE_INFINITY
  for (const c of centers) {
    const dr = r - c[0]
    const dg = g - c[1]
    const db = b - c[2]
    const d = dr * dr + dg * dg + db * db
    if (d < best) best = d
  }
  return Math.sqrt(best) / 441.67295593
}

function clusterBackground(samples: readonly Center[]): Center[] {
  if (samples.length === 0) return [[0, 0, 0]]
  const k = Math.max(1, Math.min(KMEANS_K, samples.length))
  const centers: Center[] = []
  for (let i = 0; i < k; i++) {
    centers.push(samples[Math.floor((i + 0.5) * samples.length / k)]!)
  }
  const sums = Array.from({ length: k }, () => [0, 0, 0, 0])
  for (let iter = 0; iter < KMEANS_ITERATIONS; iter++) {
    for (const s of sums) {
      s[0] = 0; s[1] = 0; s[2] = 0; s[3] = 0
    }
    for (const s of samples) {
      let bi = 0
      let bd = Number.POSITIVE_INFINITY
      for (let ci = 0; ci < centers.length; ci++) {
        const c = centers[ci]!
        const dr = s[0] - c[0]
        const dg = s[1] - c[1]
        const db = s[2] - c[2]
        const d = dr * dr + dg * dg + db * db
        if (d < bd) { bd = d; bi = ci }
      }
      const sum = sums[bi]!
      sum[0] += s[0]; sum[1] += s[1]; sum[2] += s[2]; sum[3]++
    }
    for (let ci = 0; ci < centers.length; ci++) {
      const sum = sums[ci]!
      if (sum[3]! > 0) {
        centers[ci] = [sum[0]! / sum[3]!, sum[1]! / sum[3]!, sum[2]! / sum[3]!]
      }
    }
  }
  return centers
}

/** Otsu 阈值：把「离背景色近」和「离背景色远」两堆分开。 */
function otsuThreshold(distances: Float32Array): number {
  const hist = new Uint32Array(256)
  for (let i = 0; i < distances.length; i++) {
    hist[Math.min(255, Math.max(0, Math.round(distances[i]! * 255)))]!++
  }
  const total = distances.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]!
  let sumB = 0
  let wB = 0
  let best = 0
  let bestVar = -1
  for (let i = 0; i < 256; i++) {
    wB += hist[i]!
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += i * hist[i]!
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > bestVar) {
      bestVar = between
      best = i
    }
  }
  return best / 255
}

type Component = {
  area: number
  sumX: number
  sumY: number
  label: number
  x0: number
  y0: number
  x1: number
  y1: number
}

function keepComponents(
  foreground: Uint8Array, labels: Int32Array, w: number, h: number,
): { keep: Uint8Array; ratio: number } {
  const n = w * h
  const queue = new Int32Array(n)
  const components: Component[] = []
  let nextLabel = 0
  for (let start = 0; start < n; start++) {
    if (!foreground[start] || labels[start]) continue
    const label = ++nextLabel
    let head = 0
    let tail = 0
    let area = 0
    let sumX = 0
    let sumY = 0
    let x0 = w
    let y0 = h
    let x1 = 0
    let y1 = 0
    labels[start] = label
    queue[tail++] = start
    while (head < tail) {
      const idx = queue[head++]!
      const x = idx % w
      const y = (idx / w) | 0
      area++
      sumX += x
      sumY += y
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x + 1 > x1) x1 = x + 1
      if (y + 1 > y1) y1 = y + 1
      const visit = (ni: number) => {
        if (foreground[ni] && !labels[ni]) {
          labels[ni] = label
          queue[tail++] = ni
        }
      }
      if (x > 0) visit(idx - 1)
      if (x + 1 < w) visit(idx + 1)
      if (y > 0) visit(idx - w)
      if (y + 1 < h) visit(idx + w)
    }
    components.push({ area, sumX, sumY, label, x0, y0, x1, y1 })
  }

  if (components.length === 0) {
    return { keep: new Uint8Array(n), ratio: 0 }
  }
  const minArea = Math.max(24, Math.round(n * 0.0015))
  const candidates = components.filter(c => c.area >= minArea)
  if (candidates.length === 0) {
    return { keep: new Uint8Array(n), ratio: 0 }
  }
  const maxArea = Math.max(...candidates.map(c => c.area))
  const keepLabels = new Set<number>()
  let subjectArea = 0
  for (const c of candidates) {
    const cx = c.sumX / c.area
    const cy = c.sumY / c.area
    const central = cx >= w * 0.12 && cx <= w * 0.88
      && cy >= h * 0.04 && cy <= h * 0.99
    const big = c.area >= n * 0.2
    const related = c.area >= maxArea * 0.12 || c.area >= n * 0.012
    if ((central && related) || big) {
      keepLabels.add(c.label)
      subjectArea += c.area
    }
  }
  const keep = new Uint8Array(n)
  if (keepLabels.size === 0) return { keep, ratio: 0 }
  for (let i = 0; i < n; i++) {
    if (keepLabels.has(labels[i]!)) keep[i] = 255
  }
  return { keep, ratio: subjectArea / n }
}

/** 3×3 软边（可分离 [1,2,1]），让掩码边缘有一点覆盖率过渡。 */
function soften(src: Uint8Array, w: number, h: number): Uint8Array {
  const tmp = new Float32Array(w * h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const a = src[row + Math.max(0, x - 1)]!
      const b = src[row + x]!
      const c = src[row + Math.min(w - 1, x + 1)]!
      tmp[row + x] = (a + 2 * b + c) / 4
    }
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w
    const row = y * w
    const dn = Math.min(h - 1, y + 1) * w
    for (let x = 0; x < w; x++) {
      out[row + x] = Math.round((tmp[up + x]! + 2 * tmp[row + x]! + tmp[dn + x]!) / 4)
    }
  }
  return out
}

function boxExtreme(
  src: Uint8Array, w: number, h: number, radius: number, wantMax: boolean,
): Uint8Array {
  const tmp = new Uint8Array(w * h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let v = wantMax ? 0 : 255
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(w - 1, x + radius)
      for (let xx = x0; xx <= x1; xx++) {
        const p = src[row + xx]!
        v = wantMax ? Math.max(v, p) : Math.min(v, p)
      }
      tmp[row + x] = v
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius)
    const y1 = Math.min(h - 1, y + radius)
    for (let x = 0; x < w; x++) {
      let v = wantMax ? 0 : 255
      for (let yy = y0; yy <= y1; yy++) {
        const p = tmp[yy * w + x]!
        v = wantMax ? Math.max(v, p) : Math.min(v, p)
      }
      out[y * w + x] = v
    }
  }
  return out
}

/**
 * 闭运算 + 填洞 + 轻微外扩：
 * - 闭运算把被背景色切成条的脸补回来；
 * - 填洞把主体内部没连到画面边缘的孔补实；
 * - 外扩 2px 兜住发丝边缘，最后再由 `soften` 收成软边。
 */
function consolidate(
  src: Uint8Array, w: number, h: number,
): Uint8Array {
  const n = w * h
  const radius = clamp(Math.round(Math.min(w, h) * 0.02), 3, 12)
  const dilated = boxExtreme(src, w, h, radius, true)
  const closed = boxExtreme(dilated, w, h, radius, false)

  // 从边缘洪泛剩下的背景；没连到边缘的孔一定是主体内部。
  const outside = new Uint8Array(n)
  const queue = new Int32Array(n)
  let head = 0
  let tail = 0
  const seed = (i: number) => {
    if (!closed[i] && !outside[i]) {
      outside[i] = 1
      queue[tail++] = i
    }
  }
  for (let x = 0; x < w; x++) {
    seed(x)
    seed((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    seed(y * w)
    seed(y * w + w - 1)
  }
  while (head < tail) {
    const idx = queue[head++]!
    const x = idx % w
    const y = (idx / w) | 0
    const visit = (ni: number) => {
      if (!closed[ni] && !outside[ni]) {
        outside[ni] = 1
        queue[tail++] = ni
      }
    }
    if (x > 0) visit(idx - 1)
    if (x + 1 < w) visit(idx + 1)
    if (y > 0) visit(idx - w)
    if (y + 1 < h) visit(idx + w)
  }
  const filled = new Uint8Array(n)
  for (let i = 0; i < n; i++) filled[i] = outside[i] ? 0 : 255
  return boxExtreme(filled, w, h, 2, true)
}

function channelDiff(
  data: Uint8ClampedArray, a: number, b: number,
): number {
  const ia = a * 4
  const ib = b * 4
  return Math.max(
    Math.abs(data[ia]! - data[ib]!),
    Math.abs(data[ia + 1]! - data[ib + 1]!),
    Math.abs(data[ia + 2]! - data[ib + 2]!),
  ) / 255
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = clamp((v - lo) / Math.max(1e-8, hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * 人像兜底：肤色连通域是脸，不拿它当背景色去洪泛。
 *
 * 墙色和肤色接近时，纯颜色分割会把脸掏空；脸一旦认出来，就沿人脸框
 * 向左右和上方扩一圈（头发），再一路保留到画面底部（脖子 / 身体），
 * 形成一条软边人物区域。非人像没有足够肤色，会走通用路径。
 */
function personRegion(
  data: Uint8ClampedArray, w: number, h: number,
): { mask: Uint8Array; ratio: number } | null {
  const n = w * h
  const skin = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * 4
    const r = data[p]! / 255
    const g = data[p + 1]! / 255
    const b = data[p + 2]! / 255
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 0.5
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 0.5
    if (y > 0.16 && cb > 0.34 && cb < 0.5 && cr > 0.54 && cr < 0.7) {
      skin[i] = 1
    }
  }
  const labels = new Int32Array(n)
  const queue = new Int32Array(n)
  const comps: Component[] = []
  let nextLabel = 0
  for (let start = 0; start < n; start++) {
    if (!skin[start] || labels[start]) continue
    const label = ++nextLabel
    let head = 0
    let tail = 0
    let area = 0
    let sumX = 0
    let sumY = 0
    let x0 = w
    let y0 = h
    let x1 = 0
    let y1 = 0
    labels[start] = label
    queue[tail++] = start
    while (head < tail) {
      const idx = queue[head++]!
      const x = idx % w
      const y = (idx / w) | 0
      area++
      sumX += x
      sumY += y
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x + 1 > x1) x1 = x + 1
      if (y + 1 > y1) y1 = y + 1
      const visit = (ni: number) => {
        if (skin[ni] && !labels[ni]) {
          labels[ni] = label
          queue[tail++] = ni
        }
      }
      if (x > 0) visit(idx - 1)
      if (x + 1 < w) visit(idx + 1)
      if (y > 0) visit(idx - w)
      if (y + 1 < h) visit(idx + w)
    }
    comps.push({ area, sumX, sumY, label, x0, y0, x1, y1 })
  }
  if (comps.length === 0) return null
  const minArea = Math.max(16, Math.round(n * 0.004))
  const central = comps.filter(c => {
    const cx = c.sumX / c.area
    return c.area >= minArea
      && cx >= w * 0.2 && cx <= w * 0.8
      && c.x1 - c.x0 >= w * 0.08
      && c.y1 - c.y0 >= h * 0.08
  })
  if (central.length === 0) return null
  central.sort((a, b) => b.area - a.area)
  const face = central[0]!
  const fw = face.x1 - face.x0
  const fh = face.y1 - face.y0
  const cx = (face.x0 + face.x1) / 2
  // 半宽至少覆盖画面的一小半：肩膀通常比脸宽，头发也会向两侧伸。
  const halfW = Math.max(fw * 0.78, w * 0.31)
  const xa = Math.max(0, cx - halfW)
  const xb = Math.min(w, cx + halfW)
  const ya = Math.max(0, face.y0 - fh * 0.9)
  const feather = Math.max(2, Math.round(Math.min(w, h) * 0.025))
  const mask = new Uint8Array(n)
  let subjectPixels = 0
  for (let y = 0; y < h; y++) {
    const wy = smoothstep(ya, Math.min(h, ya + feather), y)
    for (let x = 0; x < w; x++) {
      const wx = Math.min(
        smoothstep(xa, Math.min(w, xa + feather), x),
        1 - smoothstep(Math.max(0, xb - feather), xb, x),
      )
      const inside = wy * wx
      mask[y * w + x] = Math.round(255 * (1 - inside))
      if (inside > 0.5) subjectPixels++
    }
  }
  return { mask, ratio: subjectPixels / n }
}

export function estimateSubjectMask(
  data: Uint8ClampedArray, width: number, height: number,
): SubjectMaskResult {
  if (data.length !== width * height * 4) {
    throw new Error(
      `像素尺寸和照片对不上（像素 ${data.length} 字节，照片 ${width}×${height}）`,
    )
  }
  const n = width * height
  const person = personRegion(data, width, height)
  if (person && person.ratio >= 0.02 && person.ratio <= 0.94) {
    return {
      mask: soften(person.mask, width, height),
      subjectRatio: person.ratio,
      threshold: 0,
    }
  }
  const centers = clusterBackground(borderSamples(data, width, height))
  const distances = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * 4
    distances[i] = nearestCenterDistance(data[p]!, data[p + 1]!, data[p + 2]!, centers)
  }
  const threshold = clamp(otsuThreshold(distances), 0.052, 0.24)

  // 只从画面边缘向内选背景；遇到明显颜色边就停。没有这道门槛时，墙色和
  // 肤色接近的人像会被从边缘一路渗进脸里（真实人像探针踩到过）。
  const background = new Uint8Array(n)
  const queue = new Int32Array(n)
  let head = 0
  let tail = 0
  const seed = (i: number) => {
    if (!background[i] && distances[i]! <= threshold) {
      background[i] = 1
      queue[tail++] = i
    }
  }
  for (let x = 0; x < width; x++) {
    seed(x)
    seed((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    seed(y * width)
    seed(y * width + width - 1)
  }
  while (head < tail) {
    const idx = queue[head++]!
    const x = idx % width
    const y = (idx / width) | 0
    const visit = (ni: number) => {
      if (!background[ni] && distances[ni]! <= threshold
        && channelDiff(data, idx, ni) <= EDGE_STEP) {
        background[ni] = 1
        queue[tail++] = ni
      }
    }
    if (x > 0) visit(idx - 1)
    if (x + 1 < width) visit(idx + 1)
    if (y > 0) visit(idx - width)
    if (y + 1 < height) visit(idx + width)
  }

  const foreground = new Uint8Array(n)
  for (let i = 0; i < n; i++) foreground[i] = background[i] ? 0 : 255
  const labels = new Int32Array(n)
  const { keep, ratio } = keepComponents(foreground, labels, width, height)
  const consolidated = consolidate(keep, width, height)
  const soft = soften(consolidated, width, height)
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) mask[i] = 255 - soft[i]!
  return { mask, subjectRatio: ratio, threshold }
}

/**
 * 把低分辨率背景覆盖率双线性放大到原图。智能主体在 ≤640 的图上算，
 * 这里负责把软边放回用户手里那张原图。
 */
export function resampleCoverage(
  src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number,
): Uint8Array {
  if (src.length !== srcW * srcH) {
    throw new Error('掩码尺寸和源图对不上')
  }
  const out = new Uint8Array(dstW * dstH)
  const x0s = new Int32Array(dstW)
  const x1s = new Int32Array(dstW)
  const xfs = new Float32Array(dstW)
  for (let x = 0; x < dstW; x++) {
    const sx = (x + 0.5) * srcW / dstW - 0.5
    const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(sx)))
    x0s[x] = x0
    x1s[x] = Math.min(srcW - 1, x0 + 1)
    xfs[x] = Math.max(0, Math.min(1, sx - x0))
  }
  for (let y = 0; y < dstH; y++) {
    const sy = (y + 0.5) * srcH / dstH - 0.5
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(sy)))
    const y1 = Math.min(srcH - 1, y0 + 1)
    const yf = Math.max(0, Math.min(1, sy - y0))
    const r0 = y0 * srcW
    const r1 = y1 * srcW
    const row = y * dstW
    for (let x = 0; x < dstW; x++) {
      const x0 = x0s[x]!
      const x1 = x1s[x]!
      const xf = xfs[x]!
      const top = src[r0 + x0]! * (1 - xf) + src[r0 + x1]! * xf
      const bottom = src[r1 + x0]! * (1 - xf) + src[r1 + x1]! * xf
      out[row + x] = Math.round(top * (1 - yf) + bottom * yf)
    }
  }
  return out
}
