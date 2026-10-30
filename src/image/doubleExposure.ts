import { makeCanvas } from '../core/canvas'
import { BLEND_COMPOSITE, type BlendMode } from './blend'

/** 双重曝光（★ 2026-10-17）—— 第二张图按混合模式叠到当前底图上。 */
export type { BlendMode } from './blend'

export type DoubleExposureOptions = {
  mode: BlendMode
  /** 0~100。 */
  opacity: number
}

export const DEFAULT_DOUBLE_EXPOSURE: DoubleExposureOptions = {
  mode: 'screen',
  opacity: 50,
}

export { BLEND_COMPOSITE }

/** 第二张图按 cover 铺满目标矩形时，它该画在哪。 */
export function coverRect(
  srcW: number, srcH: number, dstW: number, dstH: number,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.max(dstW / Math.max(1, srcW), dstH / Math.max(1, srcH))
  const width = srcW * scale
  const height = srcH * scale
  return { x: (dstW - width) / 2, y: (dstH - height) / 2, width, height }
}

export async function doubleExposureToBitmap(
  base: ImageBitmap, overlay: ImageBitmap, options: DoubleExposureOptions,
): Promise<ImageBitmap> {
  const { canvas, ctx } = makeCanvas(base.width, base.height, '叠不了这张图')
  ctx.drawImage(base, 0, 0)
  const r = coverRect(overlay.width, overlay.height, base.width, base.height)
  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(100, options.opacity)) / 100
  ctx.globalCompositeOperation = BLEND_COMPOSITE[options.mode]
  ctx.drawImage(overlay, r.x, r.y, r.width, r.height)
  ctx.restore()
  return createImageBitmap(canvas, { premultiplyAlpha: 'none' })
}

/** 预览图也先按 base 的宽高做 cover，这样页面上的 img 和画布严丝合缝。 */
export function makeDoubleExposurePreview(
  baseWidth: number, baseHeight: number, overlay: ImageBitmap, maxSide = 1280,
): string {
  const scale = Math.min(1, maxSide / Math.max(baseWidth, baseHeight))
  const w = Math.max(1, Math.round(baseWidth * scale))
  const h = Math.max(1, Math.round(baseHeight * scale))
  const { canvas, ctx } = makeCanvas(w, h, '做不了叠加预览')
  const r = coverRect(overlay.width, overlay.height, w, h)
  ctx.drawImage(overlay, r.x, r.y, r.width, r.height)
  return canvas.toDataURL('image/png')
}
