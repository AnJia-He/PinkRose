import { makeCanvas } from '../core/canvas'
import type { FaceBox } from '../core/faceDetect'
import { detectBlemishes } from '../core/blemish'
import { faceMask } from './faceMask'
import { spotHeal } from './heal'

/**
 * 自动去斑的像素落地。
 *
 * 检测在 `core/blemish`，这里只负责：取像素 → 逐个小斑点做局部修补 →
 * 写回底图。逐点裁小区域再 heal，而不是把整张脸的斑点塞进同一张掩码：
 * `spotHeal` 的 donor 环是按掩码外接框找的，斑点散布时外接框会大到
 * 失去意义。小区域也让耗时跟斑点数量成正比，而不是跟整张照片成正比。
 */
export type BlemishToBitmapResult = {
  bitmap: ImageBitmap
  /** 检出的斑点个数。0 = 没有可处理的候选。 */
  spots: number
  /** 真正参与修补的像素数。 */
  healed: number
  /** 有没有至少一处找到 donor 补丁。 */
  usedSource: boolean
}

export async function blemishToBitmap(
  source: ImageBitmap,
  face: FaceBox,
  opts: { strength?: number } = {},
): Promise<BlemishToBitmapResult> {
  const w = source.width
  const h = source.height
  const { canvas, ctx } = makeCanvas(w, h, '去不了斑', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, w, h)
  const coverage = faceMask(w, h, face)
  const found = detectBlemishes(image.data, w, h, face, coverage, opts)
  if (found.spots.length === 0) {
    return {
      bitmap: await createImageBitmap(canvas),
      spots: 0, healed: 0, usedSource: false,
    }
  }

  const processed = new Uint8Array(w * h)
  let healed = 0
  let usedSource = false
  for (const spot of found.spots) {
    const pad = Math.max(8, Math.round(Math.max(spot.x1 - spot.x0, spot.y1 - spot.y0) * 0.9))
    const x0 = Math.max(0, spot.x0 - pad)
    const y0 = Math.max(0, spot.y0 - pad)
    const x1 = Math.min(w, spot.x1 + pad)
    const y1 = Math.min(h, spot.y1 + pad)
    const lw = x1 - x0
    const lh = y1 - y0
    if (lw <= 0 || lh <= 0) continue

    const localData = new Uint8ClampedArray(lw * lh * 4)
    const localMask = new Uint8Array(lw * lh)
    let covered = 0
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const gi = (y0 + y) * w + x0 + x
        const li = y * lw + x
        const cov = found.mask[gi]!
        const src = gi * 4
        const dst = li * 4
        localData[dst] = image.data[src]!
        localData[dst + 1] = image.data[src + 1]!
        localData[dst + 2] = image.data[src + 2]!
        localData[dst + 3] = image.data[src + 3]!
        if (cov > 0 && !processed[gi]) {
          localMask[li] = cov
          covered++
        }
      }
    }
    if (covered === 0) continue

    const result = spotHeal(localData, lw, lh, localMask, { opacity: 0.92 })
    usedSource ||= result.usedSource
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const li = y * lw + x
        if (!localMask[li]) continue
        const gi = (y0 + y) * w + x0 + x
        const src = li * 4
        const dst = gi * 4
        image.data[dst] = localData[src]!
        image.data[dst + 1] = localData[src + 1]!
        image.data[dst + 2] = localData[src + 2]!
        image.data[dst + 3] = localData[src + 3]!
        processed[gi] = 1
      }
    }
    healed += result.healed
  }

  ctx.putImageData(image, 0, 0)
  return {
    bitmap: await createImageBitmap(canvas),
    spots: found.spots.length, healed, usedSource,
  }
}
