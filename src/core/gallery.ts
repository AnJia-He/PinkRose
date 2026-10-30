import type { DayGroup, DayGroupable } from '../../shared/works.ts'

/** 连拍折叠的边界。`createdAt` 是作品第一次存下的时间，不能用最后编辑时间。 */
export const BURST_STACK_MIN = 5
export const BURST_STACK_MAX_GAP_MS = 1_500
export const BURST_STACK_MAX_SPAN_MS = 20_000

export type BurstWork = DayGroupable & {
  id: number
  createdAt: number
  capturedAt?: number | null
  rating?: number
  flag?: number
}

export type GalleryEntry<T extends BurstWork> =
  | { kind: 'work'; work: T }
  | { kind: 'stack'; key: string; works: T[]; cover: T }

export type BurstStackOptions = {
  minSize?: number
  maxGapMs?: number
  maxSpanMs?: number
}

/**
 * 把一组时间相邻的作品折成连拍堆栈。
 *
 * 只决定“怎么浏览”，不改作品本身：筛选、评分、多选和详情页仍拿原始 `WorkMeta`。
 * 相邻作品超过 `maxGapMs`，或整段超过 `maxSpanMs` 就另起一组；不足 `minSize`
 * 的组原样展开。输出按最近编辑时间排，和作品页现有顺序一致。
 */
export function stackBursts<T extends BurstWork>(
  works: readonly T[],
  options: BurstStackOptions = {},
): GalleryEntry<T>[] {
  const minSize = Math.max(2, Math.round(options.minSize ?? BURST_STACK_MIN))
  const maxGapMs = Math.max(0, options.maxGapMs ?? BURST_STACK_MAX_GAP_MS)
  const maxSpanMs = Math.max(0, options.maxSpanMs ?? BURST_STACK_MAX_SPAN_MS)
  const originalOrder = new Map(works.map((work, index) => [work.id, index]))
  const sourceIndex = (work: T): number => originalOrder.get(work.id) ?? Number.MAX_SAFE_INTEGER
  const shotAt = (work: T): number => (
    typeof work.capturedAt === 'number' && work.capturedAt > 0
      ? work.capturedAt
      : work.createdAt
  )
  const chronological = [...works].sort((a, b) => (
    shotAt(b) - shotAt(a) || sourceIndex(a) - sourceIndex(b)
  ))

  const clusters: T[][] = []
  for (const work of chronological) {
    const current = clusters[clusters.length - 1]
    const first = current?.[0]
    const previous = current?.[current.length - 1]
    const adjacent = previous ? shotAt(previous) - shotAt(work) : Infinity
    const span = first ? shotAt(first) - shotAt(work) : Infinity
    if (!current || adjacent > maxGapMs || span > maxSpanMs) {
      clusters.push([work])
    } else {
      current.push(work)
    }
  }

  const entries = clusters.flatMap<GalleryEntry<T>>(cluster => {
    if (cluster.length < minSize) {
      return [...cluster]
        .sort((a, b) => sourceIndex(a) - sourceIndex(b))
        .map(work => ({ kind: 'work', work }))
    }
    const ordered = [...cluster].sort((a, b) => (
      shotAt(b) - shotAt(a) || sourceIndex(a) - sourceIndex(b)
    ))
    const ids = cluster.map(work => work.id)
    const cover = [...ordered].sort((a, b) => (
      (b.rating ?? 0) - (a.rating ?? 0)
      || (b.flag ?? 0) - (a.flag ?? 0)
      || b.updatedAt - a.updatedAt
      || b.id - a.id
    ))[0]!
    return [{
      kind: 'stack',
      key: `stack:${Math.min(...ids)}:${Math.max(...ids)}:${ids.length}`,
      works: ordered,
      cover,
    }]
  })

  const displayAt = (entry: GalleryEntry<T>): number => (
    entry.kind === 'work'
      ? entry.work.updatedAt
      : Math.max(...entry.works.map(work => work.updatedAt))
  )
  const entryOrder = (entry: GalleryEntry<T>): number => (
    entry.kind === 'work'
      ? sourceIndex(entry.work)
      : Math.min(...entry.works.map(sourceIndex))
  )
  return entries.sort((a, b) => (
    displayAt(b) - displayAt(a) || entryOrder(a) - entryOrder(b)
  ))
}

/**
 * 先摆几天的 —— 也就是"先摆 60 张"的那 60（§3.5）。
 *
 * ⚠️ **按天取整，不在一天中间截断。** 截断的话那天的标题会写着「9月25日 · 200 张」
 * 而下面只有 60 张 —— 用户会以为丢了 140 张。
 * §3.5 说的「分组不只是为了好看，它同时是分页的边界」就是这个意思。
 *
 * ★ 泛型（Task 6）：作品页和对话列表**共用这一份** —— 分页的边界规则要是分成
 * 两份，两页迟早会在"一天摆一半"这种事上漂开。
 */
export function visibleGroups<T extends DayGroupable>(
  groups: readonly DayGroup<T>[], limit: number,
): DayGroup<T>[] {
  const out: DayGroup<T>[] = []
  let n = 0
  for (const g of groups) {
    // **先摆后判**（不是先判后摆）：limit 是 0 甚至负数时，也至少摆一组 —— 这是刻意的。
    // limit 只由调用方从 60 起往上加，0 不该出现；真要出现了，摆一组比摆零组更接近
    // 用户的意思。（这条行为在 gallery.test.ts 里钉着 —— 挪 `break` 会红。）
    out.push(g)
    n += g.works.length
    if (n >= limit) break
  }
  return out
}
