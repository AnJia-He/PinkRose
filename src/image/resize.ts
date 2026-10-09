import { makeCanvas } from '../core/canvas'

/**
 * 把位图缩到指定尺寸，返回**新的**位图。
 *
 * 调用方负责 `src.close()` —— 缩完之后原来那张通常就没用了，而它占的是
 * GPU 内存（4928×6560 一张约 129 MB），不还回去攒几张就能把标签页拖垮。
 * 这里不替调用方关：万一它还要用（比如"回到原图"），关掉就成了悬空引用。
 *
 * 和 decode.ts 的 `toSrgbBitmap` 一样走 2D 画布的 drawImage。显式指定 srgb
 * 是为了两边行为一致：源图在 decode 那一步已经转成 sRGB 了，这里再做一次
 * 恒等变换，不会转两次。
 *
 * `imageSmoothingQuality: 'high'` 不是可有可无的：默认档缩出来的图边缘会有
 * 明显的锯齿，而这一步恰恰是用户那张照片唯一一次画质损失，得给最好的。
 */
export async function resizeBitmap(
  src: ImageBitmap, width: number, height: number,
): Promise<ImageBitmap> {
  const { canvas, ctx } = makeCanvas(width, height, '没法缩放照片')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, width, height)
  return createImageBitmap(canvas)
}
