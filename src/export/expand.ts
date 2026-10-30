import { makeCanvas } from '../core/canvas'
import { exportAspectRatio, type ExportAspect, type ExportFit } from './save'

/** 扩展后仍完整容纳原图的最小目标比例画布。 */
export function expandedSize(
  width: number, height: number, aspect: Exclude<ExportAspect, 'original'>,
): { width: number; height: number } {
  const ratio = exportAspectRatio(aspect)
  return {
    width: Math.max(width, Math.round(height * ratio)),
    height: Math.max(height, Math.round(width / ratio)),
  }
}

/**
 * 把画布扩展到目标比例，原图居中保持完整。
 * blur = 边缘用虚化铺底；mirror = 虚化铺底上再镜像外扩。
 */
export function expandCanvas(
  source: CanvasImageSource & { width: number; height: number },
  aspect: Exclude<ExportAspect, 'original'>, fit: ExportFit,
): HTMLCanvasElement {
  const size = expandedSize(source.width, source.height, aspect)
  const { canvas, ctx } = makeCanvas(size.width, size.height, '扩不了这张图')
  const dx = Math.round((size.width - source.width) / 2)
  const dy = Math.round((size.height - source.height) / 2)
  const scale = Math.max(size.width / source.width, size.height / source.height)
  const cw = source.width * scale
  const ch = source.height * scale
  ctx.save()
  ctx.filter = `blur(${Math.max(12, Math.round(Math.min(source.width, source.height) * 0.035))}px)`
  ctx.drawImage(source, (size.width - cw) / 2, (size.height - ch) / 2, cw, ch)
  ctx.restore()

  if (fit === 'mirror') {
    const drawSide = (side: 'left' | 'right' | 'top' | 'bottom') => {
      ctx.save()
      ctx.beginPath()
      if (side === 'left') ctx.rect(0, 0, dx, size.height)
      else if (side === 'right') ctx.rect(dx + source.width, 0, size.width - dx - source.width, size.height)
      else if (side === 'top') ctx.rect(0, 0, size.width, dy)
      else ctx.rect(0, dy + source.height, size.width, size.height - dy - source.height)
      ctx.clip()
      if (side === 'left') {
        ctx.translate(dx, 0); ctx.scale(-1, 1)
      } else if (side === 'right') {
        ctx.translate(dx + source.width, 0); ctx.scale(-1, 1)
      } else if (side === 'top') {
        ctx.translate(0, dy); ctx.scale(1, -1)
      } else {
        ctx.translate(0, dy + source.height); ctx.scale(1, -1)
      }
      if (side === 'left' || side === 'right') {
        ctx.drawImage(source, 0, dy, source.width, source.height)
      } else {
        ctx.drawImage(source, dx, 0, source.width, source.height)
      }
      ctx.restore()
    }
    drawSide('left')
    drawSide('right')
    drawSide('top')
    drawSide('bottom')
  }
  ctx.drawImage(source, dx, dy)
  return canvas
}
