import type { Adjustments } from '../../shared/adjustments.ts'
import type { DecodedImage } from '../image/decode'

export type Snapshot = {
  /** 与聊天记录里那条助手消息同 id —— 「回到这一步」按钮靠它对上号。 */
  id: number
  /** 给用户看的短标签，比如"原图"。 */
  label: string
  /**
   * 走到这一步的**那句话**（用户的原话，已经过服务端补全的英文 prompt）。
   *
   * ★ 2026-09-30 加，为「再来一版」。原来只有 `label`，那条是**给我的**
   * 分类（"生成式编辑"），不是给用户的那句话 —— 靠它重跑不了。
   *
   * 缺席（undefined）表示这一步没有可重跑的指令：原图、以及将来任何
   * 不是"一句话生成出来的"步骤。**别写成空串**，两者语义不同：
   * 空串是"有指令但是空的"，那会让「再来一版」出现在一个按不动的按钮上。
   */
  prompt?: string
  base: DecodedImage
  params: Adjustments
  /** 原图。这一条永远不会被挤出去。 */
  isOriginal: boolean
  /**
   * 这一步长什么样的缩略图（data URL）。**空串 = 还没生成**。
   *
   * 为什么是字符串不是位图：位图占 GPU 内存，一步一张、最多六步，
   * 而缩略图的价值远不值那个代价。一张 data URL 约 5~10 KB，普通内存。
   *
   * 为什么会有"还没生成"这个中间态：快照是在 `setParams` / `setImage`
   * **同一个批次**里推入的，而那一刻画布还没重画（React 的状态更新是异步的）。
   * 直接抓会抓到**上一步的颜色**。所以先推空，等画面更新后由 App 补上
   * （见 src/App.tsx 里那个 effect）。
   */
  thumb: string
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
 * 给某一步补上缩略图。纯函数，不改入参。
 *
 * 找不到那个 id 时返回一份拷贝 —— 不做任何事，但也不让调用方拿到同一个引用，
 * 免得 React 以为状态变了。
 */
export function attachThumb(
  list: readonly Snapshot[], id: number, thumb: string,
): Snapshot[] {
  return list.map(s => (s.id === id ? { ...s, thumb } : s))
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
