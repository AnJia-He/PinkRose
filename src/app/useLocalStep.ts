import { cutAfter, pushSnapshot, type Snapshot } from '../core/history'
import type { Adjustments } from '../../shared/adjustments.ts'
import type { LutRef } from '../../shared/lut.ts'
import type { DecodedImage } from '../image/decode'

/**
 * **本地新步骤**（★ 2026-10-06）：裁剪、擦除都从这儿走。
 *
 * 它和"生成回来"那条路（`useGeneration` 里那一段）**是同一件事**，只是没有
 * 网络那一半：切未来 → 推快照 → 换底图 → 挪光标 → 说一句话。
 * ⚠️ 切未来用的是**已有的 `cutAfter`**（生成那条用的就是它），别另写一份。
 *
 * ⚠️ **`prompt` 不许写**（连空串都不许）：没写 = 这一步没有可重跑的指令 →
 *    「再来一版」不会出现在一颗按不动的按钮上。
 * ⚠️ `params` / `lut` **原样带过去** —— 这是"用户调好的滑块不许丢"那条契约。
 *
 * ⚠️ 写成**纯函数**（不挂 React）是有意的：jsdom 里能直接喂数据、问结果，
 *    不用把整棵 App 挂起来才能验这三条契约。
 */
export function localStep(prev: readonly Snapshot[], opts: {
  id: number
  label: string            // '裁剪' / '擦除'
  base: DecodedImage       // 新的底图（几何/像素改好的那一张）
  params: Adjustments
  lut: LutRef | null
  cursorId: number         // 此刻站在哪一步（>它的一律切掉，和生成那条一样）
}): Snapshot[] {
  return pushSnapshot(cutAfter(prev, opts.cursorId), {
    id: opts.id, label: opts.label, base: opts.base,
    params: opts.params, lut: opts.lut, isOriginal: false, thumb: '',
    // 账本（2026-10-08）：新版本出生 = 只有当前位置一笔。
    // ⚠️ 本函数 Task 3 才退役（裁剪/点修改走记账）—— 这里先让它编译过，
    //    形状对，只是暂时还没人往账本里记账。
    past: [], future: [],
  })
}
