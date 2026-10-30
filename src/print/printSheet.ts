export type PrintTemplateId =
  | '6x4-8' | '6x4-4' | '6x4-1' | '5x7-2' | 'a4-9' | 'a4-6' | 'a5-4' | 'custom'
export type PrintFit = 'cover' | 'contain'
export type PrintOrientation = 'auto' | 'landscape' | 'portrait'

export type PrintTemplate = {
  id: PrintTemplateId
  label: string
  width: number
  height: number
  cols: number
  rows: number
  note: string
}

export const PRINT_TEMPLATES: readonly PrintTemplate[] = [
  {
    id: '6x4-8', label: '6 寸 · 8 张', width: 1800, height: 1200,
    cols: 4, rows: 2, note: '4 × 2，常用小照片拼版',
  },
  {
    id: '6x4-4', label: '6 寸 · 4 张', width: 1800, height: 1200,
    cols: 2, rows: 2, note: '2 × 2，大一点的照片',
  },
  {
    id: '6x4-1', label: '6 寸 · 1 张', width: 1800, height: 1200,
    cols: 1, rows: 1, note: '1 × 1，单张 6 寸照片',
  },
  {
    id: '5x7-2', label: '5×7 · 2 张', width: 2100, height: 1500,
    cols: 2, rows: 1, note: '2 × 1，5×7 相纸',
  },
  {
    id: 'a4-9', label: 'A4 · 9 张', width: 2480, height: 3508,
    cols: 3, rows: 3, note: '3 × 3，300dpi',
  },
  {
    id: 'a4-6', label: 'A4 · 6 张', width: 2480, height: 3508,
    cols: 2, rows: 3, note: '2 × 3，留更多细节',
  },
  {
    id: 'a5-4', label: 'A5 · 4 张', width: 1748, height: 2480,
    cols: 2, rows: 2, note: '2 × 2，A5 相纸',
  },
  {
    id: 'custom', label: '自定义尺寸', width: 1800, height: 1200,
    cols: 2, rows: 2, note: '输入毫米宽高和行列',
  },
] as const

export const PRINT_MAX_FILES = 9

export type PrintCell = { x: number; y: number; w: number; h: number }

export type PrintLayoutOptions = {
  /** 页边距，纸张短边的百分比；默认 3.5，范围 0~15。 */
  marginPct?: number
  /** 格子间距，纸张短边的百分比；默认 1.8，范围 0~10。 */
  gapPct?: number
  /**
   * 每个格子用第几张照片（`sources` 的下标）。不传 = 按顺序循环铺。
   * 长度可以小于格子数，缺的格子继续循环。
   */
  order?: readonly number[]
}

export function templateById(id: PrintTemplateId): PrintTemplate {
  return PRINT_TEMPLATES.find(t => t.id === id) ?? PRINT_TEMPLATES[0]!
}

/** 模板默认 / 强制横版 / 强制竖版；换向时格子的行列也跟着转。 */
export function orientTemplate(
  template: PrintTemplate, orientation: PrintOrientation = 'auto',
): PrintTemplate {
  const landscape = template.width >= template.height
  if (orientation === 'auto'
    || (orientation === 'landscape' && landscape)
    || (orientation === 'portrait' && !landscape)) return template
  return {
    ...template,
    width: template.height,
    height: template.width,
    cols: template.rows,
    rows: template.cols,
    note: `${template.rows} × ${template.cols}，${orientation === 'portrait' ? '竖版' : '横版'}`,
  }
}

function pct(v: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(v)) return fallback
  return Math.max(0, Math.min(max, v!))
}

export function printCells(
  template: PrintTemplate, options: Pick<PrintLayoutOptions, 'marginPct' | 'gapPct'> = {},
): PrintCell[] {
  const short = Math.min(template.width, template.height)
  const margin = Math.round(short * pct(options.marginPct, 3.5, 15) / 100)
  const gap = Math.round(short * pct(options.gapPct, 1.8, 10) / 100)
  const cellW = Math.floor(
    (template.width - margin * 2 - gap * (template.cols - 1)) / template.cols,
  )
  const cellH = Math.floor(
    (template.height - margin * 2 - gap * (template.rows - 1)) / template.rows,
  )
  const out: PrintCell[] = []
  for (let row = 0; row < template.rows; row++) {
    for (let col = 0; col < template.cols; col++) {
      out.push({
        x: margin + col * (cellW + gap),
        y: margin + row * (cellH + gap),
        w: cellW,
        h: cellH,
      })
    }
  }
  return out
}

export function drawPrintSheet(
  canvas: HTMLCanvasElement,
  sources: readonly (CanvasImageSource & { width: number; height: number })[],
  template: PrintTemplate,
  fit: PrintFit,
  cutLines = true,
  options: PrintLayoutOptions = {},
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('拿不到 2D 上下文，排不了版')
  if (sources.length === 0) throw new Error('先放几张照片')

  const sx = canvas.width / template.width
  const sy = canvas.height / template.height
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const cells = printCells(template, options)
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!
    const wanted = options.order?.[i]
    const sourceIndex = Number.isInteger(wanted) && wanted! >= 0 && wanted! < sources.length
      ? wanted!
      : i % sources.length
    const src = sources[sourceIndex]!
    const scale = fit === 'cover'
      ? Math.max(cell.w / src.width, cell.h / src.height)
      : Math.min(cell.w / src.width, cell.h / src.height)
    const w = src.width * scale
    const h = src.height * scale
    const x = cell.x + (cell.w - w) / 2
    const y = cell.y + (cell.h - h) / 2
    ctx.save()
    ctx.beginPath()
    ctx.rect(cell.x * sx, cell.y * sy, cell.w * sx, cell.h * sy)
    ctx.clip()
    ctx.drawImage(src, x * sx, y * sy, w * sx, h * sy)
    ctx.restore()
    if (cutLines) {
      ctx.strokeStyle = 'rgba(0, 0, 0, .22)'
      ctx.lineWidth = Math.max(1, Math.round(shortSide(template) / 720))
      ctx.strokeRect(
        cell.x * sx + 0.5, cell.y * sy + 0.5,
        cell.w * sx - 1, cell.h * sy - 1,
      )
    }
  }
}

function shortSide(template: PrintTemplate): number {
  return Math.min(template.width, template.height)
}

export function printFilename(template: PrintTemplate, now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
  return `PinkRose-print-${template.id}-${stamp}.jpg`
}

export async function renderPrintSheet(
  files: readonly Blob[],
  templateId: PrintTemplateId,
  fit: PrintFit,
  cutLines = true,
  previewMaxSide = 0,
  options: PrintLayoutOptions = {},
  orientation: PrintOrientation = 'auto',
  customTemplate?: PrintTemplate | null,
): Promise<{ blob: Blob; width: number; height: number; filename: string }> {
  if (files.length === 0) throw new Error('先放几张照片')
  const template = orientTemplate(customTemplate ?? templateById(templateId), orientation)
  const bitmaps: ImageBitmap[] = []
  try {
    for (const file of files) bitmaps.push(await createImageBitmap(file))
    const scale = previewMaxSide > 0
      ? Math.min(1, previewMaxSide / Math.max(template.width, template.height))
      : 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(template.width * scale))
    canvas.height = Math.max(1, Math.round(template.height * scale))
    drawPrintSheet(canvas, bitmaps, template, fit, cutLines, options)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        b => (b ? resolve(b) : reject(new Error('浏览器没有生成排版文件'))),
        'image/jpeg', 0.95,
      )
    })
    return {
      blob, width: canvas.width, height: canvas.height,
      filename: printFilename(template),
    }
  } finally {
    for (const bitmap of bitmaps) bitmap.close()
  }
}
