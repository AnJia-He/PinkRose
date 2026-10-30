import { describe, it, expect } from 'vitest'
import {
  cameraName, workName, workNameAt, matchesQuery, groupByDay, type WorkMeta,
} from './works.ts'

const at = (s: string): number => new Date(s).getTime()
const NOW = at('2026-09-25T20:00:00')

const w = (over: Partial<WorkMeta> = {}): WorkMeta => ({
  id: 1,
  alias: null,
  createdAt: at('2026-09-25T14:30:00'),
  updatedAt: at('2026-09-25T14:30:00'),
  bytes: 100,
  hasThumb: true, flag: 0,
  rating: 0,
  ...over,
})

describe('workName', () => {
  it('没起名字，就用最后改动的时间', () => {
    expect(workName(w(), NOW)).toBe('9月25日 14:30')
  })

  it('起了名字就用名字', () => {
    expect(workName(w({ alias: '海边那张' }), NOW)).toBe('海边那张')
  })

  it('不是今年的，带上年份 —— 不然去年的 9月25 和今年的分不出来', () => {
    const old = w({ updatedAt: at('2025-09-25T14:30:00') })
    expect(workName(old, NOW)).toBe('2025年9月25日 14:30')
  })

  it('★ 可以按指定拍摄时间起名，已有名字仍然优先', () => {
    const shot = at('2026-09-20T08:00:00')
    expect(workNameAt(w(), NOW, shot)).toBe('9月20日 08:00')
    expect(workNameAt(w({ alias: '日出' }), NOW, shot)).toBe('日出')
  })
})

describe('cameraName', () => {
  it('★ 机身名称去重：型号已经带厂商前缀时不再重复', () => {
    expect(cameraName(w({ cameraMake: 'SONY', cameraModel: 'ILCE-7CM2' })))
      .toBe('SONY ILCE-7CM2')
    expect(cameraName(w({ cameraMake: 'Canon', cameraModel: 'Canon EOS R5' })))
      .toBe('Canon EOS R5')
    expect(cameraName(w({ cameraMake: null, cameraModel: 'X-T5' }))).toBe('X-T5')
    expect(cameraName(w())).toBe(null)
  })
})

describe('matchesQuery', () => {
  it('★ 搜「9月25」能中 —— 没起名时这就等于按日期搜（§3.5 原话）', () => {
    expect(matchesQuery(w(), '9月25', NOW)).toBe(true)
  })

  it('搜别名能中，大小写不敏感', () => {
    const x = w({ alias: 'Beach Day' })
    expect(matchesQuery(x, 'beach', NOW)).toBe(true)
    expect(matchesQuery(x, 'BEACH', NOW)).toBe(true)
    expect(matchesQuery(x, '山里', NOW)).toBe(false)
  })

  it('空查询 = 全都算中（没搜就是不过滤）', () => {
    expect(matchesQuery(w(), '', NOW)).toBe(true)
    expect(matchesQuery(w(), '   ', NOW)).toBe(true)
  })

  it('起了名字之后，搜日期就不该中了 —— 名字已经换掉了，屏幕上没有那个日期', () => {
    // 这条是**故意的**：搜的是"屏幕上看到的字"。改了名之后屏幕上就没有日期了，
    // 再让日期能搜中，用户会看到"搜出一堆屏幕上没这几个字的图"。
    expect(matchesQuery(w({ alias: '海边那张' }), '9月25', NOW)).toBe(false)
  })

  it('★ 还能按原文件名、机身和镜头搜索', () => {
    const raw = w({
      sourceName: 'IMG_1234.JPG',
      cameraMake: 'SONY',
      cameraModel: 'ILCE-7CM2',
      lensModel: 'FE 50mm F1.4 GM',
    })
    expect(matchesQuery(raw, 'img_1234', NOW)).toBe(true)
    expect(matchesQuery(raw, 'ilce-7cm2', NOW)).toBe(true)
    expect(matchesQuery(raw, '50mm f1.4', NOW)).toBe(true)
    expect(matchesQuery(raw, 'nikon', NOW)).toBe(false)
  })
})

describe('groupByDay', () => {
  it('按天分组，新的在前；组里也是新的在前', () => {
    const works = [
      w({ id: 1, updatedAt: at('2026-09-22T10:00:00') }),
      w({ id: 2, updatedAt: at('2026-09-25T09:00:00') }),
      w({ id: 3, updatedAt: at('2026-09-25T18:00:00') }),
      w({ id: 4, updatedAt: at('2026-09-22T22:00:00') }),
    ]
    const g = groupByDay(works, NOW)
    expect(g.map((x) => x.day)).toEqual(['2026-09-25', '2026-09-22'])
    expect(g[0]!.label).toBe('9月25日')
    expect(g[0]!.works.map((x) => x.id)).toEqual([3, 2])
    expect(g[1]!.works.map((x) => x.id)).toEqual([4, 1])
  })

  it('一条都没有 → 空数组，不是 null 也不是抛', () => {
    expect(groupByDay([], NOW)).toEqual([])
  })

  it('★ 可以按拍摄时间分组：标签、排序都用同一个时间选择器', () => {
    const works = [
      w({ id: 1, updatedAt: at('2026-09-25T10:00:00'), capturedAt: at('2026-09-20T08:00:00') }),
      w({ id: 2, updatedAt: at('2026-09-24T10:00:00'), capturedAt: at('2026-09-22T09:00:00') }),
      w({ id: 3, updatedAt: at('2026-09-23T10:00:00'), capturedAt: at('2026-09-22T09:00:03') }),
    ]
    const timeOf = (work: WorkMeta) => work.capturedAt ?? work.updatedAt

    const groups = groupByDay(works, NOW, timeOf)

    expect(groups.map(group => group.label)).toEqual(['9月22日', '9月20日'])
    expect(groups[0]!.works.map(work => work.id)).toEqual([3, 2])
    expect(groups[1]!.works.map(work => work.id)).toEqual([1])
  })
})
