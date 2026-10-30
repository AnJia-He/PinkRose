/**
 * **可回改局部层**的胶水（★ 2026-10-19）。
 *
 * 数据在 `shared/local.ts`：一张灰度掩码 PNG + 一组局部参数。这里只做三件事：
 *   ① 把 0–255 掩码压到最长边 1280 再编码（存会话）；
 *   ② 把掩码解回当前底图尺寸（浏览器双线性放大）；
 *   ③ 按层序把 `localAdjustPixels` 叠到底图上。
 *
 * ⚠️ **底图永远是干净的**：局部层不写回 `image.bitmap`，而是每次派生一张
 *   `effectiveImage` 给画布 / 工具用。这样「回来改」才有东西可改；
 *   一旦用户用裁剪 / 磨皮 / 液化这类底图工具，派生图会先被烤进新底图，
 *   局部层随即清空（`App` 的 `setBaseImage`）。
 * ⚠️ 掩码解码失败**抛**，不静默少画一层 —— 否则用户看到的是"局部层自己没了"。
 */
import { makeCanvas } from '../core/canvas'
import { featherMask, scaleMask } from '../core/retouch'
import { localAdjustPixels, localAdjustToBitmap } from './localAdjust'
import {
  LOCAL_MASK_MAX_CHARS, LOCAL_MASK_MAX_SIDE, type LocalLayer,
} from '../../shared/local.ts'
import { isLayerVisible, type EditLayer } from '../../shared/layers.ts'

export function isLocalLayer(layer: EditLayer): layer is LocalLayer {
  return layer.kind === 'local'
}

const maskPromises = new Map<string, Promise<HTMLImageElement>>()
const maskImages = new Map<string, HTMLImageElement>()
/** 掩码缓存上限：换几条会话之后旧掩码不该一直占着解码后的位图。 */
const MASK_CACHE_MAX = 24

function trimMaskCache(): void {
  while (maskImages.size > MASK_CACHE_MAX) {
    const oldest = maskImages.keys().next().value
    if (!oldest) break
    maskImages.delete(oldest)
    maskPromises.delete(oldest)
  }
}

function loadMask(data: string): Promise<HTMLImageElement> {
  const hit = maskPromises.get(data)
  if (hit) return hit
  const p = (async () => {
    if (typeof Image === 'undefined') throw new Error('这个浏览器没有 Image，解不开局部蒙版')
    const img = new Image()
    img.decoding = 'async'
    img.src = data
    if (typeof img.decode === 'function') {
      await img.decode()
    } else {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('局部蒙版解不开'))
      })
    }
    maskImages.set(data, img)
    trimMaskCache()
    return img
  })()
  p.catch(() => maskPromises.delete(data))
  maskPromises.set(data, p)
  return p
}

/** 先把这一组层用到的掩码都解开；`compositeEditLayers` 的同步路径要求这一步。 */
export async function preloadLocalMasks(layers: readonly EditLayer[]): Promise<void> {
  await Promise.all(
    layers.filter((layer): layer is LocalLayer => isLocalLayer(layer) && isLayerVisible(layer))
      .map(layer => loadMask(layer.mask)),
  )
}

function maskFromImage(img: CanvasImageSource, width: number, height: number): Uint8Array {
  const { ctx } = makeCanvas(width, height, '解不开局部蒙版', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, width, height)
  const data = ctx.getImageData(0, 0, width, height).data
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4]!
  return mask
}

export function localLayerFeatherRadius(
  layer: LocalLayer, width: number, height: number,
): number {
  if (layer.feather <= 0) return 0
  return Math.round(Math.min(width, height) * 0.12 * (layer.feather / 100))
}

/** 把一条层的掩码解到目标尺寸（浏览器双线性放大）；调用方可直接拿来涂。 */
export async function decodeMask(
  layer: LocalLayer, width: number, height: number,
): Promise<Uint8Array> {
  const img = await loadMask(layer.mask)
  return maskFromImage(img, width, height)
}

function preloadedMask(layer: LocalLayer, width: number, height: number): Uint8Array {
  const img = maskImages.get(layer.mask)
  if (!img) throw new Error('局部蒙版还没解好（先 await preloadLocalMasks）')
  return maskFromImage(img, width, height)
}

/**
 * 画笔掩码 → 存会话用的 PNG。按最长边压到 1280；缩小时做区域平均，
 * 边缘不会因为抽点采样出现锯齿。
 */
function encodeAt(
  mask: Uint8Array, width: number, height: number, maxSide: number,
): { mask: string; maskWidth: number; maskHeight: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height))
  const tw = Math.max(1, Math.round(width * scale))
  const th = Math.max(1, Math.round(height * scale))
  const { canvas, ctx } = makeCanvas(tw, th, '存不下局部蒙版')
  const out = ctx.createImageData(tw, th)
  const sx = width / tw
  const sy = height / th
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor(ty * sy)
    const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil((ty + 1) * sy)))
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * sx)
      const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil((tx + 1) * sx)))
      let sum = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += mask[y * width + x]!
          n++
        }
      }
      const v = n > 0 ? Math.round(sum / n) : 0
      const i = (ty * tw + tx) * 4
      out.data[i] = v
      out.data[i + 1] = v
      out.data[i + 2] = v
      out.data[i + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)
  return { mask: canvas.toDataURL('image/png'), maskWidth: tw, maskHeight: th }
}

export async function encodeMask(
  mask: Uint8Array, width: number, height: number,
): Promise<{ mask: string; maskWidth: number; maskHeight: number }> {
  if (mask.length !== width * height) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${mask.length} 字节，照片 ${width}×${height}）`)
  }
  // PNG 仍可能因为细碎边缘 / 噪点压不下来：逐档缩，直到进会话上限。
  let side = LOCAL_MASK_MAX_SIDE
  for (;;) {
    const out = encodeAt(mask, width, height, side)
    if (out.mask.length <= LOCAL_MASK_MAX_CHARS) return out
    if (side <= 320) throw new Error('这层蒙版太复杂，压不进会话上限；换个小一点的选区。')
    side = Math.max(320, Math.round(side * 0.7))
  }
}

function isBitmap(source: CanvasImageSource): source is ImageBitmap {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return true
  return typeof (source as ImageBitmap).close === 'function'
}

/**
 * 把一组局部层按顺序叠到源图上，返回一张**新的**位图；没有局部层返回 null。
 * 调用方负责关闭返回的位图。
 */
export async function applyLocalLayers(
  source: CanvasImageSource & { width: number; height: number },
  layers: readonly EditLayer[],
): Promise<ImageBitmap | null> {
  const local = layers.filter(
    (layer): layer is LocalLayer => isLocalLayer(layer) && isLayerVisible(layer),
  )
  if (local.length === 0) return null
  const owned: ImageBitmap[] = []
  let current: ImageBitmap
  if (isBitmap(source)) {
    current = source
  } else {
    const { canvas, ctx } = makeCanvas(source.width, source.height, '合并不了局部层')
    ctx.drawImage(source, 0, 0)
    current = await createImageBitmap(canvas)
    owned.push(current)
  }
  try {
    for (const layer of local) {
      const mask = await decodeMask(layer, current.width, current.height)
      const radius = localLayerFeatherRadius(layer, current.width, current.height)
      const feathered = radius > 0
        ? featherMask(mask, current.width, current.height, radius)
        : mask
      const opacity = layer.opacity ?? 100
      const applied = opacity < 100
        ? scaleMask(feathered, opacity)
        : feathered
      const { bitmap } = await localAdjustToBitmap(current, applied, layer.options)
      owned.push(bitmap)
      current = bitmap
    }
  } catch (e) {
    for (const b of owned) b.close()
    throw e
  }
  for (const b of owned) if (b !== current) b.close()
  return current
}

/**
 * 同步版：直接改一块 RGBA（缩略图 / 封面用）。要求掩码已经 `preloadLocalMasks`。
 * 返回是否真的叠了局部层。
 */
export function applyLocalLayersToImageData(
  data: Uint8ClampedArray, width: number, height: number,
  layers: readonly EditLayer[],
): boolean {
  const local = layers.filter(
    (layer): layer is LocalLayer => isLocalLayer(layer) && isLayerVisible(layer),
  )
  if (local.length === 0) return false
  for (const layer of local) {
    const mask = preloadedMask(layer, width, height)
    const radius = localLayerFeatherRadius(layer, width, height)
    const feathered = radius > 0 ? featherMask(mask, width, height, radius) : mask
    const opacity = layer.opacity ?? 100
    const applied = opacity < 100 ? scaleMask(feathered, opacity) : feathered
    localAdjustPixels(data, width, height, applied, layer.options)
  }
  return true
}
