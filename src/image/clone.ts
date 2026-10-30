import { makeCanvas } from '../core/canvas'

/**
 * 克隆图章的像素引擎。
 *
 * 用户在源点按下、在目标处涂抹；偏移量 = 源点 - 第一笔落点。之后每一笔都从
 * **操作前的原图副本**取色，避免越涂越糊。笔刷覆盖率先取“这一笔的最大值”，
 * 最后统一混合一次，不在线段上反复叠加。
 */
export type ClonePoint = { x: number; y: number }
export type CloneStroke = {
  points: ClonePoint[]
  radius: number
  offset: ClonePoint
}
export type CloneResult = {
  changed: number
  rect: { x: number; y: number; w: number; h: number } | null
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smoothstep = (t: number) => {
  const u = clamp(t, 0, 1)
  return u * u * (3 - 2 * u)
}

export function clonePixels(
  data: Uint8ClampedArray, source: Uint8ClampedArray,
  width: number, height: number,
  points: readonly ClonePoint[], radius: number, offset: ClonePoint,
): CloneResult {
  if (data.length !== width * height * 4 || source.length !== data.length) {
    throw new Error(`像素尺寸和照片对不上（像素 ${data.length} 字节，照片 ${width}×${height}）`)
  }
  const r = Math.max(0, radius)
  if (points.length === 0 || r <= 0) return { changed: 0, rect: null }

  let minX = width, minY = height, maxX = 0, maxY = 0
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const x0 = clamp(Math.floor(minX - r - 1), 0, width)
  const y0 = clamp(Math.floor(minY - r - 1), 0, height)
  const x1 = clamp(Math.ceil(maxX + r + 1), 0, width)
  const y1 = clamp(Math.ceil(maxY + r + 1), 0, height)
  if (x1 <= x0 || y1 <= y0) return { changed: 0, rect: null }

  const coverage = new Uint8Array((x1 - x0) * (y1 - y0))
  const stamp = (cx: number, cy: number) => {
    const sx0 = clamp(Math.floor(cx - r), x0, x1)
    const sy0 = clamp(Math.floor(cy - r), y0, y1)
    const sx1 = clamp(Math.ceil(cx + r), x0, x1)
    const sy1 = clamp(Math.ceil(cy + r), y0, y1)
    for (let y = sy0; y < sy1; y++) {
      for (let x = sx0; x < sx1; x++) {
        const d = Math.hypot(x - cx, y - cy)
        if (d > r) continue
        const cov = Math.round(255 * smoothstep(1 - d / r))
        const p = (y - y0) * (x1 - x0) + (x - x0)
        if (cov > coverage[p]!) coverage[p] = cov
      }
    }
  }

  stamp(points[0]!.x, points[0]!.y)
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const steps = Math.max(1, Math.ceil(len / Math.max(1, r * 0.35)))
    for (let s = 1; s <= steps; s++) {
      stamp(a.x + (b.x - a.x) * s / steps, a.y + (b.y - a.y) * s / steps)
    }
  }

  let changed = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cov = coverage[(y - y0) * (x1 - x0) + (x - x0)]! / 255
      if (cov <= 0) continue
      const srcX = x + offset.x
      const srcY = y + offset.y
      if (srcX < 0 || srcY < 0 || srcX > width - 1 || srcY > height - 1) continue
      const ix = Math.floor(srcX)
      const iy = Math.floor(srcY)
      const ix1 = Math.min(ix + 1, width - 1)
      const iy1 = Math.min(iy + 1, height - 1)
      const fx = srcX - ix
      const fy = srcY - iy
      const i00 = (iy * width + ix) * 4
      const i10 = (iy * width + ix1) * 4
      const i01 = (iy1 * width + ix) * 4
      const i11 = (iy1 * width + ix1) * 4
      const di = (y * width + x) * 4
      let diff = false
      for (let c = 0; c < 4; c++) {
        const a = source[i00 + c]! * (1 - fx) + source[i10 + c]! * fx
        const b = source[i01 + c]! * (1 - fx) + source[i11 + c]! * fx
        const v = Math.round(a * (1 - fy) + b * fy)
        const out = Math.round(data[di + c]! + (v - data[di + c]!) * cov)
        if (out !== data[di + c]) diff = true
        data[di + c] = out
      }
      if (diff) changed++
    }
  }
  return {
    changed,
    rect: changed > 0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null,
  }
}

/** 把一笔克隆落到工作画布上，只回写改过的外接框。 */
export function applyCloneStroke(
  canvas: HTMLCanvasElement, source: Uint8ClampedArray,
  points: readonly ClonePoint[], radius: number, offset: ClonePoint,
): CloneResult {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('拿不到 2D 上下文，克隆不了')
  const w = canvas.width
  const h = canvas.height
  const image = ctx.getImageData(0, 0, w, h)
  const result = clonePixels(image.data, source, w, h, points, radius, offset)
  if (result.rect) {
    const r = result.rect
    ctx.putImageData(image, 0, 0, r.x, r.y, r.w, r.h)
  }
  return result
}

/**
 * 从原图重新落一遍所有克隆笔画。预览用 `maxSide` 缩图，提交省略 = 原尺寸。
 * 这样多笔叠加不会互相“复制已复制过的内容”，也避免拖动时维护一块隐藏画布。
 */
export async function cloneToBitmap(
  source: ImageBitmap, strokes: readonly CloneStroke[],
  maxSide = Number.POSITIVE_INFINITY,
): Promise<{ bitmap: ImageBitmap; changed: number }> {
  const scale = Math.min(1, maxSide / Math.max(1, Math.max(source.width, source.height)))
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const { canvas, ctx } = makeCanvas(w, h, '克隆不了', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  const image = ctx.getImageData(0, 0, w, h)
  const original = new Uint8ClampedArray(image.data)
  let changed = 0
  for (const stroke of strokes) {
    const result = clonePixels(
      image.data, original, w, h,
      stroke.points.map(p => ({ x: p.x * scale, y: p.y * scale })),
      Math.max(1, stroke.radius * scale),
      { x: stroke.offset.x * scale, y: stroke.offset.y * scale },
    )
    changed += result.changed
  }
  if (changed > 0) ctx.putImageData(image, 0, 0)
  const bitmap = await createImageBitmap(canvas)
  return { bitmap, changed }
}
