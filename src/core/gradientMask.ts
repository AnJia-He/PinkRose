/**
 * 线性 / 径向渐变蒙版的纯算式（★ 2026-10-17）。
 *
 * 坐标都用**图片归一化坐标**（0~1），所以缩放、平移、换图都不会让蒙版歪。
 * 蒙版仍是 `core/retouch` 那一套契约：`Uint8Array`、0~255 覆盖率。
 *
 * - 线性：`start` 之前是 255，`end` 之后是 0，中间 smoothstep；
 * - 径向：`start` 是圆心，`end` 到圆心的距离是外半径；`feather` 控制
 *   硬芯到外圈的过渡比例（0 = 硬边，1 = 从圆心一路渐隐）。
 */
export type GradientKind = 'linear' | 'radial'

export type GradientPoint = { x: number; y: number }

export type GradientSpec = {
  kind: GradientKind
  start: GradientPoint
  end: GradientPoint
  /** 径向蒙版的过渡比例，0~1；线性蒙版不用它。 */
  feather: number
}

export const DEFAULT_LINEAR_GRADIENT: GradientSpec = {
  kind: 'linear',
  start: { x: 0.5, y: 0.2 },
  end: { x: 0.5, y: 0.7 },
  feather: 0,
}

export const DEFAULT_RADIAL_GRADIENT: GradientSpec = {
  kind: 'radial',
  start: { x: 0.5, y: 0.5 },
  end: { x: 0.5, y: 0.88 },
  feather: 0.6,
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const smoothstep = (t: number) => {
  const u = clamp01(t)
  return u * u * (3 - 2 * u)
}

/** 把渐变写进掩码，返回非零像素数。长度为零的渐变视为空蒙版。 */
export function fillGradientMask(
  mask: Uint8Array, width: number, height: number, spec: GradientSpec,
): number {
  if (mask.length !== width * height) {
    throw new Error(`蒙版尺寸和照片对不上（蒙版 ${mask.length} 字节，照片 ${width}×${height}）`)
  }
  mask.fill(0)
  if (width <= 0 || height <= 0) return 0

  const ax = spec.start.x * width
  const ay = spec.start.y * height
  const bx = spec.end.x * width
  const by = spec.end.y * height
  const dx = bx - ax
  const dy = by - ay

  if (spec.kind === 'linear') {
    const len2 = dx * dx + dy * dy
    if (len2 < 1e-8) return 0
    let count = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / len2
        const cov = Math.round(255 * (1 - smoothstep(t)))
        if (cov > 0) count++
        mask[y * width + x] = cov
      }
    }
    return count
  }

  const radius = Math.hypot(dx, dy)
  if (radius < 1e-6) return 0
  const feather = clamp01(spec.feather)
  const inner = 1 - feather
  let count = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - ax, y + 0.5 - ay) / radius
      let cov = 0
      if (d <= inner) {
        cov = 255
      } else if (d < 1 && feather > 0) {
        const u = (1 - d) / feather
        cov = Math.round(255 * smoothstep(u))
      }
      if (cov > 0) count++
      mask[y * width + x] = cov
    }
  }
  return count
}
