import { fitWithin } from '../../shared/size.ts'
import type { Sizable } from '../image/prepare'

/** 对话里那张小图的边长上限。160 够看清"天蓝了没有"，再大就只是浪费内存。 */
export const THUMB_MAX_SIDE = 160

/**
 * 把一张图/画布缩成一张小图，返回 data URL。
 *
 * **返回字符串而不是位图**：位图占 GPU 内存（这个项目为此写过好几个
 * `bitmapsToClose` 的注释），而对话里最多六张缩略图，为它们占六份 GPU 内存
 * 完全不值。data URL 是普通内存，一张约 5~10 KB。
 *
 * 用 JPEG 0.7：缩略图看的是"大概长什么样"，不是细节。
 * 带 alpha 的图会变黑底，但我们的图都是照片，没有透明通道。
 *
 * ⚠️ 调用时机很要紧：**必须在画面真的更新之后**再抓。详见 Snapshot.thumb 的注释。
 */
export function makeThumbnail(source: Sizable, maxSide = THUMB_MAX_SIDE): string {
  const { width, height } = fitWithin(source.width, source.height, maxSide)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
  if (!ctx) throw new Error('拿不到 2D 上下文，做不了缩略图')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.7)
}
