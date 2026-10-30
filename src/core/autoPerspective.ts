import type { PerspectiveQuad } from './perspective'

/**
 * 自动垂直透视：从照片里找贯穿画面的左右竖边，把向顶部或底部收拢的
 * 建筑 / 屏幕还原成四角。纯函数，只读 RGBA 字节，不碰 DOM、不上传照片。
 *
 * 只处理一点透视最常见的场景：左右竖边接近竖直，但上宽下窄或上窄下宽。
 * 平行竖线、单条边、短碎纹理都返回 null，让界面提示手动拖四角，不猜一个
 * 会把画面剪坏的结果。
 */
const MAX_SAMPLE_SIDE = 480
const MAX_SLOPE = 0.4
const MIN_LINE_SPAN = 0.45
const MIN_EDGE = 10
const MAX_LINES_PER_SIDE = 4

type Sample = { x: number; y: number; weight: number }
type Line = { a: number; b: number; score: number; span: number }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

function sampleGray(
  data: Uint8ClampedArray | Uint8Array, width: number, height: number,
): { gray: Float32Array; width: number; height: number } {
  const scale = Math.min(1, MAX_SAMPLE_SIDE / Math.max(width, height))
  const w = Math.max(8, Math.round(width * scale))
  const h = Math.max(8, Math.round(height * scale))
  const gray = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / h))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / w))
      const i = (sy * width + sx) * 4
      gray[y * w + x] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
    }
  }
  return { gray, width: w, height: h }
}

function edgeMaps(
  gray: Float32Array, width: number, height: number,
): { gx: Float32Array; gy: Float32Array; max: number } {
  const gx = new Float32Array(width * height)
  const gy = new Float32Array(width * height)
  let max = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = (xx: number, yy: number) => gray[yy * width + xx]!
      const sx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const sy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      const i = y * width + x
      gx[i] = sx
      gy[i] = sy
      max = Math.max(max, Math.abs(sx))
    }
  }
  return { gx, gy, max }
}

/**
 * 每行取几处最强的竖直边。真实照片的斜边在像素网格上是阶梯状的，直接
 * 对局部梯度求斜率会得到一排 0°；这里只取每行的落点，再由 RANSAC 拟合
 * `x = a·y + b`，就绕开了阶梯切线的假象。
 */
function rowSamples(
  gx: Float32Array, gy: Float32Array, width: number, height: number,
  threshold: number, left: boolean,
): Sample[] {
  const out: Sample[] = []
  const from = left ? 2 : Math.floor(width / 2)
  const to = left ? Math.ceil(width / 2) : width - 2
  for (let y = 2; y < height - 2; y += 3) {
    const row: Sample[] = []
    let runX = -1
    let runBest = 0
    const flush = () => {
      if (runX >= 0 && runBest > 0) row.push({ x: runX, y, weight: runBest })
      runX = -1
      runBest = 0
    }
    for (let x = from; x < to; x++) {
      const i = y * width + x
      const sx = Math.abs(gx[i]!)
      const sy = Math.abs(gy[i]!)
      const strong = sx >= threshold && sx >= sy * 1.15
      if (!strong) {
        flush()
        continue
      }
      if (runX < 0 || sx > runBest) {
        runX = x
        runBest = sx
      }
    }
    flush()
    row.sort((a, b) => b.weight - a.weight)
    for (let i = 0; i < Math.min(2, row.length); i++) {
      const sample = row[i]!
      if (i > 0 && row.slice(0, i).some(p => Math.abs(p.x - sample.x) <= 4)) continue
      out.push(sample)
    }
  }
  return out
}

function refineLine(a: number, b: number, samples: Sample[]): { a: number; b: number; inliers: Sample[] } {
  const inliers = samples.filter(p => Math.abs(p.x - (a * p.y + b)) <= 2.6)
  if (inliers.length < 4) return { a, b, inliers }
  let sw = 0
  let sx = 0
  let sy = 0
  for (const p of inliers) {
    sw += p.weight
    sx += p.weight * p.y
    sy += p.weight * p.x
  }
  if (sw <= 0) return { a, b, inliers }
  const my = sx / sw
  const mx = sy / sw
  let num = 0
  let den = 0
  for (const p of inliers) {
    num += p.weight * (p.y - my) * (p.x - mx)
    den += p.weight * (p.y - my) ** 2
  }
  if (den <= 0) return { a, b, inliers }
  const nextA = num / den
  return {
    a: nextA,
    b: mx - nextA * my,
    inliers: samples.filter(p => Math.abs(p.x - (nextA * p.y + (mx - nextA * my))) <= 2.6),
  }
}

function findLines(samples: Sample[], height: number): Line[] {
  const lines: Line[] = []
  let remaining = samples
  for (let pass = 0; pass < MAX_LINES_PER_SIDE && remaining.length >= 8; pass++) {
    let best: { a: number; b: number; score: number; inliers: Sample[] } | null = null
    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i]!
      for (let j = i + 1; j < remaining.length; j++) {
        const q = remaining[j]!
        const dy = q.y - p.y
        if (Math.abs(dy) < height * 0.42) continue
        const a = (q.x - p.x) / dy
        if (!Number.isFinite(a) || Math.abs(a) > MAX_SLOPE) continue
        const b = p.x - a * p.y
        let score = 0
        let count = 0
        for (const s of remaining) {
          if (Math.abs(s.x - (a * s.y + b)) <= 2.6) {
            score += s.weight
            count++
          }
        }
        if (count < Math.max(8, height * 0.16)) continue
        if (!best || score > best.score) {
          best = { a, b, score, inliers: [] }
        }
      }
    }
    if (!best) break
    const refined = refineLine(best.a, best.b, remaining)
    const ys = refined.inliers.map(p => p.y)
    const span = ys.length ? (Math.max(...ys) - Math.min(...ys) + 1) / height : 0
    if (span >= MIN_LINE_SPAN && refined.inliers.length >= 8) {
      lines.push({
        a: refined.a,
        b: refined.b,
        score: refined.inliers.reduce((sum, p) => sum + p.weight, 0) / refined.inliers.length,
        span,
      })
    }
    remaining = remaining.filter(p => Math.abs(p.x - (refined.a * p.y + refined.b)) > 4.5)
    if (remaining.length < 8) break
  }
  return lines
}

/**
 * 返回可直接交给四角透视的四点；顺序为左上、右上、右下、左下。
 * 找不到可信的一对竖边时返回 null。
 */
export function detectVerticalPerspective(
  data: Uint8ClampedArray | Uint8Array, width: number, height: number,
): PerspectiveQuad | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width < 24 || height < 24 || data.length < width * height * 4) return null

  const { gray, width: w, height: h } = sampleGray(data, width, height)
  const { gx, gy, max } = edgeMaps(gray, w, h)
  if (max < MIN_EDGE) return null
  const threshold = Math.max(MIN_EDGE, max * 0.16)
  const leftSamples = rowSamples(gx, gy, w, h, threshold, true)
  const rightSamples = rowSamples(gx, gy, w, h, threshold, false)
  if (leftSamples.length < 8 || rightSamples.length < 8) return null
  const left = findLines(leftSamples, h)
  const right = findLines(rightSamples, h)
  if (!left.length || !right.length) return null

  let best: { quad: PerspectiveQuad; score: number } | null = null
  for (const l of left) {
    for (const r of right) {
      const xlt = l.b
      const xlb = l.a * h + l.b
      const xrt = r.b
      const xrb = r.a * h + r.b
      if (Math.min(xlt, xlb, xrt, xrb) < w * 0.02
        || Math.max(xlt, xlb, xrt, xrb) > w * 0.98) continue
      const widthTop = xrt - xlt
      const widthBottom = xrb - xlb
      if (widthTop < w * 0.22 || widthBottom < w * 0.22
        || widthTop > w * 0.96 || widthBottom > w * 0.96) continue
      const correction = Math.abs(widthBottom - widthTop) / Math.max(widthTop, widthBottom)
      if (correction < 0.018) continue
      const score = (l.score + r.score) / 2
        + Math.min(widthTop, widthBottom) / w * 0.8
        + correction * 0.6
      if (!best || score > best.score) {
        best = {
          score,
          quad: [
            { x: clamp01(xlt / w), y: 0 },
            { x: clamp01(xrt / w), y: 0 },
            { x: clamp01(xrb / w), y: 1 },
            { x: clamp01(xlb / w), y: 1 },
          ],
        }
      }
    }
  }
  return best?.quad ?? null
}
