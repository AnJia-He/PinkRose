import { useMemo, useState, type MutableRefObject } from 'react'
import { groupByDay, type DayGroup, type DayGroupable } from '../../../shared/works.ts'
import { visibleGroups } from '../../core/gallery'
import { useLoadMoreSentinel } from './loadMore.ts'

/** 一次摆多少（§3.5：「先摆 60 张，够铺满一屏多一点」）—— 作品页和对话列表同一个数。 */
export const PAGE = 60

/**
 * 「按天分组的列表 + 滚到底接下一段」—— 作品页和对话列表**同一套**。
 *
 * ★ 2026-10-09 收口：原来两页各写了一遍（`SessionsPage` 的文件头自己写着
 *   "分组和分页**复用作品页那一套**：复制一份出来的话，同一天会在两页里
 *   显示成两个名字"）。`groupByDay` / `visibleGroups` 本来就是共用的，
 *   这里把**剩下的胶水**也收成一份：分页常量、"现在"只取一次、三行 memo、
 *   哨兵、以及"搜索一变就把分页收回第一段"。
 *
 * ⚠️ `match` 必须是**模块级函数**（身份稳定）—— 现包一个箭头函数进去的话，
 *   分组那份 memo 每渲染都要重算（列表几十上百条时是白烧）。
 * ⚠️ "现在"**只取一次**：显示名要判断"是不是今年"，一次会话里不会跨年。
 */
export function usePagedDays<T extends DayGroupable>(
  list: readonly T[] | null, q: string,
  match: (x: T, q: string, now: number) => boolean,
  timeOf?: (work: T) => number,
): {
  now: number
  groups: DayGroup<T>[]
  shown: DayGroup<T>[]
  more: boolean
  sentinel: MutableRefObject<HTMLDivElement | null>
  /** 搜索一变就调它 —— 把分页收回第一段（不然换了词还停在第 N 段）。 */
  resetLimit: () => void
} {
  const [limit, setLimit] = useState(PAGE)
  const now = useMemo(() => Date.now(), [])
  const groups = useMemo(
    () => (list ? groupByDay(list.filter(x => match(x, q, now)), now, timeOf) : []),
    [list, q, now, match, timeOf])
  const shown = useMemo(() => visibleGroups(groups, limit), [groups, limit])
  const more = shown.length < groups.length
  const sentinel = useLoadMoreSentinel(more, PAGE, setLimit)
  return { now, groups, shown, more, sentinel, resetLimit: () => setLimit(PAGE) }
}
