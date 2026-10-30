import { fitWithin } from '../../shared/size.ts'
import { makeCanvas } from '../core/canvas'
import { detectHorizonAngle } from '../core/horizon'

/**
 * 自动水平的像素入口：把底图缩到长边 480，取回 RGBA，交给纯算法
 * `core/horizon`。返回 null = 没找到可信的水平线（调用方要说一句，
 * 让用户手动拖「水平矫正」）。
 *
 * 用底图 `bitmap`，不是画布：参数 / 滤镜不该影响几何判断。
 */
export const STRAIGHTEN_SAMPLE_SIDE = 480

export function detectStraighten(source: ImageBitmap): number | null {
  const { width, height } = fitWithin(
    source.width, source.height, STRAIGHTEN_SAMPLE_SIDE,
  )
  const { canvas, ctx } = makeCanvas(width, height, '找不了水平线', {
    willReadFrequently: true,
  })
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return detectHorizonAngle(data, canvas.width, canvas.height)
}
