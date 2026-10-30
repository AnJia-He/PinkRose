import { makeCanvas } from '../core/canvas'
import { isLayerVisible, type EditLayer } from '../../shared/layers.ts'
import { drawTextOptions } from './text'
import { drawShapeOptions } from './shape'
import { drawStickerLayer } from './sticker'
import { applyLocalLayersToImageData, isLocalLayer } from './localLayer'

/** 把一组文字 / 形状层画进任意上下文；`offset` 用于裁切 / 扩展导出。 */
export function drawEditLayers(
  ctx: CanvasRenderingContext2D,
  layers: readonly EditLayer[],
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0,
): void {
  if (layers.length === 0) return
  ctx.save()
  ctx.translate(offsetX, offsetY)
  for (const layer of layers) {
    // 局部层是像素效果，不是叠图；它已经在底图 / 渲染管线里了。
    if (layer.kind === 'local' || !isLayerVisible(layer)) continue
    if (layer.kind === 'shape') drawShapeOptions(ctx, layer.options, width, height)
    else if (layer.kind === 'sticker') drawStickerLayer(ctx, layer, width, height)
    else drawTextOptions(ctx, layer.options, width, height)
  }
  ctx.restore()
}

/**
 * 封面 / 导出：复制底图并叠上所有层；没有层时原样返回。
 *
 * `localsAlreadyApplied` 用于源图**已经**带局部效果的情况（WebGL 画布 / 派生
 * 底图）；默认 false 时会在副本上同步补上局部层 —— 这条路要求调用方先
 * `await preloadLocalMasks(layers)`。
 * `maxSide` 只影响「要补局部层」的那条路：局部效果在缩略图尺寸上算一遍就够，
 * 没必要对一张 12 MP 的底图整张跑。
 */
export function compositeEditLayers(
  source: CanvasImageSource & { width: number; height: number },
  layers: readonly EditLayer[],
  opts: { localsAlreadyApplied?: boolean; maxSide?: number } = {},
): HTMLCanvasElement | (CanvasImageSource & { width: number; height: number }) {
  const local = layers.filter(layer => isLocalLayer(layer) && isLayerVisible(layer))
  const overlays = layers.filter(layer => layer.kind !== 'local' && isLayerVisible(layer))
  const applyLocal = local.length > 0 && !opts.localsAlreadyApplied
  if (!applyLocal && overlays.length === 0) return source
  const scale = applyLocal && opts.maxSide
    ? Math.min(1, opts.maxSide / Math.max(source.width, source.height))
    : 1
  const width = Math.max(1, Math.round(source.width * scale))
  const height = Math.max(1, Math.round(source.height * scale))
  const { canvas, ctx } = makeCanvas(width, height, '叠不上编辑层')
  if (scale === 1) ctx.drawImage(source, 0, 0)
  else ctx.drawImage(source, 0, 0, width, height)
  if (applyLocal) {
    const pixels = ctx.getImageData(0, 0, width, height)
    applyLocalLayersToImageData(pixels.data, width, height, layers)
    ctx.putImageData(pixels, 0, 0)
  }
  drawEditLayers(ctx, overlays, width, height)
  return canvas
}

/**
 * 几何工具入口：先把所有叠图层合并进一张临时位图；没有层时返回原对象。
 * 局部层**在这里跳过** —— 调用方拿到的 `source` 必须已经是带局部效果的底图
 * （`App` 给工具传的是 `effectiveImage`）。
 */
export async function editLayersToBitmap(
  source: ImageBitmap,
  layers: readonly EditLayer[],
): Promise<ImageBitmap> {
  const overlays = layers.filter(layer => layer.kind !== 'local' && isLayerVisible(layer))
  if (overlays.length === 0) return source
  const { canvas, ctx } = makeCanvas(source.width, source.height, '合并不了编辑层')
  ctx.drawImage(source, 0, 0)
  drawEditLayers(ctx, overlays, source.width, source.height)
  return createImageBitmap(canvas)
}
