import { makeCanvas } from '../core/canvas'
import { buildZipBlob, type ZipEntry } from '../batch/zip'
import type { ExportFormat } from '../export/save'

/**
 * **九宫格切图**（★ 2026-10-18）—— 把一张照片切成 N×N 张独立图片，
 * 按 1 → N² 的顺序打包成 ZIP。
 *
 * 和拼图 / 批量处理同一条路：全在本机画布上算，不调用模型、不写全局参数。
 * 切出来的每张都按原图对应格子居中裁切，不拉伸；单格长边只做**不放大**的
 * 上限保护，避免小图被硬拉大。
 */

export const GRID_SIZES = [2, 3, 4] as const
export type GridSize = typeof GRID_SIZES[number]

export type GridSplitOptions = {
  size: GridSize
  /** 输出图里的格子间距（px）；0 = 无缝切分。 */
  gap: number
  /** 输出图里的圆角（px）。 */
  radius: number
  /** 背景色；'transparent' 只在 PNG / WebP 下保留透明。 */
  background: string
  format: ExportFormat
  qualityPct: number
  /** 单格长边上限；不会把原图放大超过它。 */
  tileLongEdge: number
}

export const DEFAULT_GRID_SPLIT_OPTIONS: GridSplitOptions = {
  size: 3,
  gap: 0,
  radius: 0,
  background: '#ffffff',
  format: 'image/jpeg',
  qualityPct: 92,
  tileLongEdge: 1080,
}

export type GridTilePlan = {
  /** 每张导出图的尺寸。 */
  tileW: number
  tileH: number
  /** 实际使用的间距（会被格子尺寸夹住）。 */
  gapPx: number
  /** 间距以内真正放照片的区域。 */
  contentW: number
  contentH: number
  /** 原图上一格的尺寸（浮点，供裁切用）。 */
  cellW: number
  cellH: number
  scale: number
}

export type GridCellRect = {
  index: number
  row: number
  col: number
  sx: number
  sy: number
  sw: number
  sh: number
}

export type GridTile = {
  index: number
  row: number
  col: number
  width: number
  height: number
  blob: Blob
}

export type GridSplitResult = {
  tiles: GridTile[]
  zip: Blob
  zipFilename: string
}

function extensionOf(format: ExportFormat): 'png' | 'webp' | 'jpg' {
  return format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg'
}

function safeStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim()
  return stem || 'photo'
}

export function gridTileFilename(baseName: string, format: ExportFormat, index: number): string {
  return `${safeStem(baseName)}_${index + 1}.${extensionOf(format)}`
}

export function gridZipFilename(baseName: string): string {
  return `${safeStem(baseName)}_grid.zip`
}

/**
 * 单格尺寸：先按原图短边 / 长边算出原格，再缩到 `tileLongEdge` 以内。
 * 只缩不放 —— 原图一格比 1080 小时保留原尺寸。
 */
export function gridTilePlan(
  width: number, height: number, size: GridSize, tileLongEdge: number, gap: number,
): GridTilePlan {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const cellW = w / size
  const cellH = h / size
  const wanted = Math.max(1, Math.round(tileLongEdge))
  const scale = Math.min(1, wanted / Math.max(cellW, cellH))
  const tileW = Math.max(8, Math.round(cellW * scale))
  const tileH = Math.max(8, Math.round(cellH * scale))
  const maxGap = Math.max(0, Math.min(tileW, tileH) - 2)
  const gapPx = Math.max(0, Math.min(Math.round(gap), maxGap))
  return {
    tileW, tileH, gapPx,
    contentW: tileW - gapPx,
    contentH: tileH - gapPx,
    cellW, cellH, scale,
  }
}

/** 第 index 格在原图上的归一化位置（row-major：1 → N²）。 */
export function gridCellRect(
  index: number, size: GridSize, width: number, height: number,
): GridCellRect {
  const col = index % size
  const row = Math.floor(index / size)
  const sw = width / size
  const sh = height / size
  return { index, row, col, sx: col * sw, sy: row * sh, sw, sh }
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, radius: number,
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

function canvasToBlob(
  canvas: HTMLCanvasElement, format: ExportFormat, qualityPct: number,
): Promise<Blob> {
  const quality = Math.max(0.5, Math.min(1, qualityPct / 100))
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('这一格没有导出成功')),
      format,
      format === 'image/png' ? undefined : quality,
    )
  })
}

export async function splitGrid(
  source: CanvasImageSource, width: number, height: number,
  options: GridSplitOptions = DEFAULT_GRID_SPLIT_OPTIONS,
  baseName = 'photo',
): Promise<GridSplitResult> {
  const size = options.size
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const plan = gridTilePlan(w, h, size, options.tileLongEdge, options.gap)
  const format = options.format
  const transparent = options.background === 'transparent' && format !== 'image/jpeg'
  const background = options.background === 'transparent' ? '#ffffff' : options.background
  const radius = Math.max(0, Math.min(options.radius, Math.min(plan.tileW, plan.tileH) / 2))
  const tiles: GridTile[] = []
  const entries: ZipEntry[] = []

  for (let index = 0; index < size * size; index++) {
    const cell = gridCellRect(index, size, w, h)
    const { canvas, ctx } = makeCanvas(plan.tileW, plan.tileH, '切不开这张照片')
    ctx.save()
    if (radius > 0) {
      roundedRect(ctx, 0, 0, plan.tileW, plan.tileH, radius)
      ctx.clip()
    }
    if (!transparent) {
      ctx.fillStyle = background
      ctx.fillRect(0, 0, plan.tileW, plan.tileH)
    }

    // 间距以内按 cover 居中裁切：格子比例和照片格子比例略有差异时
    // 只裁掉一点边缘，绝不拉伸。
    const dx = plan.gapPx / 2
    const dy = plan.gapPx / 2
    const cover = Math.max(plan.contentW / cell.sw, plan.contentH / cell.sh)
    const cw = plan.contentW / cover
    const ch = plan.contentH / cover
    const sx = cell.sx + (cell.sw - cw) / 2
    const sy = cell.sy + (cell.sh - ch) / 2
    ctx.drawImage(source, sx, sy, cw, ch, dx, dy, plan.contentW, plan.contentH)
    ctx.restore()

    const blob = await canvasToBlob(canvas, format, options.qualityPct)
    tiles.push({
      index, row: cell.row, col: cell.col,
      width: plan.tileW, height: plan.tileH, blob,
    })
    entries.push({
      name: gridTileFilename(baseName, format, index),
      data: new Uint8Array(await blob.arrayBuffer()),
    })
  }

  return {
    tiles,
    zip: buildZipBlob(entries),
    zipFilename: gridZipFilename(baseName),
  }
}
