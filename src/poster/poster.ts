import { makeCanvas } from '../core/canvas'
import { drawTextOptions, textFontFamily } from '../image/text'
import { decodeImageFile } from '../image/decode'

/**
 * 社交封面 / 海报模板（★ 2026-10-20）。
 *
 * 目标是「一张照片 + 一段标题」直接得到可发平台的成品，不是再做一套自由排版：
 *   · 小红书封面 3:4、朋友圈 1:1、竖屏故事 9:16、杂志留白；
 *   · 照片裁切、渐变、标题 / 副标题 / 日期、强调色都在本机 Canvas 完成；
 *   · 导出 JPG / PNG，不调用模型。
 */

export type PosterTemplateId = 'xiaohongshu' | 'moments' | 'story' | 'magazine'

export type PosterTemplate = {
  id: PosterTemplateId
  label: string
  width: number
  height: number
  note: string
}

export const POSTER_TEMPLATES: readonly PosterTemplate[] = [
  { id: 'xiaohongshu', label: '小红书封面', width: 1080, height: 1440, note: '3:4，标题压在照片下缘' },
  { id: 'moments', label: '朋友圈', width: 1080, height: 1080, note: '1:1，照片留白 + 标题' },
  { id: 'story', label: '竖屏故事', width: 1080, height: 1920, note: '9:16，适合短视频封面' },
  { id: 'magazine', label: '杂志留白', width: 1080, height: 1440, note: '3:4，白底 / 彩色底留白' },
] as const

export type PosterOptions = {
  template: PosterTemplateId
  title: string
  subtitle: string
  date: string
  /** 强调线 / 日期颜色。 */
  accent: string
  /** 标题颜色。 */
  textColor: string
  /** 留白模板的底色。 */
  background: string
}

export const DEFAULT_POSTER: PosterOptions = {
  template: 'xiaohongshu',
  title: '把今天的光留住',
  subtitle: 'PINKROSE · PHOTO NOTE',
  date: '',
  accent: '#ff6f91',
  textColor: '#ffffff',
  background: '#121318',
}

export type PosterSource = CanvasImageSource & { width: number; height: number }

type PosterRenderOptions = PosterOptions & { format?: 'image/jpeg' | 'image/png' }

const hex = (value: string, fallback: string) => (
  /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback
)

function coverRect(
  ctx: CanvasRenderingContext2D,
  source: PosterSource,
  x: number, y: number, w: number, h: number,
  radius = 0,
): void {
  const sw = Math.max(1, source.width)
  const sh = Math.max(1, source.height)
  const scale = Math.max(w / sw, h / sh)
  const dw = sw * scale
  const dh = sh * scale
  ctx.save()
  if (radius > 0) {
    ctx.beginPath()
    ctx.moveTo(x + radius, y)
    ctx.arcTo(x + w, y, x + w, y + h, radius)
    ctx.arcTo(x + w, y + h, x, y + h, radius)
    ctx.arcTo(x, y + h, x, y, radius)
    ctx.arcTo(x, y, x + w, y, radius)
    ctx.closePath()
    ctx.clip()
  }
  ctx.drawImage(source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
  ctx.restore()
}

/** 按字符宽度折行；中文、英文、空格都能处理，保留用户显式换行。 */
function wrapText(
  ctx: CanvasRenderingContext2D, text: string, fontPx: number, maxWidth: number,
): string {
  const raw = text.trim()
  if (!raw) return ''
  ctx.save()
  ctx.font = `bold ${fontPx}px ${textFontFamily('sans')}`
  const lines: string[] = []
  for (const paragraph of raw.split('\n')) {
    let line = ''
    for (const char of [...paragraph]) {
      if (line && ctx.measureText(line + char).width > maxWidth) {
        lines.push(line)
        line = char
      } else {
        line += char
      }
    }
    if (line) lines.push(line)
  }
  ctx.restore()
  return lines.join('\n')
}

function titleOptions(
  text: string, x: number, y: number, fontPx: number,
  color: string, maxWidth: number, ctx: CanvasRenderingContext2D,
): Parameters<typeof drawTextOptions>[1] {
  return {
    text: wrapText(ctx, text, fontPx, maxWidth),
    x, y, fontPx, color, font: 'sans', align: 'center', bold: true,
    lineHeight: 1.12, shadow: true,
  }
}

function drawDate(
  ctx: CanvasRenderingContext2D, date: string,
  x: number, y: number, fontPx: number, color: string,
  width: number, height: number,
): void {
  if (!date.trim()) return
  drawTextOptions(ctx, {
    text: date.trim(), x, y, fontPx, color, font: 'mono',
    align: 'center', bold: true, letterSpacing: 2,
  }, width, height)
}

/** 纯 Canvas 绘制；预览和成片共用。 */
export function drawPoster(
  ctx: CanvasRenderingContext2D,
  source: PosterSource,
  width: number,
  height: number,
  options: PosterOptions,
): void {
  const template = POSTER_TEMPLATES.find(t => t.id === options.template) ?? POSTER_TEMPLATES[0]!
  const W = width || template.width
  const H = height || template.height
  const accent = hex(options.accent, DEFAULT_POSTER.accent)
  const textColor = hex(options.textColor, DEFAULT_POSTER.textColor)
  const background = hex(options.background, DEFAULT_POSTER.background)
  const title = options.title.trim() || DEFAULT_POSTER.title
  const subtitle = options.subtitle.trim()

  if (template.id === 'moments' || template.id === 'magazine') {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, W, H)
    const inset = W * 0.065
    const photoH = template.id === 'moments' ? H * 0.68 : H * 0.54
    coverRect(ctx, source, inset, inset, W - inset * 2, photoH, W * 0.025)
    ctx.fillStyle = accent
    ctx.fillRect(W / 2 - W * 0.055, photoH + H * 0.055, W * 0.11, Math.max(3, W * 0.006))
    drawTextOptions(ctx, titleOptions(
      title, 0.5, 0.805, W * 0.078, textColor, W * 0.84, ctx,
    ), W, H)
    if (subtitle) {
      drawTextOptions(ctx, {
        text: subtitle, x: 0.5, y: 0.875, fontPx: W * 0.032,
        color: textColor, font: 'sans', align: 'center', bold: false,
      }, W, H)
    }
    drawDate(ctx, options.date, 0.5, 0.115, W * 0.024, accent, W, H)
    return
  }

  coverRect(ctx, source, 0, 0, W, H)
  const start = template.id === 'story' ? H * 0.46 : H * 0.42
  const grade = ctx.createLinearGradient(0, start, 0, H)
  grade.addColorStop(0, 'rgba(0,0,0,0)')
  grade.addColorStop(0.6, 'rgba(0,0,0,.42)')
  grade.addColorStop(1, 'rgba(0,0,0,.86)')
  ctx.fillStyle = grade
  ctx.fillRect(0, start, W, H - start)

  const titleY = template.id === 'story' ? H * 0.72 : H * 0.78
  const titleSize = W * (template.id === 'story' ? 0.068 : 0.074)
  ctx.fillStyle = accent
  ctx.fillRect(W * 0.075, titleY - H * 0.065, W * 0.012, H * 0.052)
  drawTextOptions(ctx, titleOptions(
    title, 0.5, titleY / H, titleSize, textColor, W * 0.84, ctx,
  ), W, H)
  if (subtitle) {
    drawTextOptions(ctx, {
      text: subtitle, x: 0.5, y: (titleY + H * 0.105) / H,
      fontPx: W * 0.031, color: textColor, font: 'sans',
      align: 'center', bold: false,
    }, W, H)
  }
  drawDate(ctx, options.date, 0.5, 0.075, W * 0.024, accent, W, H)
}

function filenameFor(template: PosterTemplateId, format: string, now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
  return `PinkRose-poster-${template}-${stamp}.${format === 'image/png' ? 'png' : 'jpg'}`
}

export async function renderPoster(
  file: File, options: PosterRenderOptions,
): Promise<{ blob: Blob; width: number; height: number; filename: string }> {
  const template = POSTER_TEMPLATES.find(t => t.id === options.template) ?? POSTER_TEMPLATES[0]!
  const decoded = await decodeImageFile(file)
  try {
    const { canvas, ctx } = makeCanvas(template.width, template.height, '海报画不出来')
    drawPoster(ctx, decoded.bitmap, template.width, template.height, options)
    const format = options.format ?? 'image/jpeg'
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        b => b ? resolve(b) : reject(new Error('浏览器没有生成海报文件')),
        format,
        format === 'image/jpeg' ? 0.94 : undefined,
      )
    })
    return {
      blob, width: template.width, height: template.height,
      filename: filenameFor(template.id, format),
    }
  } finally {
    decoded.bitmap.close()
  }
}
