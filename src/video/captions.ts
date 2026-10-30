/**
 * **短片字幕**（★ 2026-10-20）。
 *
 * 字幕不是"一层 DOM"，而是**烧进画面**的像素：导出的 MP4 在任何播放器里
 * 都带着它，不依赖平台支持字幕轨。这和我们做照片文字的取舍一致 ——
 * 用户在预览里看到什么，成片里就是什么。
 *
 * 时间轴是**全片时间**（几段拼起来之后的时间），不是某一段的时间；
 * 这样换顺序 / 剪短某一段时，字幕不会跟着乱跳。
 */

export const CAPTION_MAX = 10
export const CAPTION_MAX_CHARS = 42

export type CaptionPosition = 'top' | 'center' | 'bottom'
export type CaptionSize = 's' | 'm' | 'l'

export type VideoCaption = {
  id: string
  text: string
  startMs: number
  endMs: number
  position: CaptionPosition
  size: CaptionSize
  color: string
}

export const CAPTION_COLORS = [
  { id: '#ffffff', label: '白' },
  { id: '#ffe14d', label: '黄' },
  { id: '#ff6b6b', label: '红' },
] as const

const FONT_STACK = '"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif'

/** 去掉首尾空白、把连续空白压成一个空格；超出上限直接截断。 */
export function normalizeCaptionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, CAPTION_MAX_CHARS)
}

/** 某一刻显示哪条字幕；多条重叠时**后加的盖住先加的**。 */
export function captionAt(
  captions: readonly VideoCaption[], timeMs: number,
): VideoCaption | null {
  let hit: VideoCaption | null = null
  for (const caption of captions) {
    if (timeMs >= caption.startMs && timeMs < caption.endMs) hit = caption
  }
  return hit
}

/** 把一条字幕夹进全片范围，并保证至少 0.3 秒的显示时间。 */
export function clampCaption(
  caption: VideoCaption, totalMs: number,
): VideoCaption {
  const total = Math.max(300, Math.round(totalMs))
  const startMs = Math.max(0, Math.min(Math.round(caption.startMs), total - 300))
  const endMs = Math.max(startMs + 300,
    Math.min(Math.round(caption.endMs), total))
  return {
    ...caption,
    text: normalizeCaptionText(caption.text),
    startMs,
    endMs: Math.min(endMs, total),
  }
}

type MeasureCtx = Pick<CanvasRenderingContext2D, 'measureText' | 'fillText' | 'font'>

/**
 * 按宽度折行：中文逐字、拉丁按词。返回行数组（至少一行）。
 * 抽出来单独测：字幕最常见的翻车是"英文单词被从中间劈开"。
 */
export function wrapCaption(
  ctx: MeasureCtx, text: string, maxWidth: number,
): string[] {
  const tokens = text.match(/[A-Za-z0-9'’.,!?%:+-]+|\s+|[^\s]/g) ?? []
  const lines: string[] = []
  let line = ''
  const fits = (value: string) => ctx.measureText(value).width <= maxWidth
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      if (line) line += ' '
      continue
    }
    const next = line ? line + token : token
    if (fits(next) || !line) {
      line = next
      continue
    }
    lines.push(line.trimEnd())
    line = token
  }
  if (line.trim()) lines.push(line.trimEnd())
  return lines.length ? lines : ['']
}

type PaintCtx = CanvasRenderingContext2D

/** 把一条字幕画到画布上。字号跟画面高度走，4K 和 720p 的观感一致。 */
export function paintCaption(
  ctx: PaintCtx, caption: VideoCaption, width: number, height: number,
): void {
  const text = normalizeCaptionText(caption.text)
  if (!text) return
  const ratio = caption.size === 's' ? 0.045 : caption.size === 'm' ? 0.06 : 0.08
  const fontSize = Math.max(14, Math.round(height * ratio))
  ctx.save()
  ctx.font = `600 ${fontSize}px ${FONT_STACK}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lines = wrapCaption(ctx, text, width * 0.86)
  const lineHeight = Math.round(fontSize * 1.35)
  const padX = Math.round(fontSize * 0.6)
  const padY = Math.round(fontSize * 0.4)
  const textWidth = Math.max(...lines.map(line => ctx.measureText(line).width))
  const barW = Math.min(width * 0.94, textWidth + padX * 2)
  const barH = lines.length * lineHeight + padY * 2
  const anchor = caption.position === 'top' ? height * 0.1
    : caption.position === 'center' ? height / 2 - barH / 2
      : height * 0.9 - barH
  const x = (width - barW) / 2
  const y = Math.max(0, Math.min(height - barH, anchor))
  const radius = Math.min(barH / 2, fontSize * 0.5)
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + barW, y, x + barW, y + barH, radius)
  ctx.arcTo(x + barW, y + barH, x, y + barH, radius)
  ctx.arcTo(x, y + barH, x, y, radius)
  ctx.arcTo(x, y, x + barW, y, radius)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = caption.color
  lines.forEach((line, index) => {
    const lineY = y + padY + lineHeight * index + lineHeight / 2
    ctx.fillText(line, width / 2, lineY)
  })
  ctx.restore()
}
