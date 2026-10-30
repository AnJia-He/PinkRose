import { makeCanvas } from '../core/canvas'
import type { ExportFormat } from '../export/save'

/**
 * **长图拼接**（★ 2026-10-18）—— 把 2–20 张照片按顺序接成一张长图。
 *
 * 和全景不同：这里不找重叠、不做透视，只按用户选定的顺序，把每张缩放到
 * 同一条固定边后依次排开。适合聊天记录、步骤图、穿搭图这类本来就不需要
 * 接缝融合的素材。全在本机画布上完成，不调用模型。
 */

export const MAX_LONG_IMAGE_FILES = 20
export const LONG_IMAGE_MAX_EDGE = 16384

export type LongImageDirection = 'vertical' | 'horizontal'

export type LongImageOptions = {
  direction: LongImageDirection
  /** 图与图之间的间距（输出像素）。 */
  gap: number
  /** 每张图的外缘圆角（输出像素）。 */
  radius: number
  background: string
  format: ExportFormat
  qualityPct: number
  /** 纵向长图的固定宽度 / 横向长图的固定高度。 */
  fixedEdge: number
}

export const DEFAULT_LONG_IMAGE_OPTIONS: LongImageOptions = {
  direction: 'vertical',
  gap: 12,
  radius: 0,
  background: '#ffffff',
  format: 'image/jpeg',
  qualityPct: 92,
  fixedEdge: 1080,
}

export type LongImageSource = {
  image: CanvasImageSource
  width: number
  height: number
}

export type LongImageFrame = {
  x: number
  y: number
  w: number
  h: number
}

export type LongImagePlan = {
  width: number
  height: number
  frames: LongImageFrame[]
  /** 总量超过画布上限时的整体缩放。 */
  scale: number
}

function extensionOf(format: ExportFormat): 'png' | 'webp' | 'jpg' {
  return format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg'
}

function safeStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim()
  return stem || 'photo'
}

export function longImageFilename(baseName: string, format: ExportFormat): string {
  return `${safeStem(baseName)}_long.${extensionOf(format)}`
}

/**
 * 先按用户选定的固定边算目标尺寸，再把总长超限的整张图等比缩下来。
 * 固定边可以放大（放大不会增加细节），长边上限才是硬保护。
 */
export function longImagePlan(
  sources: readonly Pick<LongImageSource, 'width' | 'height'>[],
  options: LongImageOptions,
): LongImagePlan {
  if (sources.length === 0) {
    return { width: 1, height: 1, frames: [], scale: 1 }
  }
  const gap = Math.max(0, Math.min(240, Math.round(options.gap)))
  const fixed = Math.max(64, Math.round(options.fixedEdge))

  if (options.direction === 'horizontal') {
    const baseH = fixed
    const widths = sources.map(s => Math.max(1, s.width) * baseH / Math.max(1, s.height))
    const total = widths.reduce((sum, w) => sum + w, 0) + gap * (sources.length - 1)
    const scale = Math.min(1, LONG_IMAGE_MAX_EDGE / Math.max(1, total))
    const h = Math.max(1, Math.round(baseH * scale))
    const g = Math.round(gap * scale)
    let x = 0
    const frames = widths.map(w => {
      const fw = Math.max(1, Math.round(w * scale))
      const frame = { x, y: 0, w: fw, h }
      x += fw + g
      return frame
    })
    return { width: Math.max(1, x - g), height: h, frames, scale }
  }

  const baseW = fixed
  const heights = sources.map(s => Math.max(1, s.height) * baseW / Math.max(1, s.width))
  const total = heights.reduce((sum, h) => sum + h, 0) + gap * (sources.length - 1)
  const scale = Math.min(1, LONG_IMAGE_MAX_EDGE / Math.max(1, total))
  const w = Math.max(1, Math.round(baseW * scale))
  const g = Math.round(gap * scale)
  let y = 0
  const frames = heights.map(h => {
    const fh = Math.max(1, Math.round(h * scale))
    const frame = { x: 0, y, w, h: fh }
    y += fh + g
    return frame
  })
  return { width: w, height: Math.max(1, y - g), frames, scale }
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

/**
 * 渲染长图。`previewMax > 0` 时整张等比缩进预览框，但每张图的相对位置、
 * 间距和圆角都按同一个比例缩，预览和成片不会两套排版。
 */
export function renderLongImageCanvas(
  sources: readonly LongImageSource[],
  options: LongImageOptions,
  previewMax = 0,
): HTMLCanvasElement {
  const plan = longImagePlan(sources, options)
  const scale = previewMax > 0
    ? Math.min(1, previewMax / Math.max(plan.width, plan.height))
    : 1
  const width = Math.max(1, Math.round(plan.width * scale))
  const height = Math.max(1, Math.round(plan.height * scale))
  const { canvas, ctx } = makeCanvas(width, height, '拼不了这张长图')
  ctx.fillStyle = options.background
  ctx.fillRect(0, 0, width, height)

  const radius = Math.max(0, Math.min(options.radius * scale, Math.min(width, height) / 2))
  sources.forEach((source, index) => {
    const frame = plan.frames[index]
    if (!frame) return
    const x = Math.round(frame.x * scale)
    const y = Math.round(frame.y * scale)
    const w = Math.max(1, Math.round(frame.w * scale))
    const h = Math.max(1, Math.round(frame.h * scale))
    ctx.save()
    if (radius > 0) {
      roundedRect(ctx, x, y, w, h, radius)
      ctx.clip()
    }
    ctx.drawImage(source.image, x, y, w, h)
    ctx.restore()
  })
  return canvas
}

function canvasToBlob(
  canvas: HTMLCanvasElement, format: ExportFormat, qualityPct: number,
): Promise<Blob> {
  const quality = Math.max(0.5, Math.min(1, qualityPct / 100))
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('长图没有导出成功')),
      format,
      format === 'image/png' ? undefined : quality,
    )
  })
}

export async function exportLongImage(
  sources: readonly LongImageSource[],
  options: LongImageOptions,
  baseName = 'long',
): Promise<{ blob: Blob; filename: string; width: number; height: number }> {
  const canvas = renderLongImageCanvas(sources, options)
  const blob = await canvasToBlob(canvas, options.format, options.qualityPct)
  return {
    blob,
    filename: longImageFilename(baseName, options.format),
    width: canvas.width,
    height: canvas.height,
  }
}
