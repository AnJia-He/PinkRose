import {
  luminanceRangeMaskPixels, type LuminanceRangeOptions,
} from '../core/luminanceRange'
import { prepareColorSource, upscaleMask, type ColorSource } from './colorRange'

/**
 * 明暗范围蒙版的画布胶水：和色彩范围共用一张最长边 1280 的像素缓存，
 * 在小图上算完后做双线性放大，调节滑杆时不需要反复读原图。
 */
export function prepareLuminanceSource(
  source: ImageBitmap, maxSide = 1280,
): ColorSource {
  return prepareColorSource(source, maxSide)
}

export function maskFromLuminanceSource(
  src: ColorSource, opts: LuminanceRangeOptions, width: number, height: number,
): Uint8Array {
  const small = luminanceRangeMaskPixels(src.data, src.width, src.height, opts)
  return upscaleMask(small, src, width, height)
}
