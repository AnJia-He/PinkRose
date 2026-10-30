/**
 * 本地天空蒙版（★ 2026-10-19）。
 *
 * 按颜色 + 画面高度估天空：蓝色主导、或很亮且低饱和的顶部区域算天空。
 * 越往下越淡出，避免把地面、蓝色衣服和水面一起圈进来。它不是语义分割，
 * 复杂逆光 / 玻璃反射仍要用户用画笔修边。
 */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smoothstep = (lo: number, hi: number, v: number) => {
  const t = clamp((v - lo) / Math.max(1e-8, hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}

export type SkyMaskResult = {
  mask: Uint8Array
  covered: number
  ratio: number
}

export function skyMaskPixels(
  data: Uint8ClampedArray, width: number, height: number,
): SkyMaskResult {
  if (data.length !== width * height * 4) {
    throw new Error('天空蒙版的像素尺寸对不上')
  }
  const mask = new Uint8Array(width * height)
  let covered = 0
  for (let y = 0; y < height; y++) {
    const yn = y / Math.max(1, height - 1)
    const top = 1 - smoothstep(0.42, 0.82, yn)
    if (top <= 0) continue
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      const r = data[p]! / 255
      const g = data[p + 1]! / 255
      const b = data[p + 2]! / 255
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      const sat = mx - mn
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const blue = Math.max(0, b - Math.max(r, g))
      const blueScore = clamp(blue * 6, 0, 1)
      const paleScore = clamp((l - 0.52) / 0.3, 0, 1)
        * clamp((0.2 - sat) / 0.2, 0, 1)
      const score = Math.max(blueScore, paleScore)
      if (score <= 0.03) continue
      const cov = Math.round(255 * score * top)
      if (cov >= 6) {
        mask[y * width + x] = cov
        covered++
      }
    }
  }
  return { mask, covered, ratio: covered / Math.max(1, width * height) }
}
