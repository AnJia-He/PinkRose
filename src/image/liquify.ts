/**
 * **液化（局部推移 / 收拢）的像素引擎**（★ 2026-10-17）。
 *
 * 和点修 / 磨皮一样，用户先在工作副本上连续改，点「应用液化」才写进当前底图。
 * 这里每次都只处理**笔触覆盖的外接框**：从原图复制一块源像素，再按
 * 目标像素到笔触线段的距离做反向采样。照片尺寸再大，也只读改这一块。
 *
 * - `push`：把笔下的像素沿拖动方向推走；
 * - `pinch`：把笔下的像素往笔触中心收（瘦脸最常用的方向）。
 *
 * 所有采样都夹在源块内，笔触贴边也不会越界或抛错。
 */
export type LiquifyMode = 'push' | 'pinch'

export type LiquifyStroke = {
  x0: number
  y0: number
  x1: number
  y1: number
  /** 笔刷半径，图片像素。 */
  radius: number
  /** 0~100。 */
  strength: number
  mode: LiquifyMode
}

export type LiquifyRect = { x: number; y: number; w: number; h: number }
export type LiquifyResult = { changed: number; rect: LiquifyRect | null }

export const LIQUIFY_DEFAULT_STRENGTH = 60
export const defaultLiquifyRadius = (width: number, height: number) =>
  Math.max(8, Math.round(Math.min(width, height) * 0.08))
export const maxLiquifyRadius = (width: number, height: number) =>
  Math.max(16, Math.round(Math.min(width, height) * 0.25))

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function liquifyPixels(
  data: Uint8ClampedArray, width: number, height: number, stroke: LiquifyStroke,
): LiquifyResult {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) {
    return { changed: 0, rect: null }
  }
  const s = clamp(Number.isFinite(stroke.strength) ? stroke.strength : 0, 0, 100) / 100
  const radius = Math.max(1, Number.isFinite(stroke.radius) ? stroke.radius : 1)
  const x0 = stroke.x0
  const y0 = stroke.y0
  const x1 = stroke.x1
  const y1 = stroke.y1
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy)
  if (s <= 0 || (stroke.mode === 'push' && len < 0.01)) return { changed: 0, rect: null }

  const outX0 = clamp(Math.floor(Math.min(x0, x1) - radius - 2), 0, width)
  const outY0 = clamp(Math.floor(Math.min(y0, y1) - radius - 2), 0, height)
  const outX1 = clamp(Math.ceil(Math.max(x0, x1) + radius + 2), 0, width)
  const outY1 = clamp(Math.ceil(Math.max(y0, y1) + radius + 2), 0, height)
  if (outX1 <= outX0 || outY1 <= outY0) return { changed: 0, rect: null }

  // 反向采样最多会向外抓这么多像素；多留 3px 给双线性插值。
  const reach = Math.ceil((stroke.mode === 'push' ? len * s : radius * 0.7) + 3)
  const srcX0 = clamp(outX0 - reach, 0, width - 1)
  const srcY0 = clamp(outY0 - reach, 0, height - 1)
  const srcX1 = clamp(outX1 + reach, 1, width)
  const srcY1 = clamp(outY1 + reach, 1, height)
  const sw = srcX1 - srcX0
  const sh = srcY1 - srcY0
  const src = new Uint8ClampedArray(sw * sh * 4)
  for (let y = 0; y < sh; y++) {
    const from = ((srcY0 + y) * width + srcX0) * 4
    src.set(data.subarray(from, from + sw * 4), y * sw * 4)
  }

  const len2 = dx * dx + dy * dy
  let changed = 0
  for (let y = outY0; y < outY1; y++) {
    for (let x = outX0; x < outX1; x++) {
      const t = len2 > 0
        ? clamp(((x - x0) * dx + (y - y0) * dy) / len2, 0, 1)
        : 0
      const cx = x0 + t * dx
      const cy = y0 + t * dy
      const d = Math.hypot(x - cx, y - cy)
      if (d >= radius) continue
      const q = 1 - d / radius
      const falloff = q * q * (3 - 2 * q)

      let srcX: number
      let srcY: number
      if (stroke.mode === 'push') {
        srcX = x - dx * s * falloff
        srcY = y - dy * s * falloff
      } else {
        const k = 1 + 0.7 * s * falloff
        srcX = cx + (x - cx) * k
        srcY = cy + (y - cy) * k
      }

      // 双线性采样：先把全局源坐标换算到源块局部，再夹在块内。
      const lx = clamp(srcX - srcX0, 0, sw - 1)
      const ly = clamp(srcY - srcY0, 0, sh - 1)
      const ix = Math.floor(lx)
      const iy = Math.floor(ly)
      const ix1 = Math.min(ix + 1, sw - 1)
      const iy1 = Math.min(iy + 1, sh - 1)
      const fx = lx - ix
      const fy = ly - iy
      const i00 = (iy * sw + ix) * 4
      const i10 = (iy * sw + ix1) * 4
      const i01 = (iy1 * sw + ix) * 4
      const i11 = (iy1 * sw + ix1) * 4

      const di = (y * width + x) * 4
      let diff = false
      for (let c = 0; c < 4; c++) {
        const a = src[i00 + c]! * (1 - fx) + src[i10 + c]! * fx
        const b = src[i01 + c]! * (1 - fx) + src[i11 + c]! * fx
        const v = Math.round(a * (1 - fy) + b * fy)
        if (v !== data[di + c]) diff = true
        data[di + c] = v
      }
      if (diff) changed++
    }
  }
  return {
    changed,
    rect: changed > 0
      ? { x: outX0, y: outY0, w: outX1 - outX0, h: outY1 - outY0 }
      : null,
  }
}

/**
 * 把一笔液化落到工作画布上。只把改过的外接框 `putImageData` 回去，
 * 不把整张全分辨率像素再传一遍。
 */
export function applyLiquifyStroke(
  canvas: HTMLCanvasElement, stroke: LiquifyStroke,
): LiquifyResult {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('拿不到 2D 上下文，液化不了')
  const w = canvas.width
  const h = canvas.height
  const image = ctx.getImageData(0, 0, w, h)
  const result = liquifyPixels(image.data, w, h, stroke)
  if (result.rect) {
    const r = result.rect
    ctx.putImageData(image, 0, 0, r.x, r.y, r.w, r.h)
  }
  return result
}
