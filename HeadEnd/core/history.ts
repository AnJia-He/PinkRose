import type { Adjustments } from '../../shared/adjustments.ts'
import type { DecodedImage } from '../image/decode'

export type Snapshot = {
  /** 与聊天记录里那条助手消息同 id —— 「回到这一步」按钮靠它对上号。 */
  id: number
  /** 给用户看的短标签，比如"原图"。 */
  label: string
  base: DecodedImage
  params: Adjustments
  /** 原图。这一条永远不会被挤出去。 */
  isOriginal: boolean
}

/**
 * 最多留几步。
 *
 * 每一条生成式快照的 base 是一张 2048 长边的位图，占的是 GPU 内存；
 * 原图更贵（全分辨率）。6 步足够覆盖一次真实的修图对话。
 */
export const MAX_SNAPSHOTS = 6

/** 追加一步。超过上限时丢最老的**非原图**条目。纯函数，不改入参。 */
export function pushSnapshot(list: readonly Snapshot[], s: Snapshot): Snapshot[] {
  const out = [...list, s]
  while (out.length > MAX_SNAPSHOTS) {
    const i = out.findIndex(x => !x.isOriginal)
    if (i < 0) break          // 理论上不可能（只有一条原图），但不能死循环
    out.splice(i, 1)
  }
  return out
}

/** 回到某一步：列表截断到那一步（含）。找不到 id 时返回一份拷贝。 */
export function jumpTo(list: readonly Snapshot[], id: number): Snapshot[] {
  const i = list.findIndex(s => s.id === id)
  return i < 0 ? [...list] : list.slice(0, i + 1)
}

/**
 * 算出哪些位图可以从内存里放掉了。
 *
 * 位图占 GPU 内存，不 close 会一直攒着，几次生成就能把标签页拖垮。
 * 但**还在用的一张都不能关**——关了画布直接空白。
 */
export function bitmapsToClose(
  before: readonly Snapshot[],
  after: readonly Snapshot[],
  opts: { protectOriginal?: boolean } = {},
): DecodedImage[] {
  const keep = new Set(after.map(s => s.base))
  return before
    .filter(s => !keep.has(s.base))
    .filter(s => !(opts.protectOriginal && s.isOriginal))
    .map(s => s.base)
}
