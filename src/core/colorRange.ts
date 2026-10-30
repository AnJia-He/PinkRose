/**
 * **按颜色选蒙版**（★ 2026-10-19）。
 *
 * 点一下画面上的某个颜色，把「和它相近的像素」选出来。主流修图产品里这块
 * 叫 Color Range / 色彩范围：选天空、肤色、一件衣服，再只调这一块。
 *
 * 判据用 HSV，而不是 RGB 距离：RGB 里「同一个红、亮一点」会被判得很远，
 * HSV 把色相 / 饱和度 / 明度拆开后，亮部和暗部才不会被一刀切掉。
 *
 * ⚠️ 灰度像素没有有意义的色相：色相项的权重乘 `min(s, sTarget)`，
 *   黑 / 白 / 灰只按饱和度与明度比。
 * ⚠️ 纯函数、不碰画布；读像素 / 放大蒙版在 `image/colorRange.ts`。
 */
export type ColorRangeOptions = {
  /** 0–100：越大选得越宽。缺省 25。 */
  tolerance?: number
  /** 0–100：边缘柔和程度。缺省 35。 */
  feather?: number
  /** 只保留与点击种子四邻相连的部分；缺省 = 全图同色像素。 */
  connected?: boolean
  /** 归一化点击种子（0–1）；`connected` 为真时必须提供。 */
  seedX?: number
  seedY?: number
}

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v)
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback))
}

type Hsv = { h: number; s: number; v: number }

/** r/g/b 都是 0–255。 */
export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
    if (h < 0) h += 1
  }
  return {
    h,
    s: max <= 0 ? 0 : d / max,
    v: max / 255,
  }
}

/**
 * 按目标颜色生成一张 0–255 的蒙版（和照片同尺寸）。
 * 覆盖率为 0 的像素一个字节都不写 —— 和点修 / 磨皮同一条契约。
 */
export function colorRangeMaskPixels(
  data: Uint8ClampedArray, width: number, height: number,
  target: readonly [number, number, number], opts: ColorRangeOptions = {},
): Uint8Array {
  if (data.length < width * height * 4) {
    throw new Error(`像素尺寸和照片对不上（${data.length} 字节，照片 ${width}×${height}）`)
  }
  const tolerance = clamp(opts.tolerance, 0, 100, 25) / 100
  const feather = clamp(opts.feather, 0, 100, 35) / 100
  const t = rgbToHsv(target[0], target[1], target[2])

  // 容差 0 也留一点点余量：同一个色块在压缩 / 噪点之后本来就不会逐字节相同。
  const maxD = 0.025 + tolerance * 0.5
  const inner = maxD * (1 - feather)
  const span = Math.max(1e-6, maxD - inner)
  const mask = new Uint8Array(width * height)

  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (data[p + 3]! < 8) continue
    const c = rgbToHsv(data[p]!, data[p + 1]!, data[p + 2]!)
    const hueWeight = Math.min(c.s, t.s)
    const rawHue = Math.abs(c.h - t.h)
    const dh = Math.min(rawHue, 1 - rawHue) * hueWeight
    const ds = c.s - t.s
    const dv = c.v - t.v
    const d = Math.sqrt((dh * 1.4) ** 2 + (ds * 0.9) ** 2 + (dv * 0.8) ** 2)
    if (d >= maxD) continue
    mask[i] = d <= inner
      ? 255
      : Math.round(255 * (1 - (d - inner) / span))
  }
  if (!opts.connected) return mask

  const seedX = Math.min(width - 1, Math.max(0,
    Math.floor((Number.isFinite(opts.seedX) ? opts.seedX! : 0.5) * width)))
  const seedY = Math.min(height - 1, Math.max(0,
    Math.floor((Number.isFinite(opts.seedY) ? opts.seedY! : 0.5) * height)))
  const seed = seedY * width + seedX
  if (mask[seed] === 0) return new Uint8Array(width * height)

  const out = new Uint8Array(width * height)
  const seen = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0
  queue[tail++] = seed
  seen[seed] = 1
  while (head < tail) {
    const p = queue[head++]!
    out[p] = mask[p]!
    const x = p % width
    const y = Math.floor(p / width)
    const visit = (next: number) => {
      if (seen[next] || mask[next] === 0) return
      seen[next] = 1
      queue[tail++] = next
    }
    if (x > 0) visit(p - 1)
    if (x + 1 < width) visit(p + 1)
    if (y > 0) visit(p - width)
    if (y + 1 < height) visit(p + width)
  }
  return out
}
