import { makeCanvas } from '../core/canvas'
import { resampleCoverage } from '../core/subjectSelect'
import { skyMaskPixels } from '../core/skyMask'

/** 在长边 ≤ 640 的工作图上估天空，再把软边蒙版放大回原图。 */
export async function selectSkyToMask(
  source: ImageBitmap, mask: Uint8Array,
): Promise<{ covered: number; ratio: number }> {
  const w = source.width
  const h = source.height
  if (mask.length !== w * h) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${mask.length} 字节，照片 ${w}×${h}）`)
  }
  const scale = Math.min(1, 640 / Math.max(1, Math.max(w, h)))
  const sw = Math.max(1, Math.round(w * scale))
  const sh = Math.max(1, Math.round(h * scale))
  const { ctx } = makeCanvas(sw, sh, '认不出天空', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, sw, sh)
  const result = skyMaskPixels(ctx.getImageData(0, 0, sw, sh).data, sw, sh)
  const full = sw === w && sh === h
    ? result.mask
    : resampleCoverage(result.mask, sw, sh, w, h)
  mask.set(full)
  let covered = 0
  for (let i = 0; i < full.length; i++) if (full[i]! > 0) covered++
  return { covered, ratio: covered / Math.max(1, w * h) }
}
