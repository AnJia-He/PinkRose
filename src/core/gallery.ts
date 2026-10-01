import type { DayGroup, DayGroupable } from '../../shared/works.ts'

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
