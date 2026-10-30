import { makeCanvas } from '../core/canvas'
import type { ExportFormat } from '../export/save'
import { decodeImageFile, type DecodedImage } from './decode'

/**
 * 全景拼接（★ 2026-10-18）。
 *
 * 用户按顺序选 2–8 张有重叠的照片，本机统一短边、自动找相邻两张的接缝，
 * 横向或纵向拼成一张长图。不做复杂单应性 / 柱面投影：对“站在原地转机身”
 * 这类全景足够，接缝用渐变混合，不调用模型。
 */
export const MAX_PANORAMA_FILES = 8
export const PANORAMA_MAX_HEIGHT = 2000
const SAMPLE_HEIGHT = 64
const MAX_PIXELS = 36_000_000

export type PanoramaAxis = 'horizontal' | 'vertical'

export type PanoramaOptions = {
  /** 输出短边：横向拼时是高度，纵向拼时是宽度。 */
  height: number
  format: ExportFormat
  qualityPct: number
  axis: PanoramaAxis
}

export const DEFAULT_PANORAMA_OPTIONS: PanoramaOptions = {
  height: 1600, format: 'image/jpeg', qualityPct: 92, axis: 'horizontal',
}

export type PanoramaSource = {
  image: CanvasImageSource
  width: number
  height: number
}

export type PanoramaGray = { data: Uint8Array; width: number; height: number }
export type PanoramaPlacement = {
  x: number; y: number; width: number; height: number; overlap: number
}
export type PanoramaLayout = { width: number; height: number; placements: PanoramaPlacement[] }

function grayOf(source: PanoramaSource, axis: PanoramaAxis): PanoramaGray {
  const height = axis === 'horizontal'
    ? SAMPLE_HEIGHT
    : Math.max(8, Math.round(source.height * SAMPLE_HEIGHT / source.width))
  const width = axis === 'horizontal'
    ? Math.max(8, Math.round(source.width * SAMPLE_HEIGHT / source.height))
    : SAMPLE_HEIGHT
  const { ctx } = makeCanvas(width, height, '读不了这张全景图', {
    willReadFrequently: true,
  })
  ctx.drawImage(source.image, 0, 0, width, height)
  const { data } = ctx.getImageData(0, 0, width, height)
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = Math.round(0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!)
  }
  return { data: out, width, height }
}

/** 归一化互相关：在候选重叠里找最像的那一段。返回像素宽度和相关性。 */
export function findPanoramaOverlap(
  left: PanoramaGray, right: PanoramaGray,
  minPx: number, maxPx: number,
  axis: PanoramaAxis = 'horizontal',
): { px: number; score: number } {
  const span = axis === 'horizontal'
    ? Math.min(left.width, right.width)
    : Math.min(left.height, right.height)
  const hi = Math.max(0, Math.min(
    span - 1, Math.floor(maxPx),
  ))
  const lo = Math.max(1, Math.min(hi, Math.floor(minPx)))
  if (hi < lo) return { px: 0, score: -1 }
  let best = { px: 0, score: -1 }
  // 逐像素找。灰度图短边固定 64，每个候选只抽 ~24×24 个点，整段搜索
  // 仍然是毫秒级；反过来，按步长跳会让真正的接缝落在两个候选之间
  // （50px 的真重叠被 49 / 52 跳过），噪声一张图就能把假峰顶上来。
  for (let overlap = lo; overlap <= hi; overlap++) {
    const alongStep = Math.max(1, Math.floor(overlap / 24))
    const crossStep = Math.max(1, Math.floor(
      (axis === 'horizontal' ? left.height : left.width) / 24,
    ))
    let n = 0, sl = 0, sr = 0, sll = 0, srr = 0, slr = 0
    if (axis === 'horizontal') {
      for (let y = 0; y < left.height; y += crossStep) {
        for (let x = 0; x < overlap; x += alongStep) {
          const l = left.data[y * left.width + (left.width - overlap + x)]!
          const r = right.data[y * right.width + x]!
          n++
          sl += l; sr += r; sll += l * l; srr += r * r; slr += l * r
        }
      }
    } else {
      for (let y = 0; y < overlap; y += alongStep) {
        for (let x = 0; x < left.width; x += crossStep) {
          const l = left.data[(left.height - overlap + y) * left.width + x]!
          const r = right.data[y * right.width + x]!
          n++
          sl += l; sr += r; sll += l * l; srr += r * r; slr += l * r
        }
      }
    }
    if (n < 4) continue
    const cov = slr - (sl * sr) / n
    const vl = sll - (sl * sl) / n
    const vr = srr - (sr * sr) / n
    const score = vl <= 1e-6 || vr <= 1e-6 ? 0 : cov / Math.sqrt(vl * vr)
    if (score > best.score) best = { px: overlap, score }
  }
  return best
}

/** 横向：按宽度和相邻重叠量排出每张图的 x。重叠会被夹在两边宽度以内。 */
export function panoramaLayout(
  widths: readonly number[], overlaps: readonly number[], height: number,
): PanoramaLayout {
  const w = widths.map(v => Math.max(1, Math.round(v)))
  const h = Math.max(1, Math.round(height))
  const placements: PanoramaPlacement[] = []
  let x = 0
  for (let i = 0; i < w.length; i++) {
    const overlap = i === 0 ? 0 : Math.max(0, Math.min(
      Math.round(overlaps[i - 1] ?? 0), w[i - 1]! - 1, w[i]! - 1,
    ))
    if (i > 0) x += w[i - 1]! - overlap
    placements.push({ x, y: 0, width: w[i]!, height: h, overlap })
  }
  const last = placements.at(-1)
  return {
    width: last ? last.x + last.width : 0,
    height: h,
    placements,
  }
}

/** 纵向：按高度和相邻重叠量排出每张图的 y。 */
export function panoramaLayoutVertical(
  heights: readonly number[], overlaps: readonly number[], width: number,
): PanoramaLayout {
  const h = heights.map(v => Math.max(1, Math.round(v)))
  const w = Math.max(1, Math.round(width))
  const placements: PanoramaPlacement[] = []
  let y = 0
  for (let i = 0; i < h.length; i++) {
    const overlap = i === 0 ? 0 : Math.max(0, Math.min(
      Math.round(overlaps[i - 1] ?? 0), h[i - 1]! - 1, h[i]! - 1,
    ))
    if (i > 0) y += h[i - 1]! - overlap
    placements.push({ x: 0, y, width: w, height: h[i]!, overlap })
  }
  const last = placements.at(-1)
  return {
    width: w,
    height: last ? last.y + last.height : 0,
    placements,
  }
}

/** 渲染全景画布；`shortSide` 用于预览（传 480 之类）或成片。 */
export function renderPanoramaCanvas(
  sources: readonly PanoramaSource[], options: PanoramaOptions, shortSide = options.height,
): { canvas: HTMLCanvasElement; layout: PanoramaLayout } {
  if (sources.length < 2) throw new Error('全景至少要两张照片')
  const axis = options.axis
  let size = Math.max(1, Math.min(PANORAMA_MAX_HEIGHT, Math.round(shortSide)))
  const build = (target: number) => {
    const grays = sources.map(s => grayOf(s, axis))
    const overlaps: number[] = []
    if (axis === 'horizontal') {
      const widths = sources.map(s => Math.max(1, Math.round(s.width * target / s.height)))
      for (let i = 1; i < sources.length; i++) {
        const left = grays[i - 1]!
        const right = grays[i]!
        const found = findPanoramaOverlap(
          left, right,
          Math.round(left.width * 0.08), Math.round(left.width * 0.60), 'horizontal',
        )
        const ratio = found.score >= 0.2 ? found.px / left.width : 0
        overlaps.push(Math.round(widths[i - 1]! * ratio))
      }
      return panoramaLayout(widths, overlaps, target)
    }
    const heights = sources.map(s => Math.max(1, Math.round(s.height * target / s.width)))
    for (let i = 1; i < sources.length; i++) {
      const left = grays[i - 1]!
      const right = grays[i]!
      const found = findPanoramaOverlap(
        left, right,
        Math.round(left.height * 0.08), Math.round(left.height * 0.60), 'vertical',
      )
      const ratio = found.score >= 0.2 ? found.px / left.height : 0
      overlaps.push(Math.round(heights[i - 1]! * ratio))
    }
    return panoramaLayoutVertical(heights, overlaps, target)
  }
  let layout = build(size)
  for (let guard = 0; layout.width * layout.height > MAX_PIXELS && size > 1 && guard < 8; guard++) {
    size = Math.max(1, Math.floor(size * Math.sqrt(MAX_PIXELS / (layout.width * layout.height))))
    layout = build(size)
  }
  const { canvas, ctx } = makeCanvas(layout.width, layout.height, '拼不了这张全景')
  ctx.imageSmoothingQuality = 'high'
  for (let i = 0; i < sources.length; i++) {
    const p = layout.placements[i]!
    ctx.drawImage(sources[i]!.image, p.x, p.y, p.width, p.height)
  }
  // 每个接缝：把先一张的边缘按 1→0 的渐变盖在后一张上，形成柔和过渡。
  for (let i = 1; i < layout.placements.length; i++) {
    const left = layout.placements[i - 1]!
    const right = layout.placements[i]!
    const overlap = right.overlap
    if (overlap <= 0) continue
    const src = sources[i - 1]!
    if (axis === 'horizontal') {
      const cropW = Math.max(1, Math.min(
        src.width, Math.round(overlap / left.width * src.width),
      ))
      const { canvas: seam, ctx: sctx } = makeCanvas(overlap, layout.height, '接不上这张全景')
      sctx.drawImage(src.image, src.width - cropW, 0, cropW, src.height, 0, 0, overlap, layout.height)
      const grad = sctx.createLinearGradient(0, 0, overlap, 0)
      grad.addColorStop(0, 'rgba(0,0,0,1)')
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      sctx.globalCompositeOperation = 'destination-in'
      sctx.fillStyle = grad
      sctx.fillRect(0, 0, overlap, layout.height)
      ctx.drawImage(seam, right.x, right.y)
    } else {
      const cropH = Math.max(1, Math.min(
        src.height, Math.round(overlap / left.height * src.height),
      ))
      const { canvas: seam, ctx: sctx } = makeCanvas(layout.width, overlap, '接不上这张全景')
      sctx.drawImage(src.image, 0, src.height - cropH, src.width, cropH, 0, 0, layout.width, overlap)
      const grad = sctx.createLinearGradient(0, 0, 0, overlap)
      grad.addColorStop(0, 'rgba(0,0,0,1)')
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      sctx.globalCompositeOperation = 'destination-in'
      sctx.fillStyle = grad
      sctx.fillRect(0, 0, layout.width, overlap)
      ctx.drawImage(seam, right.x, right.y)
    }
  }
  return { canvas, layout }
}

function ext(format: ExportFormat): string {
  return format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg'
}

export function panoramaFilename(format: ExportFormat, now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
  return `PinkRose-panorama-${stamp}.${ext(format)}`
}

export type PanoramaProgress = {
  completed: number
  total: number
  currentName: string
}

/**
 * 解码 → 规划 → 渲染 → 编码。所有位图在 finally 里关闭，取消时也关。
 */
export async function exportPanorama(
  files: readonly File[], options: PanoramaOptions,
  onProgress?: (p: PanoramaProgress) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string; width: number; height: number }> {
  if (files.length < 2) throw new Error('全景至少要两张照片')
  const decoded: DecodedImage[] = []
  try {
    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      onProgress?.({ completed: i, total: files.length, currentName: files[i]!.name })
      decoded.push(await decodeImageFile(files[i]!))
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress?.({ completed: files.length, total: files.length, currentName: '' })
    const { canvas, layout } = renderPanoramaCanvas(
      decoded.map(d => ({ image: d.bitmap, width: d.width, height: d.height })),
      options,
    )
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        b => b ? resolve(b) : reject(new Error('这张全景编不出来')),
        options.format,
        options.qualityPct / 100,
      )
    })
    return {
      blob, filename: panoramaFilename(options.format), width: layout.width, height: layout.height,
    }
  } finally {
    for (const d of decoded) d.bitmap.close()
  }
}
