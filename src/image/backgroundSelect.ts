import { makeCanvas } from '../core/canvas'
import {
  selectBackgroundMask, type BackgroundPickResult,
} from '../core/backgroundSelect'
import { estimateSubjectMask, resampleCoverage } from '../core/subjectSelect'

/**
 * 从底图读一次像素，把一键选背景的结果写进现成掩码。
 * 坐标是归一化坐标（和画布点选一致）。
 */
export async function selectBackgroundToMask(
  source: ImageBitmap, mask: Uint8Array, nx: number, ny: number, tolerance: number,
): Promise<BackgroundPickResult> {
  const w = source.width
  const h = source.height
  if (mask.length !== w * h) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${mask.length} 字节，照片 ${w}×${h}）`)
  }
  const { canvas, ctx } = makeCanvas(w, h, '选不了背景', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const result = selectBackgroundMask(
    image.data, w, h,
    Math.max(0, Math.min(1, nx)) * (w - 1),
    Math.max(0, Math.min(1, ny)) * (h - 1),
    tolerance,
  )
  mask.set(result.mask)
  return result
}

export type SubjectSelectionResult = {
  subjectRatio: number
  threshold: number
  covered: number
}

/**
 * 智能主体：在长边 ≤ 640 的工作副本上估前景，再把软边掩码放大回原图。
 * 640 是质量与主线程耗时的折中；比它更小的照片保持原尺寸。
 */
export async function selectSubjectToMask(
  source: ImageBitmap, mask: Uint8Array,
): Promise<SubjectSelectionResult> {
  const w = source.width
  const h = source.height
  if (mask.length !== w * h) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${mask.length} 字节，照片 ${w}×${h}）`)
  }
  const scale = Math.min(1, 640 / Math.max(1, Math.max(w, h)))
  const sw = Math.max(1, Math.round(w * scale))
  const sh = Math.max(1, Math.round(h * scale))
  const { ctx } = makeCanvas(sw, sh, '认不出主体', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, sw, sh)
  const image = ctx.getImageData(0, 0, sw, sh)
  const result = estimateSubjectMask(image.data, sw, sh)
  const full = sw === w && sh === h
    ? result.mask
    : resampleCoverage(result.mask, sw, sh, w, h)
  mask.set(full)
  let covered = 0
  for (let i = 0; i < full.length; i++) if (full[i]! > 0) covered++
  return { subjectRatio: result.subjectRatio, threshold: result.threshold, covered }
}
