import { describe, it, expect } from 'vitest'
import { viewFromPath, pathOf } from './view'

describe('网址 ↔ 界面', () => {
  it('三条路径各自认得出来', () => {
    expect(viewFromPath('/')).toEqual({ kind: 'edit' })
    expect(viewFromPath('/works')).toEqual({ kind: 'gallery' })
    expect(viewFromPath('/works/12')).toEqual({ kind: 'work', id: 12 })
  })

  it('★ 认不出来的路径退回修图页 —— 不是白屏、也不是报错', () => {
    // 用户可能手打一个错地址、或者旧书签。白屏是最差的答案。
    for (const p of ['/nope', '/works/abc', '/works/12/x', '/works/']) {
      expect(viewFromPath(p).kind).not.toBe('work')
    }
    expect(viewFromPath('/nope')).toEqual({ kind: 'edit' })
  })

  it('来回一趟是原样 —— 不然前进/后退会越走越偏', () => {
    for (const v of [{ kind: 'edit' } as const, { kind: 'gallery' } as const, { kind: 'work', id: 7 } as const]) {
      expect(viewFromPath(pathOf(v))).toEqual(v)
    }
  })

  it('★ 作品详情页的网址里**没有名字**，只有 id（§3.5.1）', () => {
    expect(pathOf({ kind: 'work', id: 7 })).toBe('/works/7')
  })
})
