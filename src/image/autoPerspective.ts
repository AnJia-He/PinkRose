import { fitWithin } from '../../shared/size.ts'
import { makeCanvas } from '../core/canvas'
import { detectVerticalPerspective } from '../core/autoPerspective'
import type { PerspectiveQuad } from '../core/perspective'

/**
 * 自动透视的像素入口：缩到长边 480 后交给纯算法。使用底图 bitmap，
 * 不读当前调色 / 滤镜后的画布，避免风格参数影响几何判断。
 */
export const AUTO_PERSPECTIVE_SAMPLE_SIDE = 480

export function detectAutoPerspective(source: ImageBitmap): PerspectiveQuad | null {
  const { width, height } = fitWithin(
    source.width, source.height, AUTO_PERSPECTIVE_SAMPLE_SIDE,
  )
  const { canvas, ctx } = makeCanvas(width, height, '找不了透视线', {
    willReadFrequently: true,
  })
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return detectVerticalPerspective(data, canvas.width, canvas.height)
}
