/**
 * 自动水平：在照片里找一条最像「地平线 / 水平边」的长直线，返回它的倾角。
 *
 * 纯函数，输入是 RGBA 字节（`ImageData.data` 的形状），不碰 DOM、不依赖模型。
 * 输出单位是**度**，范围 `[-15, 15]`；正数 = 直线在画面里向右下斜
 * （和 `core/crop.ts` 的 `CropSpec.angle` 同向，调用方直接塞进去就能扶正）。
 *
 * 做法：
 *   1. 缩到长边 480 的灰度图，再走一遍 3×3 均值模糊；
 *   2. 每列找「竖直梯度最强、且明显强于水平梯度」的点 —— 那就是这一列
 *      最像水平边的位置。竖线（只有水平梯度）和 45° 斜线在这里就被排除；
 *   3. 对每列的点做 RANSAC：任取两点算斜率，统计落在同一条直线附近的列数；
 *      地平线会跨大量列对齐，窗框 / 树叶这类短边凑不出这么多列；
 *   4. 用内点做加权最小二乘，得到亚像素斜率，再换成角度。
 *
 * 为什么不直接看局部切线：真实照片里的硬边在像素网格上是阶梯状的，局部
 * 切线只有 0°/90° 两种；按列找「竖直边」再拟合直线才不受台阶影响。
 */
export const HORIZON_MAX_ANGLE = 15

const MAX_SAMPLE_SIDE = 480
const MIN_GRADIENT = 12
const MIN_LINE_SHARE = 0.25
const VERTICAL_DOMINANCE = 1.5
const RANSAC_TOL_SHARE = 0.01

/**
 * `data` 是 RGBA、行距 `width * 4`。`maxAngle` 只给测试 / 特殊场景用，
 * 默认就是产品上的 ±15°（和水平矫正滑杆一致）。
 */
export function detectHorizonAngle(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  maxAngle = HORIZON_MAX_ANGLE,
): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width < 6 || height < 6 || maxAngle <= 0) return null
  if (data.length < width * height * 4) return null

  // ── 1. 灰度缩略图 + 3×3 均值模糊 ───────────────────────────────────
  const scale = Math.min(1, MAX_SAMPLE_SIDE / Math.max(width, height))
  const gw = Math.max(6, Math.round(width * scale))
  const gh = Math.max(6, Math.round(height * scale))
  const raw = new Float32Array(gw * gh)
  const gray = new Float32Array(gw * gh)
  const srcX = new Int32Array(gw)
  const srcY = new Int32Array(gh)
  for (let x = 0; x < gw; x++) srcX[x] = Math.min(width - 1, Math.floor((x + 0.5) * width / gw))
  for (let y = 0; y < gh; y++) srcY[y] = Math.min(height - 1, Math.floor((y + 0.5) * height / gh))
  for (let y = 0; y < gh; y++) {
    const row = srcY[y]! * width
    for (let x = 0; x < gw; x++) {
      const i = (row + srcX[x]!) * 4
      raw[y * gw + x] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
    }
  }
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) {
        gray[y * gw + x] = raw[y * gw + x]!
        continue
      }
      let sum = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) sum += raw[(y + dy) * gw + (x + dx)]!
      }
      gray[y * gw + x] = sum / 9
    }
  }

  // ── 2. 每列找竖直边（水平边缘）─────────────────────────────────────
  const gxAt = (x: number, y: number) =>
    (gray[(y - 1) * gw + (x + 1)]! + 2 * gray[y * gw + (x + 1)]!
      + gray[(y + 1) * gw + (x + 1)]!)
    - (gray[(y - 1) * gw + (x - 1)]! + 2 * gray[y * gw + (x - 1)]!
      + gray[(y + 1) * gw + (x - 1)]!)
  const gyAt = (x: number, y: number) =>
    (gray[(y + 1) * gw + (x - 1)]! + 2 * gray[(y + 1) * gw + x]!
      + gray[(y + 1) * gw + (x + 1)]!)
    - (gray[(y - 1) * gw + (x - 1)]! + 2 * gray[(y - 1) * gw + x]!
      + gray[(y - 1) * gw + (x + 1)]!)

  let maxGy = 0
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const gy = Math.abs(gyAt(x, y))
      if (gy > maxGy) maxGy = gy
    }
  }
  if (maxGy < MIN_GRADIENT) return null
  const threshold = Math.max(MIN_GRADIENT, maxGy * 0.15)

  const points: { x: number; y: number; w: number }[] = []
  for (let x = 1; x < gw - 1; x++) {
    let bestY = -1
    let bestW = 0
    for (let y = 1; y < gh - 1; y++) {
      const gy = Math.abs(gyAt(x, y))
      if (gy < threshold || gy < Math.abs(gxAt(x, y)) * VERTICAL_DOMINANCE) continue
      if (gy > bestW) {
        bestW = gy
        bestY = y
      }
    }
    if (bestY >= 0) points.push({ x, y: bestY, w: bestW })
  }

  const minPoints = Math.max(12, Math.round(gw * MIN_LINE_SHARE))
  if (points.length < minPoints) return null

  // ── 3. RANSAC：找跨列数最多的近水平线 ──────────────────────────────
  const maxSlope = Math.tan((maxAngle * Math.PI) / 180)
  const tol = Math.max(1.2, gh * RANSAC_TOL_SHARE)
  let bestSlope = 0
  let bestInliers = 0
  let bestWeight = 0
  let bestX0 = 0
  let bestY0 = 0

  const countInliers = (slope: number, x0: number, y0: number): { n: number; w: number } => {
    let n = 0
    let w = 0
    for (const p of points) {
      if (Math.abs(p.y - (y0 + slope * (p.x - x0))) <= tol) {
        n++
        w += p.w
      }
    }
    return { n, w }
  }

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!
      const b = points[j]!
      const dx = b.x - a.x
      if (dx < gw * 0.25) continue
      const slope = (b.y - a.y) / dx
      if (Math.abs(slope) > maxSlope) continue
      const { n, w } = countInliers(slope, a.x, a.y)
      if (n > bestInliers
        || (n === bestInliers && (w > bestWeight
          || (w === bestWeight && Math.abs(slope) < Math.abs(bestSlope))))) {
        bestInliers = n
        bestWeight = w
        bestSlope = slope
        bestX0 = a.x
        bestY0 = a.y
      }
    }
  }

  if (bestInliers < minPoints) return null

  // ── 4. 内点加权最小二乘，把斜率磨细 ────────────────────────────────
  let sw = 0
  let sx = 0
  let sy = 0
  for (const p of points) {
    if (Math.abs(p.y - (bestY0 + bestSlope * (p.x - bestX0))) <= tol * 2) {
      sw += p.w
      sx += p.w * p.x
      sy += p.w * p.y
    }
  }
  if (sw <= 0) return null
  const mx = sx / sw
  const my = sy / sw
  let num = 0
  let den = 0
  for (const p of points) {
    if (Math.abs(p.y - (bestY0 + bestSlope * (p.x - bestX0))) > tol * 2) continue
    num += p.w * (p.x - mx) * (p.y - my)
    den += p.w * (p.x - mx) ** 2
  }
  const slope = den > 0 ? num / den : bestSlope
  if (!Number.isFinite(slope)) return null

  const angle = (Math.atan(slope) * 180) / Math.PI
  return Math.max(-maxAngle, Math.min(maxAngle, angle))
}
