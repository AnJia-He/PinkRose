import type { Adjustments } from '../../shared/adjustments.ts'
import type { LutRef } from '../../shared/lut.ts'
import type { DecodedImage } from '../image/decode'

/**
 * 账本上的一笔 = 一个可以退回去的画面状态。
 * ⚠️ `base` 是**干净底图**（参数/滤镜不烘焙进去，09-21 spec §3.4 铁律）；
 *   调色类的笔记 `base` 与相邻笔**共享同一个对象**（零内存），只有裁剪/点修
 *   的笔才持有新位图。
 */
export type EditState = {
  base: DecodedImage
  params: Adjustments
  lut: LutRef | null
  /** 入账序号（全局单调，App 的发号器给）：预算驱逐按它排队。 */
  seq: number
}
