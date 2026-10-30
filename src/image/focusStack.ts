import { makeCanvas } from '../core/canvas'
import type { ExportFormat } from '../export/save'
import { decodeImageFile } from './decode'
import { estimateHdrShift, type HdrGray, type HdrSource } from './hdrMerge'

/**
 * 焦点堆栈（★ 2026-10-19）。
 *
 * 同一机位、不同对焦点的 2–15 张照片：每张只有一部分清楚。这里在本地
 * 估计轻微平移、计算局部清晰度，逐像素保留最清楚的一到两张，合成一张
 * 前后都清楚的成片。不调用模型。
 *
 * ⚠️ 与 HDR 不同：不是把多张曝光平均，而是**选最清楚的像素**。平均会把
 *   每一张的模糊一起带回来，正好抵消堆栈的意义。
 */
export const MAX_FOCUS_FILES = 15
export const FOCUS_MAX_HEIGHT = 2400
const SAMPLE_HEIGHT = 72
const MAX_PIXELS = 12_000_000
const ALIGN_RATIO = 0.03

export type FocusOptions = {
  height: number
  format: ExportFormat
  qualityPct: number
  align: boolean
}

export const DEFAULT_FOCUS_OPTIONS: FocusOptions = {
  height: 1600, format: 'image/jpeg', qualityPct: 92, align: true,
}

export type FocusSource = HdrSource

export type FocusFrame = {
  data: Uint8ClampedArray
  width: number
  height: number
}

export type FocusWinners = {
  bestR: Uint8ClampedArray
  bestG: Uint8ClampedArray
  bestB: Uint8ClampedArray
  bestS: Float32Array
  secondR: Uint8ClampedArray
  secondG: Uint8ClampedArray
  secondB: Uint8ClampedArray
  secondS: Float32Array
}

export type FocusProgress = {
  completed: number
  total: number
  currentName: string
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

/** 成片尺寸：高度定死，宽度按参考图比例走，总像素超限时降高度。 */
export function focusCanvasSize(
  width: number, height: number, targetHeight: number,
): { width: number; height: number } {
  let h = clampInt(targetHeight, 1, FOCUS_MAX_HEIGHT)
  let w = Math.max(1, Math.round(width * h / Math.max(1, height)))
  if (w * h > MAX_PIXELS) {
    h = Math.max(1, Math.floor(h * Math.sqrt(MAX_PIXELS / (w * h))))
    w = Math.max(1, Math.round(width * h / Math.max(1, height)))
  }
  return { width: w, height: h }
}

function grayOf(source: FocusSource): HdrGray {
  const h = SAMPLE_HEIGHT
  const w = Math.max(8, Math.round(source.width * h / Math.max(1, source.height)))
  const { ctx } = makeCanvas(w, h, '读不了这张对焦照片', { willReadFrequently: true })
  ctx.drawImage(source.image, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data
  const out = new Uint8ClampedArray(w * h)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = Math.round(0.299 * px[p]! + 0.587 * px[p + 1]! + 0.114 * px[p + 2]!)
  }
  return { data: out, width: w, height: h }
}

function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(0, Math.floor(radius))
  if (r === 0) return src
  const win = 2 * r + 1
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let k = -r; k <= r; k++) sum += src[row + Math.max(0, Math.min(w - 1, k))]!
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win
      sum -= src[row + Math.max(0, Math.min(w - 1, x - r))]!
      sum += src[row + Math.max(0, Math.min(w - 1, x + r + 1))]!
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += tmp[Math.max(0, Math.min(h - 1, k)) * w + x]!
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win
      sum -= tmp[Math.max(0, Math.min(h - 1, y - r)) * w + x]!
      sum += tmp[Math.max(0, Math.min(h - 1, y + r + 1)) * w + x]!
    }
  }
  return out
}

/**
 * 局部清晰度：拉普拉斯响应的绝对值和，再做一次 5×5 左右的盒式平滑。
 * 平滑是必须的：单像素噪声也会产生高响应，直接取最大值会把噪点当成对焦点。
 */
export function sharpnessMap(
  data: Uint8ClampedArray, width: number, height: number,
): Float32Array {
  if (data.length !== width * height * 4) {
    throw new Error('清晰度计算的像素尺寸对不上')
  }
  const luma = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = Math.round(0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!)
  }
  const raw = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width
    const down = Math.min(height - 1, y + 1) * width
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - 1)
      const right = Math.min(width - 1, x + 1)
      const i = y * width + x
      const center = luma[i]!
      raw[i] = Math.abs(
        4 * center
        - luma[y * width + left]!
        - luma[y * width + right]!
        - luma[up + x]!
        - luma[down + x]!,
      )
    }
  }
  return boxBlur(raw, width, height, 2)
}

export function createFocusWinners(pixels: number): FocusWinners {
  const n = Math.max(0, Math.floor(pixels))
  return {
    bestR: new Uint8ClampedArray(n),
    bestG: new Uint8ClampedArray(n),
    bestB: new Uint8ClampedArray(n),
    bestS: new Float32Array(n).fill(-1),
    secondR: new Uint8ClampedArray(n),
    secondG: new Uint8ClampedArray(n),
    secondB: new Uint8ClampedArray(n),
    secondS: new Float32Array(n).fill(-1),
  }
}

/** 用一帧的清晰度图更新每个像素的前两名。 */
export function updateFocusWinners(
  winners: FocusWinners, frame: FocusFrame, sharpness: Float32Array,
): void {
  const n = frame.width * frame.height
  if (frame.data.length !== n * 4 || sharpness.length !== n
    || winners.bestS.length !== n) {
    throw new Error('焦点堆栈的帧尺寸对不上')
  }
  for (let i = 0; i < n; i++) {
    const s = sharpness[i]!
    const p = i * 4
    if (s > winners.bestS[i]!) {
      winners.secondR[i] = winners.bestR[i]!
      winners.secondG[i] = winners.bestG[i]!
      winners.secondB[i] = winners.bestB[i]!
      winners.secondS[i] = winners.bestS[i]!
      winners.bestR[i] = frame.data[p]!
      winners.bestG[i] = frame.data[p + 1]!
      winners.bestB[i] = frame.data[p + 2]!
      winners.bestS[i] = s
    } else if (s > winners.secondS[i]!) {
      winners.secondR[i] = frame.data[p]!
      winners.secondG[i] = frame.data[p + 1]!
      winners.secondB[i] = frame.data[p + 2]!
      winners.secondS[i] = s
    }
  }
}

/** 前两名清晰度接近时做一次柔和混合，避免对焦过渡处出现硬边。 */
export function resolveFocusPixels(winners: FocusWinners): Uint8ClampedArray {
  const n = winners.bestS.length
  const out = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const bs = winners.bestS[i]!
    const ss = winners.secondS[i]!
    let r = winners.bestR[i]!
    let g = winners.bestG[i]!
    let b = winners.bestB[i]!
    if (bs >= 0 && ss >= 0 && ss >= bs * 0.72) {
      const wb = bs * bs + 1e-6
      const ws = ss * ss + 1e-6
      const sum = wb + ws
      r = Math.round((winners.bestR[i]! * wb + winners.secondR[i]! * ws) / sum)
      g = Math.round((winners.bestG[i]! * wb + winners.secondG[i]! * ws) / sum)
      b = Math.round((winners.bestB[i]! * wb + winners.secondB[i]! * ws) / sum)
    }
    const p = i * 4
    out[p] = r
    out[p + 1] = g
    out[p + 2] = b
    out[p + 3] = 255
  }
  return out
}

/** 预览 / 成片共用：对齐、逐帧算清晰度、合成。 */
export function renderFocusStackCanvas(
  sources: readonly FocusSource[], options: FocusOptions, height = options.height,
): { canvas: HTMLCanvasElement; width: number; height: number } {
  if (sources.length < 2) throw new Error('焦点堆栈至少要两张照片')
  const refIndex = Math.floor(sources.length / 2)
  const ref = sources[refIndex]!
  const size = focusCanvasSize(ref.width, ref.height, height)
  const grays = sources.map(grayOf)
  const shifts = options.align
    ? grays.map((gray, i) => i === refIndex
      ? { x: 0, y: 0, score: 1 }
      : estimateHdrShift(
        grays[refIndex]!, gray,
        Math.max(2, Math.round(gray.width * ALIGN_RATIO)),
        Math.max(2, Math.round(gray.height * ALIGN_RATIO)),
      ))
    : sources.map(() => ({ x: 0, y: 0, score: 1 }))
  const winners = createFocusWinners(size.width * size.height)

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!
    const gray = grays[i]!
    const shift = shifts[i]!
    const dx = Math.round(shift.x * size.width / gray.width)
    const dy = Math.round(shift.y * size.height / gray.height)
    const { ctx } = makeCanvas(size.width, size.height, '合成不了这张焦点堆栈', {
      willReadFrequently: true,
    })
    ctx.drawImage(src.image, dx, dy, size.width, size.height)
    const frame: FocusFrame = {
      data: ctx.getImageData(0, 0, size.width, size.height).data,
      width: size.width,
      height: size.height,
    }
    updateFocusWinners(winners, frame, sharpnessMap(frame.data, size.width, size.height))
  }

  const { canvas, ctx } = makeCanvas(size.width, size.height, '合成不了这张焦点堆栈')
  const image = ctx.createImageData(size.width, size.height)
  image.data.set(resolveFocusPixels(winners))
  ctx.putImageData(image, 0, 0)
  return { canvas, width: size.width, height: size.height }
}

function ext(format: ExportFormat): string {
  return format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg'
}

export function focusStackFilename(format: ExportFormat, now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
  return `PinkRose-focus-${stamp}.${ext(format)}`
}

/**
 * 解码 → 估位移 → 再解码并对齐合成 → 编码。
 * 两趟解码是为了不在内存里同时留 15 张全尺寸位图；相机用户的大图在
 * iOS 上尤其经不起这个。
 */
export async function exportFocusStack(
  files: readonly File[], options: FocusOptions,
  onProgress?: (p: FocusProgress) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string; width: number; height: number }> {
  if (files.length < 2) throw new Error('焦点堆栈至少要两张照片')
  const total = files.length * 2
  const metas: { file: File; width: number; height: number; gray: HdrGray }[] = []
  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress?.({ completed: i, total, currentName: files[i]!.name })
    const decoded = await decodeImageFile(files[i]!)
    try {
      metas.push({
        file: files[i]!,
        width: decoded.width,
        height: decoded.height,
        gray: grayOf({ image: decoded.bitmap, width: decoded.width, height: decoded.height }),
      })
    } finally {
      decoded.bitmap.close()
    }
  }
  const refIndex = Math.floor(metas.length / 2)
  const ref = metas[refIndex]!
  const size = focusCanvasSize(ref.width, ref.height, options.height)
  const shifts = options.align
    ? metas.map((meta, i) => i === refIndex
      ? { x: 0, y: 0, score: 1 }
      : estimateHdrShift(
        ref.gray, meta.gray,
        Math.max(2, Math.round(meta.gray.width * ALIGN_RATIO)),
        Math.max(2, Math.round(meta.gray.height * ALIGN_RATIO)),
      ))
    : metas.map(() => ({ x: 0, y: 0, score: 1 }))
  const winners = createFocusWinners(size.width * size.height)

  for (let i = 0; i < metas.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress?.({ completed: metas.length + i, total, currentName: metas[i]!.file.name })
    const decoded = await decodeImageFile(metas[i]!.file)
    try {
      const shift = shifts[i]!
      const dx = Math.round(shift.x * size.width / metas[i]!.gray.width)
      const dy = Math.round(shift.y * size.height / metas[i]!.gray.height)
      const { ctx } = makeCanvas(size.width, size.height, '合成不了这张焦点堆栈', {
        willReadFrequently: true,
      })
      ctx.drawImage(decoded.bitmap, dx, dy, size.width, size.height)
      const frame: FocusFrame = {
        data: ctx.getImageData(0, 0, size.width, size.height).data,
        width: size.width,
        height: size.height,
      }
      updateFocusWinners(winners, frame, sharpnessMap(frame.data, size.width, size.height))
    } finally {
      decoded.bitmap.close()
    }
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const { canvas } = makeCanvas(size.width, size.height, '合成不了这张焦点堆栈')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('拿不到焦点堆栈画布')
  const image = ctx.createImageData(size.width, size.height)
  image.data.set(resolveFocusPixels(winners))
  ctx.putImageData(image, 0, 0)
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      b => b ? resolve(b) : reject(new Error('这张焦点堆栈编不出来')),
      options.format,
      options.qualityPct / 100,
    )
  })
  return {
    blob, filename: focusStackFilename(options.format),
    width: size.width, height: size.height,
  }
}
