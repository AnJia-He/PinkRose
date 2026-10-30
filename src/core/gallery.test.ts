import { describe, it, expect } from 'vitest'
import { stackBursts, visibleGroups } from './gallery'
import type { DayGroup, WorkMeta } from '../../shared/works.ts'

const w = (id: number): WorkMeta =>
  ({ id, alias: null, createdAt: 0, updatedAt: 0, bytes: 0, hasThumb: true, rating: 0, flag: 0 })
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

describe('stackBursts', () => {
  const burst = (id: number, createdAt: number, over: Partial<WorkMeta> = {}): WorkMeta =>
    ({ ...w(id), createdAt, updatedAt: createdAt, ...over })

  it('★ 5 张紧邻连拍折成一组，封面优先用已评分最高的一张', () => {
    const base = new Date('2026-10-21T08:15:00').getTime()
    const works = [
      burst(1, base, { updatedAt: base + 50 }),
      burst(2, base + 300),
      burst(3, base + 600, { rating: 4 }),
      burst(4, base + 900, { rating: 5 }),
      burst(5, base + 1_200),
    ]

    const entries = stackBursts(works)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('stack')
    if (entries[0]?.kind !== 'stack') throw new Error('expected a burst stack')
    expect(entries[0].works.map(work => work.id)).toEqual([5, 4, 3, 2, 1])
    expect(entries[0].cover.id).toBe(4)
  })

  it('4 张同时间作品不折叠 —— 普通作品页不能被随手连存打散', () => {
    const base = new Date('2026-10-21T08:15:00').getTime()
    const entries = stackBursts([
      burst(1, base),
      burst(2, base + 300),
      burst(3, base + 600),
      burst(4, base + 900),
    ])

    expect(entries.map(entry => entry.kind)).toEqual(['work', 'work', 'work', 'work'])
  })

  it('只看拍摄时间：5 张最后编辑时间相同、实际相隔一小时的作品不折叠', () => {
    const base = new Date('2026-10-21T08:15:00').getTime()
    const entries = stackBursts(Array.from({ length: 5 }, (_, i) => (
      burst(i + 1, base + i * 60 * 60_000, { updatedAt: base + 10 * 60 * 60_000 })
    )))

    expect(entries.map(entry => entry.kind)).toEqual([
      'work', 'work', 'work', 'work', 'work',
    ])
  })

  it('中间隔了 2 秒就断开：两个五张连拍不会合成十张', () => {
    const base = new Date('2026-10-21T08:15:00').getTime()
    const works = [
      ...Array.from({ length: 5 }, (_, i) => burst(i + 1, base + i * 300)),
      ...Array.from({ length: 5 }, (_, i) => burst(i + 6, base + 3_200 + i * 300)),
    ]

    const entries = stackBursts(works)

    expect(entries).toHaveLength(2)
    expect(entries.every(entry => entry.kind === 'stack')).toBe(true)
    if (entries.every(entry => entry.kind === 'stack')) {
      expect(entries.map(entry => entry.works.length)).toEqual([5, 5])
    }
  })

  it('组内保持拍摄顺序：后来编辑其中一张不会让它在连拍里跳位', () => {
    const base = new Date('2026-10-21T08:15:00').getTime()
    const works = Array.from({ length: 5 }, (_, i) => burst(
      i + 1,
      base + i * 300,
      { updatedAt: base + (5 - i) * 60_000 },
    ))

    const [entry] = stackBursts(works)

    expect(entry?.kind).toBe('stack')
    if (entry?.kind !== 'stack') throw new Error('expected a burst stack')
    expect(entry.works.map(work => work.id)).toEqual([5, 4, 3, 2, 1])
  })

  it('★ 有 EXIF 拍摄时间时按拍摄时间折叠，不再看导入时间', () => {
    const imported = new Date('2026-10-21T12:00:00').getTime()
    const captured = new Date('2026-10-20T08:15:00').getTime()
    const works = Array.from({ length: 5 }, (_, i) => burst(
      i + 1,
      imported + i * 60 * 60_000,
      { capturedAt: captured + i * 300 },
    ))

    const [entry] = stackBursts(works)

    expect(entry?.kind).toBe('stack')
  })

  it('★ EXIF 拍摄时间相隔很远时，即使同一秒导入也不折叠', () => {
    const imported = new Date('2026-10-21T12:00:00').getTime()
    const captured = new Date('2026-10-20T08:15:00').getTime()
    const works = Array.from({ length: 5 }, (_, i) => burst(
      i + 1,
      imported,
      { capturedAt: captured + i * 60_000 },
    ))

    expect(stackBursts(works).map(entry => entry.kind))
      .toEqual(['work', 'work', 'work', 'work', 'work'])
  })
})
