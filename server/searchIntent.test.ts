import { describe, expect, it } from 'vitest'
import { parsePublicSearchQuery, parseSearchIntent } from './searchIntent.ts'

describe('搜索意图解析', () => {
  it('只接受合法的简短 query，并清理空白', () => {
    expect(parseSearchIntent(JSON.stringify({
      web_search: { query: '  Sony   A7 IV 发布时间 ' },
    }))).toEqual({ query: 'Sony A7 IV 发布时间' })
  })

  it('纯修图、坏形状或空 query 都不会触发搜索', () => {
    expect(parseSearchIntent(JSON.stringify({ web_search: null }))).toBeNull()
    expect(parseSearchIntent(JSON.stringify({ web_search: 'Sony' }))).toBeNull()
    expect(parseSearchIntent(JSON.stringify({ web_search: { query: ' ' } }))).toBeNull()
    expect(parseSearchIntent('不是 JSON')).toBeNull()
  })
})

describe('高置信公开事实问题', () => {
  it('独立、匿名、明确依赖近期信息的问题可以先行搜索', () => {
    expect(parsePublicSearchQuery('Sony A7 IV 的价格是多少？'))
      .toBe('Sony A7 IV')
    expect(parsePublicSearchQuery('iPhone 17 Pro 的最新规格是什么？'))
      .toBe('iPhone 17 Pro')
    expect(parsePublicSearchQuery(
      '截至 2026 年 11 月，最近发布的 Sony E 卡口相机型号是什么？',
    )).toBeNull()
    expect(parsePublicSearchQuery('Sony A7 IV 是哪一年发布的？')).toBeNull()
  })

  it('带照片、人物关系、账号或私人上下文的请求仍交给模型判断', () => {
    expect(parsePublicSearchQuery('这张照片的相机是哪一年发布的？')).toBeNull()
    expect(parsePublicSearchQuery('参考我朋友那台 Sony A7 IV 的色彩调一下')).toBeNull()
    expect(parsePublicSearchQuery('我的账号最近有什么价格变化？')).toBeNull()
    expect(parsePublicSearchQuery('把这张照片调暖一点')).toBeNull()
    expect(parsePublicSearchQuery('这个最近怎么样？')).toBeNull()
  })
})
