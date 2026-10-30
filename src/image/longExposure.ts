import { makeCanvas } from '../core/canvas'
import type { ExportFormat } from '../export/save'
import { decodeImageFile, type DecodedImage } from './decode'
import {
  estimateHdrShift, hdrCanvasSize, type HdrGray, type HdrSource,
} from './hdrMerge'

/**
 * 长曝光合成（★ 2026-10-18）。
 *
 * 同一机位的多张短曝光照片在本机合成：
 *  · 车流光轨：逐通道取最亮值，移动的亮线跨帧累积；
 *  · 流水丝滑：逐像素取平均，移动的水 / 云被拉成柔顺长曝光。
 * 静态场景先做轻微平移对齐；不做模型调用，也不写入作品库。
 */
export const MAX_LONG_EXPOSURE_FILES = 8
export const LONG_EXPOSURE_MAX_HEIGHT = 2000
const SAMPLE_HEIGHT = 72
const MAX_PIXELS = 16_000_000
const ALIGN_RATIO = 0.03

export type LongExposureMode = 'trail' | 'smooth'

export type LongExposureOptions = {
  height: number
  format: ExportFormat
  qualityPct: number
  mode: LongExposureMode
  align: boolean
}

export const DEFAULT_LONG_EXPOSURE_OPTIONS: LongExposureOptions = {
  height: 1600, format: 'image/jpeg', qualityPct: 92, mode: 'trail', align: true,
}

export type LongExposureFrame = {
  data: Uint8ClampedArray
  width: number
  height: number
}

export type LongExposureSource = HdrSource

function grayOf(source: LongExposureSource): HdrGray {
  const h = SAMPLE_HEIGHT
  const w = Math.max(8, Math.round(source.width * h / Math.max(1, source.height)))
  const { ctx } = makeCanvas(w, h, '读不了这张长曝光照片', { willReadFrequently: true })
  ctx.drawImage(source.image, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data
  const out = new Uint8ClampedArray(w * h)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = Math.round(0.299 * px[p]! + 0.587 * px[p + 1]! + 0.114 * px[p + 2]!)
  }
  return { data: out, width: w, height: h }
}

/**
 * 纯函数：等尺寸、已对齐的多帧 → 长曝光 RGBA。
 * 透明区域（平移后露出的边）只用有像素的帧参与；全透明才保留透明。
 */
export function blendLongExposurePixels(
  frames: readonly LongExposureFrame[], mode: LongExposureMode,
): Uint8ClampedArray {
  if (frames.length < 2) throw new Error('长曝光至少要两张照片')
  const { width: w, height: h } = frames[0]!
  for (const f of frames) {
    if (f.width !== w || f.height !== h) throw new Error('长曝光照片尺寸对不上')
    if (f.data.length !== w * h * 4) throw new Error('长曝光照片尺寸对不上')
  }
  const out = new Uint8ClampedArray(w * h * 4)
  for (let p = 0; p < w * h; p++) {
    const i = p * 4
    let count = 0
    let sumR = 0, sumG = 0, sumB = 0
    let maxR = 0, maxG = 0, maxB = 0
    for (const f of frames) {
      if (f.data[i + 3]! < 128) continue
      const r = f.data[i]!, g = f.data[i + 1]!, b = f.data[i + 2]!
      count++
      sumR += r; sumG += g; sumB += b
      if (r > maxR) maxR = r
      if (g > maxG) maxG = g
      if (b > maxB) maxB = b
    }
    if (count === 0) continue
    if (mode === 'trail') {
      out[i] = maxR
      out[i + 1] = maxG
      out[i + 2] = maxB
    } else {
      out[i] = Math.round(sumR / count)
      out[i + 1] = Math.round(sumG / count)
      out[i + 2] = Math.round(sumB / count)
    }
    out[i + 3] = 255
  }
  return out
}

export function longExposureCanvasSize(
  width: number, height: number, targetHeight: number,
): { width: number; height: number } {
  const h = Math.max(1, Math.min(LONG_EXPOSURE_MAX_HEIGHT, Math.round(targetHeight)))
  let out = hdrCanvasSize(width, height, h)
  if (out.width * out.height > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / (out.width * out.height))
    out = {
      width: Math.max(1, Math.floor(out.width * scale)),
      height: Math.max(1, Math.floor(out.height * scale)),
    }
  }
  return out
}

export function renderLongExposureCanvas(
  sources: readonly LongExposureSource[],
  options: LongExposureOptions,
  height = options.height,
): { canvas: HTMLCanvasElement; width: number; height: number } {
  if (sources.length < 2) throw new Error('长曝光至少要两张照片')
  const refIndex = Math.floor(sources.length / 2)
  const ref = sources[refIndex]!
  const size = longExposureCanvasSize(ref.width, ref.height, height)
  const grays = sources.map(grayOf)
  const shifts = options.align
    ? grays.map((g, i) => i === refIndex
      ? { x: 0, y: 0, score: 1 }
      : estimateHdrShift(
        grays[refIndex]!, g,
        Math.max(2, Math.round(g.width * ALIGN_RATIO)),
        Math.max(2, Math.round(g.height * ALIGN_RATIO)),
      ))
    : sources.map(() => ({ x: 0, y: 0, score: 1 }))
  const frames: LongExposureFrame[] = []
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!
    const gray = grays[i]!
    const shift = shifts[i]!
    const dx = Math.round(shift.x * size.width / gray.width)
    const dy = Math.round(shift.y * size.height / gray.height)
    const { ctx } = makeCanvas(size.width, size.height, '合成不了这张长曝光', {
      willReadFrequently: true,
    })
    ctx.drawImage(src.image, dx, dy, size.width, size.height)
    frames.push({
      data: ctx.getImageData(0, 0, size.width, size.height).data,
      width: size.width,
      height: size.height,
    })
  }
  const blended = blendLongExposurePixels(frames, options.mode)
  const { canvas, ctx } = makeCanvas(size.width, size.height, '合成不了这张长曝光')
  const image = ctx.createImageData(size.width, size.height)
  image.data.set(blended)
  ctx.putImageData(image, 0, 0)
  return { canvas, width: size.width, height: size.height }
}

function ext(format: ExportFormat): string {
  return format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg'
}

export function longExposureFilename(format: ExportFormat, now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
  return `PinkRose-long-exposure-${stamp}.${ext(format)}`
}

export type LongExposureProgress = {
  completed: number
  total: number
  currentName: string
}

export async function exportLongExposure(
  files: readonly File[], options: LongExposureOptions,
  onProgress?: (p: LongExposureProgress) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string; width: number; height: number }> {
  if (files.length < 2) throw new Error('长曝光至少要两张照片')
  const decoded: DecodedImage[] = []
  try {
    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      onProgress?.({ completed: i, total: files.length, currentName: files[i]!.name })
      decoded.push(await decodeImageFile(files[i]!))
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress?.({ completed: files.length, total: files.length, currentName: '' })
    const made = renderLongExposureCanvas(
      decoded.map(d => ({ image: d.bitmap, width: d.width, height: d.height })),
      options,
    )
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const blob = await new Promise<Blob>((resolve, reject) => {
      made.canvas.toBlob(
        b => b ? resolve(b) : reject(new Error('这张长曝光编不出来')),
        options.format,
        options.qualityPct / 100,
      )
    })
    return {
      blob, filename: longExposureFilename(options.format),
      width: made.width, height: made.height,
    }
  } finally {
    for (const d of decoded) d.bitmap.close()
  }
}
