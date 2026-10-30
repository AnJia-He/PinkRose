/**
 * 本地「智能挑图」的评分核心。
 *
 * 不认人、不认场景：只看缩略图的拉普拉斯反差（清晰度）和亮度 / 高光暗部
 * 裁切（曝光）。结果只作「推荐保留 / 建议复查」的起点，绝不自动删除照片。
 */
export type CullMetrics = {
  /** 拉普拉斯响应的方差，越大通常越清晰。 */
  sharpness: number
  /** 0~1，中间调且少裁切时更高。 */
  exposure: number
  /** 0~1，接近纯黑 / 纯白的像素比例。 */
  clipping: number
  /** 平均亮度 0~1。 */
  meanLuma: number
}

export type CullAssessment = {
  keep: boolean
  score: number
  reason: string
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function cullMetrics(luma: ArrayLike<number>, width: number, height: number): CullMetrics {
  if (width < 3 || height < 3 || luma.length < width * height) {
    return { sharpness: 0, exposure: 0, clipping: 0, meanLuma: 0 }
  }
  let sum = 0
  let sum2 = 0
  let n = 0
  let total = 0
  let clipped = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const c = luma[i]!
      const lap = 4 * c - luma[i - 1]! - luma[i + 1]! - luma[i - width]! - luma[i + width]!
      sum += lap
      sum2 += lap * lap
      n++
    }
  }
  for (let i = 0; i < width * height; i++) {
    const v = luma[i]!
    total += v
    if (v < 8 || v > 247) clipped++
  }
  const meanLuma = total / (width * height) / 255
  const meanLap = n ? sum / n : 0
  const variance = n ? Math.max(0, sum2 / n - meanLap * meanLap) : 0
  const midPenalty = Math.abs(meanLuma - 0.5) * 2
  const clipping = clipped / (width * height)
  return {
    sharpness: Math.round(variance),
    exposure: Math.round(clamp(1 - 0.7 * midPenalty - Math.min(1, clipping * 4), 0, 1) * 100) / 100,
    clipping: Math.round(clipping * 1000) / 1000,
    meanLuma: Math.round(meanLuma * 1000) / 1000,
  }
}

/**
 * 批次内相对比较：清晰度用同批最高值归一，曝光用绝对阈值兜底。
 * `keep` 只是建议；`score` 高也不代表审美判断。
 */
export function assessCull(metrics: readonly CullMetrics[]): CullAssessment[] {
  if (metrics.length === 0) return []
  const maxSharp = Math.max(1, ...metrics.map(m => m.sharpness))
  return metrics.map(m => {
    const sharp = Math.sqrt(Math.max(0, m.sharpness) / maxSharp)
    const score = Math.round(clamp(sharp * 0.65 + m.exposure * 0.35, 0, 1) * 100) / 100
    const keep = m.exposure >= 0.35 && score >= 0.55
    let reason = '清晰度和曝光都正常'
    if (m.exposure < 0.35) reason = '曝光偏暗 / 偏亮或高光暗部裁切较多'
    else if (sharp < 0.45) reason = '在这一组里偏模糊，可能有虚焦或手抖'
    else if (!keep) reason = '清晰度和曝光都可以再复查'
    return { keep, score, reason }
  })
}
