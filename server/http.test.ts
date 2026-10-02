import { readTextCapped } from './http.ts'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { readJsonBody, sendJson, sendError, HttpError } from './http.ts'
import { SenseNovaClient, SnError } from './sn.ts'

afterEach(() => vi.restoreAllMocks())

/** 起一个一次性服务器把 req/res 造出来，比 mock 更接近真实。 */
async function withServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
  body: string,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Promise<{ status: number; text: string }> {
  const server = createServer(handler)
  await new Promise<void>(r => server.listen(0, r))
  const port = (server.address() as { port: number }).port
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers, body })
    return { status: res.status, text: await res.text() }
  } finally {
    await new Promise<void>(r => server.close(() => r()))
  }
}

describe('sendJson', () => {
  it('写出状态码、content-type 和 JSON', async () => {
    const r = await withServer((_q, s) => sendJson(s, 201, { a: 1 }), '')
    expect(r.status).toBe(201)
    expect(JSON.parse(r.text)).toEqual({ a: 1 })
  })

  it('HttpError 被转成结构化错误体，且 message 原样保留', async () => {
    const r = await withServer((_q, s) => sendJson(s, 400, new HttpError('BAD_REQUEST', '缺 text')), '')
    expect(JSON.parse(r.text)).toEqual({ error: { code: 'BAD_REQUEST', message: '缺 text' } })
  })
})

describe('readJsonBody', () => {
  it('解析合法 JSON', async () => {
    let seen: unknown
    await withServer(async (q, s) => { seen = await readJsonBody(q); sendJson(s, 200, {}); }, '{"x":2}')
    expect(seen).toEqual({ x: 2 })
  })

  it('超过上限抛 BAD_REQUEST，而不是把内存吃光', async () => {
    let err: unknown
    await withServer(async (q, s) => {
      try { await readJsonBody(q, 10) } catch (e) { err = e }
      sendJson(s, 200, {})
    }, '{"x":"' + 'a'.repeat(100) + '"}')
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).code).toBe('BAD_REQUEST')
  })

  it('非法 JSON 抛 BAD_REQUEST', async () => {
    let err: unknown
    await withServer(async (q, s) => {
      try { await readJsonBody(q) } catch (e) { err = e }
      sendJson(s, 200, {})
    }, '{oops')
    expect((err as HttpError).code).toBe('BAD_REQUEST')
  })
})

/**
 * `SnError` 与 `HttpError` 共用同一套 `AppErrorCode` 域，但**状态码不同**：
 * HttpError 自带 status，SnError 只有 code。差这一步映射，
 * 一次上游限流就会以 500 INTERNAL 的形态到达用户，而前端按
 * UPSTREAM_LIMIT 分流的那条分支永远走不到。
 */
describe('sendError', () => {
  it('SnError(UPSTREAM_LIMIT) -> 503，且 body 的 code 是 UPSTREAM_LIMIT', async () => {
    const r = await withServer((_q, s) =>
      sendError(s, new SnError('UPSTREAM_LIMIT', '上游 HTTP 429：{"error":"rate limited"}', true)), '')
    expect(r.status).toBe(503)
    expect(JSON.parse(r.text)).toEqual({
      error: { code: 'UPSTREAM_LIMIT', message: '排队的人有点多，稍等一下再试' },
    })
  })

  it('SnError(UPSTREAM_FAILED) -> 502', async () => {
    const r = await withServer((_q, s) =>
      sendError(s, new SnError('UPSTREAM_FAILED', '连不上上游：fetch failed', true)), '')
    expect(r.status).toBe(502)
    expect(JSON.parse(r.text).error.code).toBe('UPSTREAM_FAILED')
  })

  it('上游原文只进服务端日志，**不进**响应体（那是用户会看到的文案）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await withServer((_q, s) =>
      sendError(s, new SnError('UPSTREAM_LIMIT', 'SENTINEL-UPSTREAM-TEXT-7f3a', true)), '')
    expect(r.text).not.toContain('SENTINEL-UPSTREAM-TEXT-7f3a')
    expect(String(spy.mock.calls.flat().join(' '))).toContain('SENTINEL-UPSTREAM-TEXT-7f3a')
  })

  it('其它异常仍是 500，且同样只把细节写进日志', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await withServer((_q, s) => sendError(s, new Error('SENTINEL-INTERNAL-9b1c')), '')
    expect(r.status).toBe(500)
    expect(JSON.parse(r.text).error.code).toBe('INTERNAL')
    expect(r.text).not.toContain('SENTINEL-INTERNAL-9b1c')
    expect(String(spy.mock.calls.flat().join(' '))).toContain('SENTINEL-INTERNAL-9b1c')
  })

  /**
   * ★ 2026-09-30 加：服务商**不认这把钥匙**时，用户读到的那一句话。
   *
   * 这一格原来不存在 —— 上游 401/403 归 BAD_REQUEST，于是用户读到
   * 「这次请求有点问题，换个说法试试」：把"钥匙不对"说成了"你说的话不对"。
   * 他改一百遍措辞也没用（文案规范：不许写产品做不到的事）。
   */
  it('★ SnError(UPSTREAM_AUTH) -> 502，文案让人去查钥匙，**不是**「换个说法试试」', async () => {
    // 这句话**故意不区分"这把钥匙是谁的"**：归属要一路传进三个 handler 才拿得到，
    // 为一句更精确的话不值得（见 http.ts 那段注释）。所以写成谁看都对号入座的一句 ——
    // 填过钥匙的人知道去哪儿查，没填过的人知道是我们这边的问题。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await withServer((_q, s) =>
      sendError(s, new SnError('UPSTREAM_AUTH', '上游 HTTP 401：SENTINEL-UPSTREAM-TEXT-a11a', false)), '')
    expect(r.status).toBe(502)
    const body = JSON.parse(r.text) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('UPSTREAM_AUTH')
    expect(body.error.message).toContain('钥匙')
    expect(body.error.message).not.toContain('换个说法')
    // 上游原文只进日志，和上面那条同一个规矩（那是英文运维口径，会原样弹给用户）
    expect(r.text).not.toContain('SENTINEL-UPSTREAM-TEXT-a11a')
    expect(String(spy.mock.calls.flat().join(' '))).toContain('SENTINEL-UPSTREAM-TEXT-a11a')
  })

  /**
   * ★ 2026-10-01 加（最终审查 Important ③）：「上游原文只进日志」有个死角 ——
   * **第三方网关会在 401 正文里回显收到的凭据**（"invalid api key: sk-…"，
   * 或者把整条 authorization 头贴回来）。于是"上游说的话"里混着用户的钥匙，
   * 而这句话会被原样打进日志。§7.7 说「绝不进日志」—— 我们自己的请求头从来不
   * 打印，这是唯一一条"第三方回显经我们之手"的路。
   *
   * 这条用例走的是**真链路**：真客户端 → 真 401 回显 → 真 SnError → 真日志出口。
   *
   * ⚠️ **2026-10-02（安全审计 S5）改了契约**：原来只保证"进日志前抹掉"，
   *    message 里留着明文（下面那句 `toContain` 就是旧契约的钉子）。
   *    现在是在**拼 message 的那一刻**就按值抹掉 —— 四个日志出口每一个都得
   *    记得抹太脆，漏一个就是明文进日志；源头抹掉则**不可能漏**。
   *    多了一条更狠的：这里的钥匙是 `sk-live-…` 形状，形状正则认得出；
   *    但**按值抹不挑形状**，上游用 `api_key=xxx` 那种写法回显也跑不掉。
   */
  it('★ 上游 401 正文里回显的钥匙 —— 连 message 里都不留（源头就抹）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const echo = '{"error":{"message":"invalid api key: sk-live-9f2a7c41","sent":"Bearer sk-live-9f2a7c41"}}'
    const client = new SenseNovaClient(
      { apiKey: 'sk-live-9f2a7c41', baseUrl: 'https://x.cn/v1', modelId: 'm' },
      (async () => new Response(echo, { status: 401 })) as unknown as typeof fetch,
    )
    // `.then(_, _)` 而不是 `.catch(e => e as Error)`：后者让结果类型变成
    // `string | Error`（catch 的返回值进了联合），`.message` 当场编译不过。
    const err = await client.chatJson([{ role: 'user', content: 'h' }])
      .then(() => { throw new Error('401 应该抛错，它却成功了') }, (e: Error) => e)
    // 前提：正文真的被拼进了 message（少了这一条，下面测的就是空气）
    // ★ 新契约：**钥匙不在里面了**，而"上游说了什么"这条线索要在。
    expect(err.message).toContain('invalid api key')
    expect(err.message).not.toContain('sk-live-9f2a7c41')

    const r = await withServer((_q, s) => sendError(s, err), '')
    expect(r.status).toBe(502)
    const logged = spy.mock.calls.flat().map(String).join(' ')
    expect(logged).not.toContain('sk-live-9f2a7c41')
    expect(logged).toContain('[已隐藏]')
    // 用户那一侧照旧：上游原文（含钥匙）一个字都不许出去
    expect(r.text).not.toContain('sk-live-9f2a7c41')
    // 变异：把 console.error 那一行的 redactSecrets 拿掉 → logged 里带着整把钥匙 → 这一条红
  })
})

/**
 * ★ 2026-10-02（安全审计 S2）：出站响应体必须有上限。
 *
 * 加这条之前，`sn.ts` 和 `modeltest.ts` 都是裸的 `await res.text()` ——
 * Node 对响应体**没有任何内置上限**，实测 64 MB 一秒内缓冲完。
 * 而这两处的地址是**用户自己填的**：任何人注册个号、把地址指向自己的服务器、
 * 让它流式回几十 GB，就能把这台机器的内存吃光（全站一起挂）。
 */
describe('readTextCapped', () => {
  it('没超上限就照常读回来', async () => {
    const res = new Response('你好，世界')
    expect(await readTextCapped(res, 1024)).toBe('你好，世界')
  })

  it('声明了 content-length 且超限 → 连读都不读', async () => {
    const res = new Response('x', { headers: { 'content-length': '99999999' } })
    await expect(readTextCapped(res, 1024)).rejects.toThrow(/上限/)
  })

  it('★ 不带 content-length 的分块响应也拦得住（真正的攻击形状）', async () => {
    // 攻击者不会老老实实报长度 —— 他会一块一块地灌。
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 200; i++) c.enqueue(new Uint8Array(1024))
        c.close()
      },
    })
    const res = new Response(stream)
    await expect(readTextCapped(res, 10_000)).rejects.toThrow(/上限/)
  })

  it('刚好等于上限 → 放行（边界是"超过"才拦）', async () => {
    const res = new Response('x'.repeat(100))
    expect((await readTextCapped(res, 100)).length).toBe(100)
  })

  it('没有正文的响应回空串，不抛', async () => {
    const res = new Response(null, { status: 204 })
    expect(await readTextCapped(res, 100)).toBe('')
  })
})
