import { makeCanvas } from '../core/canvas'
import { estimateSubjectMask } from '../core/subjectSelect'
import { subjectBoundsFromCoverage, type SubjectBounds } from '../core/smartCrop'

/** 和智能主体同一档工作分辨率：足够估位置，又不把主线程拖住。 */
const WORK_MAX_SIDE = 640

/**
 * 读一次底图，在低分辨率工作图上估主体外接框。
 *
 * 返回的是**原图归一化坐标**，所以无论工作图缩到多大，裁剪层都能直接使用。
 * 主体太小 / 几乎铺满整张图时返回 null —— 这两种情况下“智能构图”没有
 * 可信的移动方向，应该让用户继续手动拖框。
 */
export async function detectSubjectBox(source: ImageBitmap): Promise<SubjectBounds | null> {
  const w = source.width
  const h = source.height
  const scale = Math.min(1, WORK_MAX_SIDE / Math.max(1, Math.max(w, h)))
  const sw = Math.max(1, Math.round(w * scale))
  const sh = Math.max(1, Math.round(h * scale))
  const { ctx } = makeCanvas(sw, sh, '识别不了主体', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, sw, sh)
  const image = ctx.getImageData(0, 0, sw, sh)
  const result = estimateSubjectMask(image.data, sw, sh)

  // estimateSubjectMask 的 mask 是“背景要去掉”的覆盖率；这里翻成主体覆盖率。
  const foreground = new Uint8Array(result.mask.length)
  for (let i = 0; i < foreground.length; i++) foreground[i] = 255 - result.mask[i]!
  const box = subjectBoundsFromCoverage(foreground, sw, sh)
  if (!box || box.ratio < 0.002 || box.ratio > 0.92) return null
  return box
}
