import { describe, it, expect } from 'vitest'
import { sessionTitle, sessionMatchesQuery, type SessionMeta } from './sessions.ts'

const at = (s: string): number => new Date(s).getTime()
const NOW = at('2026-09-25T20:00:00')

const S = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 1,
  title: null,
  originalName: '古镇.jpg',
  createdAt: 0,
  updatedAt: 0,
  hasThumb: true,
  stepCount: 1,
  ...over,
})

describe('sessionTitle', () => {
  it('起的名字优先；没起名退回照片的文件名（去扩展名）；两样都没有才说「还没说话」', () => {
    expect(sessionTitle(S({ title: '海边那张' }))).toBe('海边那张')
    expect(sessionTitle(S())).toBe('古镇')
    expect(sessionTitle(S({ originalName: null }))).toBe('还没说话')
    // 空串 / 全是空格 = 还没起名 —— 改名那里"清空提交"就是这个意思（回退一级）
    expect(sessionTitle(S({ title: '   ' }))).toBe('古镇')
  })
})

describe('sessionMatchesQuery', () => {
  it('名字里带那几个字就中（用户起的名字和照片文件名都算）', () => {
    expect(sessionMatchesQuery(S({ originalName: '海边日落.jpg' }), '海边', NOW)).toBe(true)
    expect(sessionMatchesQuery(S({ title: '海边那张' }), '海边', NOW)).toBe(true)
  })

  it('★ 日期住在**分组标题**上 —— 搜「9月25」中那一天', () => {
    // 作品页的日期住在**名字**里（没起名时名字就是「9月25日 14:30」），
    // 会话的日期住在**分组标题**上（「9月25日 · 3 条」）。两页承诺一样
    // （都能按日期搜），取那几个字的地方不一样 —— 都是屏幕上真有的字。
    const x = S({ updatedAt: at('2026-09-25T14:30:00') })
    expect(sessionMatchesQuery(x, '9月25', NOW)).toBe(true)
    expect(sessionMatchesQuery(x, '9月24', NOW)).toBe(false)
  })

  it('★ 改过名之后，原来的照片文件名搜不到了 —— 屏幕上已经没有那几个字了', () => {
    // 和作品页 `matchesQuery` 是同一条规矩（works.test.ts 里那条的镜像）：
    // 只认**显示出来的那个名字**，不认"这一条以前叫什么"。
    const x = S({ title: '海边那张', originalName: '古镇.jpg' })
    expect(sessionMatchesQuery(x, '海边', NOW)).toBe(true)
    expect(sessionMatchesQuery(x, '古镇', NOW)).toBe(false)
  })

  it('不分大小写；空查询 = 全都要（清空搜索框就是把名单还回来）', () => {
    const x = S({ originalName: 'IMG_1234.jpg' })
    expect(sessionMatchesQuery(x, 'img_1234', NOW)).toBe(true)
    expect(sessionMatchesQuery(x, 'IMG', NOW)).toBe(true)
    expect(sessionMatchesQuery(x, '', NOW)).toBe(true)
    expect(sessionMatchesQuery(x, '   ', NOW)).toBe(true)
  })
})
