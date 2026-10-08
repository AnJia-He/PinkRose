import { describe, it, expect } from 'vitest'
import { qaMateOf, expandDeleteIds, type ChatLike } from './messages'

const u = (id: number): ChatLike => ({ id, role: 'user' })
const a = (id: number): ChatLike => ({ id, role: 'assistant' })

/** 一条正常的对话：欢迎、问答、问答。 */
const normal = [a(1), u(2), a(3), u(4), a(5)]

/**
 * ★ 用户 2026-10-08 报的那条会话（本机 `data/ruixing.db` 里 session 279 的形状）：
 * 欢迎之后，问句 2 和 6 的回复早就被删了（残了），8/9 是一问一答，
 * 12 是工具记录（点修提交追加的「擦干净了。」，前面也是助手）。
 */
const ragged = [a(1), u(2), u(6), u(8), a(9), u(10), a(11), a(12)]

describe('qaMateOf', () => {
  it('助手那条的搭子 = 紧挨着的前一条用户话', () => {
    expect(qaMateOf(normal, 3)).toBe(2)
    expect(qaMateOf(normal, 5)).toBe(4)
  })

  it('用户那条的搭子 = 紧挨着的后一条助手话', () => {
    expect(qaMateOf(normal, 2)).toBe(3)
    expect(qaMateOf(normal, 4)).toBe(5)
  })

  it('两条消息在一起就是一对 —— 从哪边问都指回对方', () => {
    expect(qaMateOf(normal, 5)).toBe(4)
    expect(qaMateOf(normal, 4)).toBe(5)
  })

  it('前面还是助手（工具记录那种「擦干净了。」）→ 没有搭子', () => {
    expect(qaMateOf(ragged, 12)).toBeNull()
  })

  it('后面还是用户（连着问了两句）→ 没有搭子', () => {
    expect(qaMateOf(ragged, 2)).toBeNull()   // 它的回答早被删了，后面是下一句问话
    expect(qaMateOf(ragged, 6)).toBeNull()
  })

  it('第一条（欢迎语自己）前面没人 → 没有搭子', () => {
    expect(qaMateOf(normal, 1)).toBeNull()
  })

  it('列表最后一条用户话、后面没人 → 没有搭子', () => {
    expect(qaMateOf([a(1), u(2)], 2)).toBeNull()
  })

  it('id 不在列表里 → null', () => {
    expect(qaMateOf(normal, 99)).toBeNull()
  })
})

describe('expandDeleteIds', () => {
  it('删回复 → 问句一起走', () => {
    expect(expandDeleteIds(normal, [3])).toEqual([3, 2])
  })

  it('删问句 → 回复一起走', () => {
    expect(expandDeleteIds(normal, [2])).toEqual([2, 3])
  })

  it('一段对话里两条都点了 → 不重复', () => {
    expect(expandDeleteIds(normal, [2, 3])).toEqual([2, 3])
  })

  it('好几段一起删 → 各自带上各自的搭子', () => {
    expect(expandDeleteIds(normal, [2, 5])).toEqual([2, 5, 3, 4])
  })

  it('工具记录（没有搭子）→ 只删自己', () => {
    expect(expandDeleteIds(ragged, [12])).toEqual([12])
  })

  it('没回答的问句（残数据）→ 只删自己，不误伤旁边的完整一问', () => {
    expect(expandDeleteIds(ragged, [2])).toEqual([2])
    expect(expandDeleteIds(ragged, [6])).toEqual([6])
    // 完整的那一对照旧成对
    expect(expandDeleteIds(ragged, [9])).toEqual([9, 8])
  })

  it('id 不存在 → 原样留着（账本认的是 id，别在这里吞掉）', () => {
    expect(expandDeleteIds(normal, [99])).toEqual([99])
  })

  it('空数组进、空数组出', () => {
    expect(expandDeleteIds(normal, [])).toEqual([])
  })

  it('不修改入参', () => {
    const ids = [3]
    expandDeleteIds(normal, ids)
    expect(ids).toEqual([3])
  })
})
