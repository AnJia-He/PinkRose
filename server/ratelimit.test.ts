import { describe, it, expect } from 'vitest'
import { createLimiter } from './ratelimit.ts'

/**
 * ★ 2026-10-02 加（安全审计 H2 / S3）。
 *
 * 起因：`/api/login` **一个失败计数都没有** —— 无锁定、无退避、无延迟，
 * 而接口还主动回答"这个账号存不存在"。注册接口也不限量。
 * 于是任何人可以拿字典慢慢试密码、或者批量注册小号去烧我们的额度。
 *
 * ⚠️ 这里**自己写而不是接 rate-limiter-flexible**：这个服务是单进程、状态在
 *    内存里就够（多进程/多机才需要共享存储）。等哪天真要横向扩，把那一天的
 *    实现换掉即可 —— 接口就下面这三个方法，换起来是一处。
 */
describe('createLimiter', () => {
  const at = (t: number) => () => t

  it('额度内放行，超了拒绝', () => {
    const lim = createLimiter({ max: 3, windowMs: 1000, now: at(0) })
    expect(lim.hit('a').ok).toBe(true)
    expect(lim.hit('a').ok).toBe(true)
    expect(lim.hit('a').ok).toBe(true)
    const fourth = lim.hit('a')
    expect(fourth.ok).toBe(false)
    if (!fourth.ok) expect(fourth.retryAfterMs).toBeGreaterThan(0)
  })

  it('不同的 key 各算各的 —— 别人被限不该连累你', () => {
    const lim = createLimiter({ max: 1, windowMs: 1000, now: at(0) })
    expect(lim.hit('a').ok).toBe(true)
    expect(lim.hit('a').ok).toBe(false)
    expect(lim.hit('b').ok).toBe(true)
  })

  it('★ 窗口会滑动 —— 时间过去之后又能用了', () => {
    let t = 0
    const lim = createLimiter({ max: 1, windowMs: 1000, now: () => t })
    expect(lim.hit('a').ok).toBe(true)
    expect(lim.hit('a').ok).toBe(false)
    t = 999
    expect(lim.hit('a').ok).toBe(false)
    t = 1000
    expect(lim.hit('a').ok).toBe(true)
  })

  it('retryAfterMs 说的是"再等多久"，不是"窗口还剩多久"', () => {
    let t = 0
    const lim = createLimiter({ max: 1, windowMs: 1000, now: () => t })
    lim.hit('a')
    t = 300
    const r = lim.hit('a')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.retryAfterMs).toBe(700)
  })

  it('reset 之后额度立刻回来（登录成功 / 改完密码用）', () => {
    const lim = createLimiter({ max: 1, windowMs: 1000, now: at(0) })
    lim.hit('a')
    expect(lim.hit('a').ok).toBe(false)
    lim.reset('a')
    expect(lim.hit('a').ok).toBe(true)
  })

  it('★ key 的数量有上限 —— 不然"每个用户名都试一次"就能把内存撑爆', () => {
    // 攻击者拿一份用户名字典轮着试，每个名字都是一个新 key。
    // 没有上限的话，限流器自己变成内存漏洞。
    const lim = createLimiter({ max: 5, windowMs: 60_000, maxKeys: 100, now: at(0) })
    for (let i = 0; i < 5000; i++) lim.hit(`user${i}`)
    expect(lim.size()).toBeLessThanOrEqual(100)
  })

  it('map 满了以后，**新 key 仍然放行**（宁可少限，不可误伤）', () => {
    // 满了就拒绝新 key 的话，"轮着试"反而能把所有正常用户一起挡在门外 ——
    // 那是拿攻击者的手段去伤用户。所以淘汰最老的、放新来的。
    const lim = createLimiter({ max: 5, windowMs: 60_000, maxKeys: 10, now: at(0) })
    for (let i = 0; i < 10; i++) lim.hit(`old${i}`)
    expect(lim.hit('newcomer').ok).toBe(true)
  })
})
