import type { DayGroup } from '../../shared/works.ts'

/**
 * 先摆几天的 —— 也就是"先摆 60 张"的那 60（§3.5）。
 *
 * ⚠️ **按天取整，不在一天中间截断。** 截断的话那天的标题会写着「9月25日 · 200 张」
 * 而下面只有 60 张 —— 用户会以为丢了 140 张。
 * §3.5 说的「分组不只是为了好看，它同时是分页的边界」就是这个意思。
 */
export function visibleGroups(groups: readonly DayGroup[], limit: number): DayGroup[] {
  const out: DayGroup[] = []
  let n = 0
  for (const g of groups) {
    out.push(g)
    n += g.works.length
    if (n >= limit) break
  }
  return out
}
