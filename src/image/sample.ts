import { fitWithin } from '../../shared/size.ts'
import { makeCanvas } from '../core/canvas'
import type { Rgb } from '../core/colorMatch'
import type { Sizable } from './prepare'

/**
 * 采样图的边长上限。
 *
 * 96 是"够用就行"：拟合那边最多只看 400 个点（见 `core/colorMatch.ts` 的
 * `MAX_FIT_SAMPLES`），而 96 的长边对一张 3:2 的照片就是 96×64 ≈ 6100 个像素
 * —— 远远超过 400，再多也只是让这一趟多画几十毫秒。
 *
 * ⚠️ 这里量的是**整张图的色彩分布**，不是细节，所以缩小本身不丢信息：
 * 均值/标准差在缩图前后几乎一样，而缩图反而顺手把噪点平均掉了。
 */
export const SAMPLE_MAX_SIDE = 96

/**
 * canvas 的 RGBA 字节 → 采样数组。
 *
 * 纯函数，单独拎出来是因为**它是这条链上唯一会静默算错的地方**：
 * 四个字节一个像素，步长写成 3 就是 RGB 错位，画面看着还是"一张图"，
 * 但每个像素的颜色都会串到隔壁去，拟合出来的参数会莫名其妙地偏。
 */
export function rgbaToSamples(data: Uint8ClampedArray | Uint8Array): Rgb[] {
  const out: Rgb[] = []
  for (let i = 0; i + 2 < data.length; i += 4) {
    out.push([data[i], data[i + 1], data[i + 2]])
  }
  return out
}

/**
 * 把一张图缩成小图，取回它的像素。
 *
 * 画布那半和 `core/thumbnail.ts` 的 `makeThumbnail` 是同一个套路，
 * 唯一要紧的差别是**这里必须读像素**，所以多一步 `getImageData`。
 *
 * `colorSpace: 'srgb'` 不是可选项：iPhone 的原图常是 Display P3，
 * 不指定的话 `getImageData` 会把 P3 的数字原样交出来，于是同一张照片
 * 在两种设备上拟合出不同的参数（解码那一步已经在 `image/decode.ts` 里
 * 做过 P3→sRGB，这里要跟它对齐）。
 */
export function samplePixels(source: Sizable, maxSide = SAMPLE_MAX_SIDE): Rgb[] {
  const { width, height } = fitWithin(source.width, source.height, maxSide)
  const { canvas, ctx } = makeCanvas(width, height, '采不了样')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return rgbaToSamples(ctx.getImageData(0, 0, canvas.width, canvas.height).data)
}
