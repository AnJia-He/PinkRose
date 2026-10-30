/**
 * 直方图数据（★ 2026-10-18）。
 *
 * 输入是**渲染结果**的 RGBA 字节（小离屏缓冲读回来的），输出三条 0~1 的
 * 归一化曲线 + 暗部 / 高光溢出比例。纯函数，和 WebGL 解耦，便于单测。
 */
export type HistogramData = {
  r: number[]
  g: number[]
  b: number[]
  /** 每列的亮度低 / 中 / 高分位（0~1），用于紧凑的亮度波形。 */
  waveform: { low: number; mid: number; high: number }[]
  /** Cb/Cr 平面上的密度点（0~1 坐标），用于矢量示波器。 */
  vectorscope: { x: number; y: number; density: number }[]
  /** 三通道都接近 0 的像素比例（0~1）。 */
  shadowClip: number
  /** 三通道都接近 255 的像素比例（0~1）。 */
  highlightClip: number
}

export const EMPTY_HISTOGRAM: HistogramData = {
  r: [], g: [], b: [], waveform: [], vectorscope: [], shadowClip: 0, highlightClip: 0,
}

const SHADOW_CUT = 4
const HIGHLIGHT_CUT = 251

/** 归一化曲线：每条通道除以自己的最高柱，再开平方，让低柱也看得见。 */
export function computeHistogram(
  pixels: Uint8Array | Uint8ClampedArray,
  bins = 64,
  width?: number,
  height?: number,
): HistogramData {
  if (!Number.isInteger(bins) || bins < 2 || bins > 256) {
    throw new Error(`直方图柱数不合法：${bins}`)
  }
  const r = new Array<number>(bins).fill(0)
  const g = new Array<number>(bins).fill(0)
  const b = new Array<number>(bins).fill(0)
  const hasScope = !!width && !!height && width > 0 && height > 0
  const WAVE_COLS = 48
  const WAVE_BINS = 32
  const VEC_SIZE = 32
  const waveCounts = hasScope
    ? new Uint32Array(WAVE_COLS * WAVE_BINS)
    : null
  const vecCounts = hasScope
    ? new Uint32Array(VEC_SIZE * VEC_SIZE)
    : null
  let vecMax = 0
  let n = 0
  let shadow = 0
  let highlight = 0
  const scale = bins / 256
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const pr = pixels[i]!
    const pg = pixels[i + 1]!
    const pb = pixels[i + 2]!
    r[Math.min(bins - 1, Math.floor(pr * scale))]!++
    g[Math.min(bins - 1, Math.floor(pg * scale))]!++
    b[Math.min(bins - 1, Math.floor(pb * scale))]!++
    if (pr <= SHADOW_CUT && pg <= SHADOW_CUT && pb <= SHADOW_CUT) shadow++
    if (pr >= HIGHLIGHT_CUT && pg >= HIGHLIGHT_CUT && pb >= HIGHLIGHT_CUT) highlight++
    if (waveCounts && vecCounts && width && height) {
      const pixel = i >> 2
      const x = pixel % width
      const luma = Math.round(0.2126 * pr + 0.7152 * pg + 0.0722 * pb)
      const wx = Math.min(WAVE_COLS - 1, Math.floor(x / width * WAVE_COLS))
      const wy = Math.min(WAVE_BINS - 1, Math.floor(luma / 256 * WAVE_BINS))
      waveCounts[wx * WAVE_BINS + wy]!++

      const cb = 128 - 0.168736 * pr - 0.331264 * pg + 0.5 * pb
      const cr = 128 + 0.5 * pr - 0.418688 * pg - 0.081312 * pb
      const vx = Math.max(0, Math.min(VEC_SIZE - 1, Math.floor(cb / 256 * VEC_SIZE)))
      const vy = Math.max(0, Math.min(VEC_SIZE - 1, Math.floor(cr / 256 * VEC_SIZE)))
      const vi = vy * VEC_SIZE + vx
      const count = ++vecCounts[vi]!
      if (count > vecMax) vecMax = count
    }
    n++
  }
  if (n === 0) return { ...EMPTY_HISTOGRAM, r: [], g: [], b: [], waveform: [], vectorscope: [] }

  const normChannel = (values: number[]) => {
    let max = 1
    for (const v of values) if (v > max) max = v
    return values.map(v => Math.sqrt(v / max))
  }

  const waveform = Array.from({ length: hasScope ? WAVE_COLS : 0 }, (_, col) => {
    let total = 0
    for (let bin = 0; bin < WAVE_BINS; bin++) total += waveCounts![col * WAVE_BINS + bin]!
    if (total === 0) return { low: 0, mid: 0, high: 0 }
    const pick = (fraction: number) => {
      const target = total * fraction
      let sum = 0
      for (let bin = 0; bin < WAVE_BINS; bin++) {
        sum += waveCounts![col * WAVE_BINS + bin]!
        if (sum >= target) return bin / Math.max(1, WAVE_BINS - 1)
      }
      return 1
    }
    return { low: pick(0.1), mid: pick(0.5), high: pick(0.9) }
  })

  const vectorscope: HistogramData['vectorscope'] = []
  if (vecCounts && vecMax > 0) {
    for (let y = 0; y < VEC_SIZE; y++) {
      for (let x = 0; x < VEC_SIZE; x++) {
        const count = vecCounts[y * VEC_SIZE + x]!
        if (count <= 0) continue
        vectorscope.push({
          x: (x + 0.5) / VEC_SIZE,
          y: 1 - (y + 0.5) / VEC_SIZE,
          density: Math.sqrt(count / vecMax),
        })
      }
    }
    vectorscope.sort((a, b) => b.density - a.density)
    vectorscope.splice(256)
  }

  return {
    r: normChannel(r),
    g: normChannel(g),
    b: normChannel(b),
    waveform,
    vectorscope,
    shadowClip: shadow / n,
    highlightClip: highlight / n,
  }
}
