import { TonePipeline } from './pipeline'
import type { DecodedImage } from '../image/decode'
import type { Adjustments } from '../../shared/adjustments.ts'
import type { Cube } from '../../shared/lut.ts'

/**
 * 缩略图预览器：**用当前这张照片**给每个滤镜渲染一张小方图（设计 §4.4 / spec §8.3
 * "用当前这张照片渲染 —— 比「黄昏」两个字有用得多"）。
 *
 * 做法：先给整张照片做一份 256px 的小拷贝（一次），之后每个滤镜都是在这张小图上
 * 重画一下（很便宜），再 cover 裁成方形、转 dataURL。
 *
 * ⚠️ 它自己的 canvas 是**离屏的**（`document.createElement`，不进 DOM）——
 * 别拿主画布来画：那会把用户眼前的图闪成一张小图。
 */
export const PREVIEW_SRC_MAX = 256
export const LUT_THUMB_SIZE = 132

/**
 * cover 裁切：把 srcW×srcH 里最大的一块正方形框出来（多余的部分两端各切一半）。
 *
 * ⚠️ `dstW`/`dstH` 收下但用不着 —— 输出永远是正方形，裁的是源那一侧。
 *    留着这两个参数是为了和 `drawImage` 的语义对称（读的人一看就知道这是
 *    "cover 到某个目标框"）；下划线是因为 `noUnusedParameters` 开着。
 */
export function coverCrop(srcW: number, srcH: number, _dstW: number, _dstH: number) {
  const side = Math.min(srcW, srcH)
  return {
    sx: Math.round((srcW - side) / 2),
    sy: Math.round((srcH - side) / 2),
    sw: side,
    sh: side,
  }
}

export type LutPreview = {
  /** 换照片（可重复调，认对象身份；同一张不会重做） */
  setImage(image: DecodedImage): Promise<void>
  /** 画一张：当前参数 + 这个 cube（null = 不用滤镜）。失败回 null。 */
  render(params: Adjustments, cube: Cube | null): string | null
  dispose(): void
}

export function createLutPreview(): LutPreview {
  const dpr = Math.min(2, Math.max(1, Math.round(globalThis.devicePixelRatio || 1)))
  const size = LUT_THUMB_SIZE * dpr
  const small = document.createElement('canvas')      // 照片的小拷贝，管线画在这上面
  const out = document.createElement('canvas')        // 方形的那张（裁 + 缩）
  out.width = size
  out.height = size
  const outCtx = out.getContext('2d')!
  let pipe: TonePipeline | null = null
  let lastBitmap: ImageBitmap | null = null

  const ensurePipe = (): TonePipeline => {
    if (!pipe) pipe = new TonePipeline(small)
    return pipe
  }

  return {
    async setImage(image) {
      if (lastBitmap === image.bitmap) return
      const scale = PREVIEW_SRC_MAX / Math.max(image.width, image.height)
      const w = Math.max(1, Math.round(image.width * scale))
      const h = Math.max(1, Math.round(image.height * scale))
      const src = document.createElement('canvas')
      src.width = w
      src.height = h
      // 缩图用 2D 画布做（createImageBitmap 带 resizeWidth 在 Safari 上不齐）
      src.getContext('2d')!.drawImage(image.bitmap, 0, 0, w, h)
      const bitmap = await createImageBitmap(src)
      lastBitmap?.close()
      lastBitmap = bitmap
      const p = ensurePipe()
      p.setImage({ bitmap, width: w, height: h })
      p.resizeToImage()
    },
    render(params, cube) {
      if (!lastBitmap) return null
      try {
        const p = ensurePipe()
        p.setLut(cube)
        p.render(params, 100)        // 缩略图一律按满强度画：看的是"这个滤镜长什么样"
        const crop = coverCrop(small.width, small.height, size, size)
        outCtx.drawImage(small, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, size, size)
        return out.toDataURL('image/jpeg', 0.82)
      } catch (e) {
        console.error('滤镜缩略图没画出来：', e)
        return null
      }
    },
    dispose() {
      pipe?.dispose()
      pipe = null
      lastBitmap?.close()
      lastBitmap = null
    },
  }
}
