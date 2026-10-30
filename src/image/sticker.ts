import { makeCanvas } from '../core/canvas'
import { BLEND_COMPOSITE } from './blend'
import {
  STICKER_PATHS,
  normalizeStickerOptions,
  stickerLayout,
  type StickerOptions,
} from '../../shared/sticker.ts'
import type { EditLayer, StickerLayer } from '../../shared/layers.ts'

export {
  DEFAULT_STICKER,
  STICKER_PATHS,
  normalizeStickerOptions,
  stickerLayout,
  type StickerLayout,
  type StickerOptions,
  type StickerShape,
  type StickerSource,
} from '../../shared/sticker.ts'

/** 自定义贴纸图片的运行时缓存：会话 JSON 里只存 data URL，导出时按它取位图。 */
const stickerImageCache = new Map<string, ImageBitmap>()

export function cacheStickerImage(dataUrl: string, bitmap: ImageBitmap): void {
  const old = stickerImageCache.get(dataUrl)
  if (old && old !== bitmap) old.close()
  stickerImageCache.set(dataUrl, bitmap)
}

export function cachedStickerImage(dataUrl: string | null | undefined): ImageBitmap | null {
  return dataUrl ? stickerImageCache.get(dataUrl) ?? null : null
}

/** 恢复会话 / 导出 / 封面之前，把自定义贴纸图片解出来放进缓存。坏图只跳过自己。 */
export async function preloadStickerImages(layers: readonly EditLayer[]): Promise<void> {
  const urls = new Set<string>()
  for (const layer of layers) {
    if (layer.kind === 'sticker' && layer.image && !stickerImageCache.has(layer.image)) {
      urls.add(layer.image)
    }
  }
  await Promise.all([...urls].map(async (url) => {
    try {
      const blob = await (await fetch(url)).blob()
      const bitmap = await createImageBitmap(blob)
      stickerImageCache.set(url, bitmap)
    } catch (e) {
      console.error('自定义贴纸图片没解出来', e)
    }
  }))
}

/** 把用户选的图片缩到 512 内并编码成透明 PNG，层 JSON 只存这一份。 */
export function stickerBitmapToDataUrl(bitmap: ImageBitmap, maxSide = 512): string {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const { canvas, ctx } = makeCanvas(width, height, '存不下这张贴纸图')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}

/** 把一层贴纸画进任意 2D 上下文；预览 / 导出共用。 */
export function drawStickerOptions(
  ctx: CanvasRenderingContext2D,
  input: Partial<StickerOptions>,
  width: number,
  height: number,
  custom: ImageBitmap | null = null,
): void {
  const o = normalizeStickerOptions(input)
  if (o.opacity <= 0) return
  if (o.source === 'image' && !custom) return
  const l = stickerLayout(width, height, o)
  ctx.save()
  ctx.globalAlpha = o.opacity / 100
  ctx.globalCompositeOperation = BLEND_COMPOSITE[o.blend]
  ctx.translate(l.cx, l.cy)
  ctx.rotate((l.rotation * Math.PI) / 180)
  if (o.flipH || o.flipV) ctx.scale(o.flipH ? -1 : 1, o.flipV ? -1 : 1)
  ctx.shadowColor = 'rgba(0,0,0,.34)'
  ctx.shadowBlur = Math.max(1, l.size * 0.035)
  ctx.shadowOffsetY = Math.max(1, l.size * 0.018)
  if (o.source === 'image') {
    const scale = o.fit === 'cover'
      ? Math.max(l.size / custom!.width, l.size / custom!.height)
      : Math.min(l.size / custom!.width, l.size / custom!.height)
    const w = custom!.width * scale
    const h = custom!.height * scale
    if (o.fit === 'cover') {
      ctx.beginPath()
      ctx.rect(-l.size / 2, -l.size / 2, l.size, l.size)
      ctx.clip()
    }
    ctx.drawImage(custom!, -w / 2, -h / 2, w, h)
  } else {
    ctx.translate(-l.size / 2, -l.size / 2)
    ctx.scale(l.size, l.size)
    ctx.fillStyle = o.color
    ctx.fill(new Path2D(STICKER_PATHS[o.shape]))
  }
  ctx.restore()
}

export function drawStickerLayer(
  ctx: CanvasRenderingContext2D, layer: StickerLayer, width: number, height: number,
): void {
  drawStickerOptions(ctx, layer.options, width, height, cachedStickerImage(layer.image))
}

/** 把贴纸画进新底图（旧的烘焙路径）。 */
export async function stickerToBitmap(
  source: ImageBitmap, input: Partial<StickerOptions>,
  custom: ImageBitmap | null = null,
): Promise<{ bitmap: ImageBitmap }> {
  if (normalizeStickerOptions(input).source === 'image' && !custom) {
    throw new Error('先选一张图片，再应用贴纸')
  }
  const { canvas, ctx } = makeCanvas(source.width, source.height, '贴不上这张贴纸')
  ctx.drawImage(source, 0, 0)
  drawStickerOptions(ctx, input, source.width, source.height, custom)
  return { bitmap: await createImageBitmap(canvas) }
}
