/**
 * 点修「擦掉这里」的**像素落点**（★ 2026-10-07）。
 *
 * 一条路走完：取出底图像素 → 掩码外扩 → 修补笔（`image/heal`）→ 产出**新底图**。
 *
 * ⚠️ 和 `image/crop.ts` 同一条硬规矩：**作用对象是 `base`**（不带参数、不带
 *    滤镜）。用户是带着调好的画面指位置的，但擦的必须是底图 —— 参数/滤镜之后
 *    由渲染管线盖上去。改成"擦渲染后的画面"就会把参数烤进像素里。
 *
 * ★ 为什么只有修补笔一条路（2026-10-07 真照片探针定的，证据在
 *   `.superpowers/scratch/retouch-probe/`）：
 *   · 修补笔**构造上无缝**（贴来的补丁要和四周解一个"膜"，边界永远接得上），
 *     100 万像素的大洞也只是"糊"，不会出现"内容搬到错地方"；
 *   · 当时一并移植的 PatchMatch 内容填充（Compositor 的 ContentFill.c）在
 *     420² 以上**会出现硬拼接缝、还会把远处的内容（嘴唇）搬到脸中间** ——
 *     8% 以上的尺寸恰好是它会接管的区间，而那里它并不比修补笔好；
 *   · 耗时上修补笔在大块时反而更快（1100×1000：4.1s vs 6.1s，同在真机上量）。
 *   将来"大物体一键消除"如果要做，走模型那条路（spec §3.2 的第二批），
 *   而不是把填充引擎接回来。
 */

import { expandMask, maskBounds } from '../core/retouch'
import { spotHeal } from './heal'

/** 擦之前把掩码外扩多少像素（理由见 `core/retouch.expandMask`）。 */
export const DEFAULT_EXPAND = 2

export type EraseReport = {
  /** 参与擦除的像素数（外扩之后的掩码非零个数）。 */
  coverage: number
  /** 有没有找到 donor 补丁（false = 走了"平滑铺开 + 回填噪点"的兜底）。 */
  usedSource: boolean
}

export async function eraseToBitmap(
  source: ImageBitmap, mask: Uint8Array, opts: { expand?: number } = {},
): Promise<{ bitmap: ImageBitmap } & EraseReport> {
  const w = source.width
  const h = source.height
  if (mask.length !== w * h) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${mask.length} 字节，照片 ${w}×${h}）`)
  }

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
  // ✋ 拿不到上下文就**说出来** —— 返回一张空图会让用户以为"擦出来就是黑的"
  if (!ctx) throw new Error('擦除时拿不到 2D 上下文（这张图画不出来）')

  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, w, h)

  const expanded = expandMask(mask, w, h, opts.expand ?? DEFAULT_EXPAND)
  const bounds = maskBounds(expanded, w, h)
  let usedSource = false
  if (bounds) {
    usedSource = spotHeal(image.data, w, h, expanded).usedSource
    ctx.putImageData(image, 0, 0)
  }

  const bitmap = await createImageBitmap(canvas)
  return { bitmap, coverage: bounds?.count ?? 0, usedSource }
}
