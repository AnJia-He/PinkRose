import { makeCanvas } from '../core/canvas'
import type { ExportFormat } from '../export/save'
import { decodeImageFile, type DecodedImage } from './decode'

export const MAX_COLLAGE_FILES = 9
const DESIGN_LONG_EDGE = 2048

export type CollageRatio = '1:1' | '4:5' | '3:4' | '16:9'
export type CollageLayout = 'auto' | 'grid' | 'feature-left' | 'feature-top'
export type CollageTemplateId = 'grid' | 'magazine' | 'film' | 'story' | 'nine'

export type CollageOptions = {
  ratio: CollageRatio
  layout: CollageLayout
  /** 输出尺度下的间距，同时用作外边距。 */
  gap: number
  /** 输出尺度下的圆角。 */
  radius: number
  background: string
  format: ExportFormat
  qualityPct: number
  longEdge: number
}

export type CollageCell = {
  x: number
  y: number
  width: number
  height: number
}

export type CollageSource = {
  image: CanvasImageSource
  width: number
  height: number
}

export const DEFAULT_COLLAGE_OPTIONS: CollageOptions = {
  ratio: '4:5',
  layout: 'auto',
  gap: 18,
  radius: 18,
  background: '#ffffff',
  format: 'image/jpeg',
  qualityPct: 92,
  longEdge: 2048,
}

/**
 * 一键模板只改版式 / 画幅 / 间距 / 圆角 / 背景，不动导出格式、质量、长边。
 * 用户之后仍可继续微调；改过任何一项，模板高亮自动取消。
 */
export const COLLAGE_TEMPLATES: readonly {
  id: CollageTemplateId
  label: string
  patch: Pick<CollageOptions, 'ratio' | 'layout' | 'gap' | 'radius' | 'background'>
}[] = [
  {
    id: 'grid', label: '经典网格',
    patch: { ratio: '1:1', layout: 'grid', gap: 12, radius: 12, background: '#ffffff' },
  },
  {
    id: 'magazine', label: '杂志',
    patch: { ratio: '4:5', layout: 'feature-left', gap: 6, radius: 0, background: '#111111' },
  },
  {
    id: 'film', label: '胶片条',
    patch: { ratio: '16:9', layout: 'grid', gap: 18, radius: 4, background: '#111111' },
  },
  {
    id: 'story', label: '大图故事',
    patch: { ratio: '3:4', layout: 'feature-top', gap: 14, radius: 18, background: '#f5f1ea' },
  },
  {
    id: 'nine', label: '九宫格',
    patch: { ratio: '1:1', layout: 'grid', gap: 4, radius: 0, background: '#ffffff' },
  },
]

export function collageTemplate(id: CollageTemplateId) {
  return COLLAGE_TEMPLATES.find(t => t.id === id)!
}

export function collageCanvasSize(
  ratio: CollageRatio, longEdge: number,
): { width: number; height: number } {
  const edge = Math.max(1, Math.round(longEdge))
  switch (ratio) {
    case '1:1': return { width: edge, height: edge }
    case '4:5': return { width: Math.round(edge * 4 / 5), height: edge }
    case '3:4': return { width: Math.round(edge * 3 / 4), height: edge }
    case '16:9': return { width: edge, height: Math.round(edge * 9 / 16) }
  }
}

export function resolveCollageLayout(
  count: number, layout: CollageLayout, width: number, height: number,
): Exclude<CollageLayout, 'auto'> {
  if (layout !== 'auto') return layout
  if (count === 3 || count === 5) return width >= height ? 'feature-top' : 'feature-left'
  return 'grid'
}

function gridColumns(count: number, width: number, height: number): number {
  if (count <= 2) return Math.max(1, count)
  if (count === 3) return width >= height ? 3 : 2
  if (count === 4) return 2
  if (count <= 6) return width >= height ? 3 : 2
  return 3
}

function gridCells(
  count: number, width: number, height: number, gap: number,
): CollageCell[] {
  const cols = gridColumns(count, width, height)
  const rows = Math.ceil(count / cols)
  const innerW = width - gap * 2
  const innerH = height - gap * 2
  const rowH = (innerH - gap * (rows - 1)) / rows
  const out: CollageCell[] = []
  for (let row = 0; row < rows; row++) {
    const items = Math.min(cols, count - row * cols)
    const cellW = (innerW - gap * (items - 1)) / items
    for (let col = 0; col < items; col++) {
      out.push({
        x: gap + col * (cellW + gap),
        y: gap + row * (rowH + gap),
        width: cellW,
        height: rowH,
      })
    }
  }
  return out
}

function featureLeftCells(
  count: number, width: number, height: number, gap: number,
): CollageCell[] {
  const innerW = width - gap * 2
  const innerH = height - gap * 2
  const leftW = (innerW - gap) * 0.62
  const rightW = innerW - gap - leftW
  const rows = Math.max(1, count - 1)
  const cellH = (innerH - gap * (rows - 1)) / rows
  const out: CollageCell[] = [{
    x: gap, y: gap, width: leftW, height: innerH,
  }]
  for (let i = 1; i < count; i++) {
    out.push({
      x: gap + leftW + gap,
      y: gap + (i - 1) * (cellH + gap),
      width: rightW,
      height: cellH,
    })
  }
  return out
}

function featureTopCells(
  count: number, width: number, height: number, gap: number,
): CollageCell[] {
  const innerW = width - gap * 2
  const innerH = height - gap * 2
  const topH = (innerH - gap) * 0.62
  const bottomH = innerH - gap - topH
  const cols = Math.max(1, count - 1)
  const cellW = (innerW - gap * (cols - 1)) / cols
  const out: CollageCell[] = [{
    x: gap, y: gap, width: innerW, height: topH,
  }]
  for (let i = 1; i < count; i++) {
    out.push({
      x: gap + (i - 1) * (cellW + gap),
      y: gap + topH + gap,
      width: cellW,
      height: bottomH,
    })
  }
  return out
}

export function collageCells(
  count: number, layout: CollageLayout, width: number, height: number, gap: number,
): CollageCell[] {
  if (count <= 0) return []
  const resolved = resolveCollageLayout(count, layout, width, height)
  const g = Math.max(0, Math.min(gap, Math.min(width, height) / 6))
  if (resolved === 'feature-left') return featureLeftCells(count, width, height, g)
  if (resolved === 'feature-top') return featureTopCells(count, width, height, g)
  return gridCells(count, width, height, g)
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, width: number, height: number, radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function drawCover(
  ctx: CanvasRenderingContext2D, source: CollageSource,
  x: number, y: number, width: number, height: number,
): void {
  const scale = Math.max(width / source.width, height / source.height)
  const sw = width / scale
  const sh = height / scale
  const sx = (source.width - sw) / 2
  const sy = (source.height - sh) / 2
  ctx.drawImage(source.image, sx, sy, sw, sh, x, y, width, height)
}

export function drawCollage(
  ctx: CanvasRenderingContext2D,
  sources: readonly CollageSource[],
  options: CollageOptions,
  width: number,
  height: number,
): void {
  ctx.save()
  ctx.fillStyle = options.background
  ctx.fillRect(0, 0, width, height)
  const scale = Math.max(width, height) / DESIGN_LONG_EDGE
  const gap = options.gap * scale
  const radius = options.radius * scale
  const cells = collageCells(sources.length, options.layout, width, height, gap)
  for (let i = 0; i < Math.min(cells.length, sources.length); i++) {
    const cell = cells[i]!
    const source = sources[i]!
    ctx.save()
    roundedRect(ctx, cell.x, cell.y, cell.width, cell.height, radius)
    ctx.clip()
    drawCover(ctx, source, cell.x, cell.y, cell.width, cell.height)
    ctx.restore()
  }
  ctx.restore()
}

/** 画一张拼图并返回画布。`longEdge` 传预览值时不会改 options 本身。 */
export function renderCollageCanvas(
  sources: readonly CollageSource[], options: CollageOptions, longEdge = options.longEdge,
): HTMLCanvasElement {
  const size = collageCanvasSize(options.ratio, longEdge)
  const { canvas, ctx } = makeCanvas(size.width, size.height, '拼不了这张图')
  drawCollage(ctx, sources, options, size.width, size.height)
  return canvas
}

function collageExtension(format: ExportFormat): string {
  return format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg'
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

export function collageFilename(format: ExportFormat, now = new Date()): string {
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
  return `PinkRose-collage-${stamp}.${collageExtension(format)}`
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

export type CollageProgress = {
  completed: number
  total: number
  currentName: string
}

/**
 * 拼图导出：逐张解码，画到同一张 2D 画布，再编码为文件。
 * 单张失败会让整张拼图失败（缺一格不是成品），因此错误直接向上抛。
 */
export async function exportCollage(
  files: readonly File[],
  options: CollageOptions,
  onProgress: (progress: CollageProgress) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string; width: number; height: number }> {
  if (files.length < 2) throw new Error('至少选两张照片才能拼图')
  if (files.length > MAX_COLLAGE_FILES) throw new Error(`一次最多拼 ${MAX_COLLAGE_FILES} 张`)

  const decoded: DecodedImage[] = []
  try {
    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) throw abortError()
      const file = files[i]!
      onProgress({ completed: i, total: files.length, currentName: file.name })
      decoded.push(await decodeImageFile(file))
      onProgress({ completed: i + 1, total: files.length, currentName: file.name })
    }
    if (signal?.aborted) throw abortError()
    const sources = decoded.map(d => ({
      image: d.bitmap, width: d.width, height: d.height,
    }))
    const canvas = renderCollageCanvas(sources, options)
    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, options.format, options.qualityPct / 100)
    })
    if (!blob) throw new Error('拼图没有导出成功')
    return {
      blob,
      filename: collageFilename(options.format),
      width: canvas.width,
      height: canvas.height,
    }
  } finally {
    for (const d of decoded) d.bitmap.close()
  }
}
