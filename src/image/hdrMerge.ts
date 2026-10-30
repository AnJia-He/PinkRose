import { makeCanvas } from '../core/canvas'
import type { ExportFormat } from '../export/save'
import { decodeImageFile, type DecodedImage } from './decode'

/**
 * HDR 合成（★ 2026-10-18）。
 *
 * 用户选同一场景的 2–5 张不同曝光照片，本机做曝光融合：暗曝光保住窗外 /
 * 灯牌的高光，亮曝光保住室内 / 阴影的细节。不做生成、不调用模型。
 *
 * 算法顺序：
 *   ① 缩到小灰度图，估计每张相对中间曝光的平移（机位轻微抖动）；
 *   ② 每张按目标高度重绘，带平移；
 *   ③ 逐像素算「曝光适中 × 局部反差 × 饱和度」权重，归一化融合；
 *   ④ 可选风格：自然 / 鲜明 / 戏剧。
 */
export const MAX_HDR_FILES = 5
export const HDR_MAX_HEIGHT = 2000
const SAMPLE_HEIGHT = 72
const MAX_PIXELS = 16_000_000
const ALIGN_RATIO = 0.03

export type HdrStyle = 'natural' | 'vivid' | 'dramatic'

export type HdrOptions = {
  height: number
  format: ExportFormat
  qualityPct: number
  style: HdrStyle
  align: boolean
}

export const DEFAULT_HDR_OPTIONS: HdrOptions = {
  height: 1600, format: 'image/jpeg', qualityPct: 92, style: 'natural', align: true,
}

export type HdrSource = {
  image: CanvasImageSource
  width: number
  height: number
}

export type HdrFrame = {
  data: Uint8ClampedArray
  width: number
  height: number
}

export type HdrGray = HdrFrame
export type HdrShift = { x: number; y: number; score: number }

/** 输出尺寸：高度定死，宽度跟参考图比例走；总像素超限时等比降高度。 */
export function hdrCanvasSize(
  width: number, height: number, targetHeight: number,
): { width: number; height: number } {
  let h = Math.max(1, Math.min(HDR_MAX_HEIGHT, Math.round(targetHeight)))
  let w = Math.max(1, Math.round(width * h / Math.max(1, height)))
  if (w * h > MAX_PIXELS) {
    h = Math.max(1, Math.floor(h * Math.sqrt(MAX_PIXELS / (w * h))))
    w = Math.max(1, Math.round(width * h / Math.max(1, height)))
  }
  return { width: w, height: h }
}

function grayOf(source: HdrSource): HdrGray {
  const h = SAMPLE_HEIGHT
  const w = Math.max(8, Math.round(source.width * h / Math.max(1, source.height)))
  const { ctx } = makeCanvas(w, h, '读不了这张 HDR 照片', { willReadFrequently: true })
  ctx.drawImage(source.image, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data
  const out = new Uint8ClampedArray(w * h)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = Math.round(0.299 * px[p]! + 0.587 * px[p + 1]! + 0.114 * px[p + 2]!)
  }
  return { data: out, width: w, height: h }
}

/**
 * 估计「把 moving 画到 reference 上时该平移多少」。返回的 `x/y` 是绘制偏移：
 * moving 平移 (x, y) 后与 reference 对齐。归一化互相关对整体明暗差免疫。
 */
export function estimateHdrShift(
  reference: HdrGray, moving: HdrGray, maxX: number, maxY: number,
): HdrShift {
  const w = Math.min(reference.width, moving.width)
  const h = Math.min(reference.height, moving.height)
  if (w < 8 || h < 8) return { x: 0, y: 0, score: -1 }
  const mx = Math.max(0, Math.min(Math.floor(maxX), Math.floor(w * 0.2)))
  const my = Math.max(0, Math.min(Math.floor(maxY), Math.floor(h * 0.2)))
  const scoreAt = (sx: number, sy: number) => {
    let n = 0, sl = 0, sr = 0, sll = 0, srr = 0, slr = 0
    for (let y = 0; y < h; y += 2) {
      const myp = y - sy
      if (myp < 0 || myp >= h) continue
      for (let x = 0; x < w; x += 2) {
        const mxp = x - sx
        if (mxp < 0 || mxp >= w) continue
        const l = reference.data[y * reference.width + x]!
        const r = moving.data[myp * moving.width + mxp]!
        n++
        sl += l; sr += r; sll += l * l; srr += r * r; slr += l * r
      }
    }
    if (n < 16) return -1
    const cov = slr - (sl * sr) / n
    const vl = sll - (sl * sl) / n
    const vr = srr - (sr * sr) / n
    return vl <= 1e-6 || vr <= 1e-6 ? 0 : cov / Math.sqrt(vl * vr)
  }
  let best: HdrShift = { x: 0, y: 0, score: scoreAt(0, 0) }
  for (let sy = -my; sy <= my; sy++) {
    for (let sx = -mx; sx <= mx; sx++) {
      const score = scoreAt(sx, sy)
      // 同分时偏袒不动：平滑画面在多个偏移上都可能很像，别为了 0.001 硬挪。
      if (score > best.score + 0.002 || (Math.abs(score - best.score) <= 0.002
        && Math.abs(sx) + Math.abs(sy) < Math.abs(best.x) + Math.abs(best.y))) {
        best = { x: sx, y: sy, score }
      }
    }
  }
  return best.score < 0.35 ? { x: 0, y: 0, score: best.score } : best
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

function stylePixel(r: number, g: number, b: number, style: HdrStyle): [number, number, number] {
  if (style === 'natural') return [r, g, b]
  const contrast = style === 'dramatic' ? 1.22 : 1.1
  const sat = style === 'dramatic' ? 1.1 : 1.14
  r = (r - 127.5) * contrast + 127.5
  g = (g - 127.5) * contrast + 127.5
  b = (b - 127.5) * contrast + 127.5
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return [
    clamp255(l + (r - l) * sat),
    clamp255(l + (g - l) * sat),
    clamp255(l + (b - l) * sat),
  ]
}

/**
 * 纯函数：等尺寸、已对齐的几张曝光帧 → 融合后的 RGBA。
 * 权重照 Mertens 曝光融合：曝光适中度² × 局部反差 × 饱和度。
 */
export function fuseHdrPixels(frames: readonly HdrFrame[], style: HdrStyle): Uint8ClampedArray {
  if (frames.length < 2) throw new Error('HDR 至少要两张照片')
  const { width: w, height: h } = frames[0]!
  for (const f of frames) {
    if (f.width !== w || f.height !== h) throw new Error('HDR 照片尺寸对不上')
  }
  const out = new Uint8ClampedArray(w * h * 4)
  const lum = (d: Uint8ClampedArray, i: number) =>
    0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      let sumR = 0, sumG = 0, sumB = 0, sumW = 0
      let fallback: HdrFrame | null = null
      for (const f of frames) {
        const i = o
        if (f.data[i + 3]! < 128) continue
        if (fallback === null) fallback = f
        const r = f.data[i]! / 255, g = f.data[i + 1]! / 255, b = f.data[i + 2]! / 255
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
        const left = x > 0 ? lum(f.data, i - 4) / 255 : l
        const right = x + 1 < w ? lum(f.data, i + 4) / 255 : l
        const up = y > 0 ? lum(f.data, i - w * 4) / 255 : l
        const down = y + 1 < h ? lum(f.data, i + w * 4) / 255 : l
        const contrast = Math.min(1, Math.abs(4 * l - left - right - up - down) * 5)
        const sat = Math.max(r, g, b) - Math.min(r, g, b)
        const well = Math.exp(
          -((r - 0.5) ** 2 + (g - 0.5) ** 2 + (b - 0.5) ** 2) / (2 * 0.2 * 0.2),
        )
        const weight = (0.02 + well * well) * (0.25 + contrast) * (0.5 + sat * 1.5)
        sumR += f.data[i]! * weight
        sumG += f.data[i + 1]! * weight
        sumB += f.data[i + 2]! * weight
        sumW += weight
      }
      if (sumW <= 1e-9) {
        if (fallback === null) continue
        out[o] = fallback.data[o]!
        out[o + 1] = fallback.data[o + 1]!
        out[o + 2] = fallback.data[o + 2]!
        out[o + 3] = 255
        continue
      }
      const [r, g, b] = stylePixel(sumR / sumW, sumG / sumW, sumB / sumW, style)
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = 255
    }
  }
  return out
}

/** 渲染 HDR；`height` 用于预览（传 480）或成片。 */
export function renderHdrMergeCanvas(
  sources: readonly HdrSource[], options: HdrOptions, height = options.height,
): { canvas: HTMLCanvasElement; width: number; height: number } {
  if (sources.length < 2) throw new Error('HDR 至少要两张照片')
  const ref = sources[Math.floor(sources.length / 2)]!
  const size = hdrCanvasSize(ref.width, ref.height, height)
  const grays = sources.map(grayOf)
  const shifts = options.align
    ? grays.map((g, i) => i === Math.floor(sources.length / 2)
      ? { x: 0, y: 0, score: 1 }
      : estimateHdrShift(
        grays[Math.floor(sources.length / 2)]!, g,
        Math.max(2, Math.round(g.width * ALIGN_RATIO)),
        Math.max(2, Math.round(g.height * ALIGN_RATIO)),
      ))
    : sources.map(() => ({ x: 0, y: 0, score: 1 }))
  const frames: HdrFrame[] = []
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!
    const gray = grays[i]!
    const shift = shifts[i]!
    const dx = Math.round(shift.x * size.width / gray.width)
    const dy = Math.round(shift.y * size.height / gray.height)
    const { ctx } = makeCanvas(size.width, size.height, '合成不了这张 HDR', {
      willReadFrequently: true,
    })
    ctx.drawImage(src.image, dx, dy, size.width, size.height)
    frames.push({
      data: ctx.getImageData(0, 0, size.width, size.height).data,
      width: size.width,
      height: size.height,
    })
  }
  const merged = fuseHdrPixels(frames, options.style)
  const { canvas, ctx } = makeCanvas(size.width, size.height, '合成不了这张 HDR')
  const imageData = ctx.createImageData(size.width, size.height)
  imageData.data.set(merged)
  ctx.putImageData(imageData, 0, 0)
  return { canvas, width: size.width, height: size.height }
}

function ext(format: ExportFormat): string {
  return format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg'
}

export function hdrFilename(format: ExportFormat, now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
  return `PinkRose-hdr-${stamp}.${ext(format)}`
}

export type HdrProgress = {
  completed: number
  total: number
  currentName: string
}

/** 解码 → 对齐 → 融合 → 编码。取消或异常时关闭所有位图。 */
export async function exportHdrMerge(
  files: readonly File[], options: HdrOptions,
  onProgress?: (p: HdrProgress) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string; width: number; height: number }> {
  if (files.length < 2) throw new Error('HDR 至少要两张照片')
  const decoded: DecodedImage[] = []
  try {
    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      onProgress?.({ completed: i, total: files.length, currentName: files[i]!.name })
      decoded.push(await decodeImageFile(files[i]!))
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress?.({ completed: files.length, total: files.length, currentName: '' })
    const made = renderHdrMergeCanvas(
      decoded.map(d => ({ image: d.bitmap, width: d.width, height: d.height })),
      options,
    )
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const blob = await new Promise<Blob>((resolve, reject) => {
      made.canvas.toBlob(
        b => b ? resolve(b) : reject(new Error('这张 HDR 编不出来')),
        options.format,
        options.qualityPct / 100,
      )
    })
    return {
      blob, filename: hdrFilename(options.format),
      width: made.width, height: made.height,
    }
  } finally {
    for (const d of decoded) d.bitmap.close()
  }
}
