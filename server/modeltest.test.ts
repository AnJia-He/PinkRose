import { describe, expect, it } from 'vitest'
import { probeConnection } from './modeltest.ts'

const okFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

const INPUT = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' }

describe('probeConnection', () => {
  it('通了 → 带回模型名单', async () => {
    const r = await probeConnection(INPUT, okFetch({ data: [{ id: 'a' }, { id: 'b' }] }))
    expect(r).toEqual({ ok: true, models: ['a', 'b'] })
  })

  it('★ anthropic 形状：钥匙走 x-api-key + 版本头（不是 Bearer，2026-10-05）', async () => {
    let init: RequestInit | undefined
    const impl = (async (_u: string | URL | Request, i?: RequestInit) => {
      init = i
      return new Response(JSON.stringify({ data: [{ id: 'claude-test' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await probeConnection({ ...INPUT, anthropic: true }, impl)
    expect(r).toEqual({ ok: true, models: ['claude-test'] })
    const h = init!.headers as Record<string, string>
    expect(h['x-api-key']).toBe('sk-x')
    expect(h['anthropic-version']).toBe('2023-06-01')   // 少了它官方端点直接 400
    expect(h).not.toHaveProperty('authorization')
  })

  it('★ 401 → 「钥匙不认」，文案里带着用户最常犯的那几种', async () => {
    const r = await probeConnection(INPUT, okFetch({ error: { message: 'Forbidden' } }, 401))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('unauthorized')
    // 这条文案照 Chatbox 的抄 —— 它把新手最容易踩的四种坑一次说全，
    // 用户读完能自己去改，不必来问我们
    expect(r.message).toContain('没复制全')
    expect(r.message).toContain('空格')
    expect(r.message).toContain('余额')
  })

  it('403 也算「钥匙不认」', async () => {
    const r = await probeConnection(INPUT, okFetch({}, 403))
    expect(r.ok === false && r.reason === 'unauthorized').toBe(true)
  })

  it('★ 404 → 「这个地址上没有那个接口」，而不是「钥匙错了」', async () => {
    // 这两件事的下一步动作完全不同（一个去改地址、一个去改钥匙），
    // 混成一句话就是让用户瞎试
    const r = await probeConnection(INPUT, okFetch({}, 404))
    expect(r.ok === false && r.reason === 'no_endpoint').toBe(true)
  })

  /**
   * ★ 其余 4xx 那条兜底（2026-09-30 补：删掉 `if (res.status >= 400 && res.status < 500)`
   * 那一行，原来整套测试**一条都不红**）。
   *
   * 挑 400 来钉是有讲究的：它是这四条分支里**唯一**和别的类"长得像"的
   * （有些服务商的 400 是"模型名不对"）。归到钥匙那一类是这次刻意选的
   * （`server/modeltest.ts` 里那段注释写了理由），而且**不许挪进 `no_endpoint`**：
   * 那会让用户去改一个没错的地址。
   *
   * 变异：加一行 `if (res.status === 400) return fail('no_endpoint')` → 这条红。
   */
  it('★ 其余 4xx（400）→ 归到「钥匙不认」那一类，不是 no_endpoint', async () => {
    const r = await probeConnection(INPUT, okFetch({}, 400))
    expect(r.ok === false && r.reason === 'unauthorized').toBe(true)
    if (r.ok) return
    // 文案得是钥匙那一句 —— 只断 reason 的话，"挪进 no_endpoint 但 reason 名没改"
    // 那种改法看不出来（今天不会发生，但这句话的成本是零）
    expect(r.message).toContain('钥匙')
  })

  /**
   * ★ >= 500 那条兜底（同样是 2026-09-30 补的零覆盖分支）。
   *
   * 5xx 原来和"连不上"共用 `unreachable` 和它那句话 —— 而 5xx 意味着
   * **地址是通的**，是服务商那边自己出错了。说成"连不上这个接口地址"是句假话，
   * 而且下一步动作给错了（用户会去改一个没错的地址）。
   *
   * 变异：把 `fail('server_error')` 改回 `fail('unreachable')` → 这条红。
   */
  it('★ 5xx → 自己一类（server_error），文案不说"连不上"、给的下一步是"等一会儿"', async () => {
    const r = await probeConnection(INPUT, okFetch({}, 500))
    expect(r.ok === false && r.reason === 'server_error').toBe(true)
    if (r.ok) return
    expect(r.message).not.toContain('连不上')
    expect(r.message).toContain('过一会儿再试')
  })

  it('★ 连不上（DNS/超时/拒连）→ unreachable，而且**不把异常原文给用户**', async () => {
    const boom = (async () => { throw new Error('getaddrinfo ENOTFOUND api.example.com') }) as unknown as typeof fetch
    const r = await probeConnection(INPUT, boom)
    expect(r.ok === false && r.reason === 'unreachable').toBe(true)
    if (r.ok) return
    expect(r.message).not.toContain('ENOTFOUND')   // 运维口径不许出给用户
  })

  it('200 但不是 JSON → bad_response', async () => {
    const html = (async () => new Response('<html>hi</html>', { status: 200 })) as unknown as typeof fetch
    const r = await probeConnection(INPUT, html)
    expect(r.ok === false && r.reason === 'bad_response').toBe(true)
  })

  it('★ 200 但 data 是空的 → 也算通（有些服务商就是不给列表）', async () => {
    const r = await probeConnection(INPUT, okFetch({ data: [] }))
    expect(r).toEqual({ ok: true, models: [] })
  })

  it('★ 200 但**压根没有** data 数组 → 也算通，只是名单空', async () => {
    // 和上一条同一种处置，但走的是另一个分支（`!Array.isArray`）：解析得出 JSON、
    // 只是没有名单 —— 那对"地址通、钥匙对"这个目的毫无妨碍。
    // ⚠️ 这条不是洁癖：商汤的 /models 里就没有我们自己在用的那个图片模型，
    //    名单不全只能当建议，更不能因为"拿不到名单"就把用户判成填错了。
    const r = await probeConnection(INPUT, okFetch({ object: 'list' }))
    expect(r).toEqual({ ok: true, models: [] })
  })

  it('★ 打的是 /models，而且带 Authorization 头', async () => {
    let seen: { url: string; auth: string | undefined } | null = null
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>)?.authorization }
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await probeConnection(INPUT, spy)
    expect(seen!.url).toBe('https://api.example.com/v1/models')
    expect(seen!.auth).toBe('Bearer sk-x')
  })
})
