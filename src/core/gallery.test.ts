import { describe, it, expect } from 'vitest'
import { visibleGroups } from './gallery'
import type { DayGroup, WorkMeta } from '../../shared/works.ts'

const w = (id: number): WorkMeta =>
  ({ id, alias: null, createdAt: 0, updatedAt: 0, bytes: 0, hasThumb: true })
const g = (day: string, n: number): DayGroup =>
  ({ day, label: day, works: Array.from({ length: n }, (_, i) => w(i)) })

describe('visibleGroups', () => {
  it('摆够 limit 就停 —— 不在一天中间截断', () => {
    // 30 + 30 + 30，limit 60：前两组正好 60，第三组整个不摆
    expect(visibleGroups([g('a', 30), g('b', 30), g('c', 30)], 60).map(x => x.day)).toEqual(['a', 'b'])
  })

  it('★ 一天就超过上限时，**整天都得摆出来** —— 不然标题上的张数是假的', () => {
    // "9月25日 · 200 张" 而下面只有 60 张，用户会以为丢了 140 张
    expect(visibleGroups([g('a', 200), g('b', 5)], 60).map(x => x.day)).toEqual(['a'])
    expect(visibleGroups([g('a', 200)], 60)[0]!.works.length).toBe(200)
  })

  it('不够 limit 就全摆；空的还是空', () => {
    expect(visibleGroups([g('a', 3)], 60)).toHaveLength(1)
    expect(visibleGroups([], 60)).toEqual([])
  })

  it('★ limit 是 0 也至少摆一组 —— "先摆后判"是刻意的（别把 break 挪到 push 前面）', () => {
    // limit 只由调用方从 60 起往上加，0 不该出现；真要出现了，摆一组比摆零组
    // 更接近用户的意思。给这一条配的变异：把 `if (n >= limit) break` 挪到
    // `out.push(g)` 前面 —— 会红的就是它。
    expect(visibleGroups([g('a', 3), g('b', 3)], 0).map(x => x.day)).toEqual(['a'])
  })
})
