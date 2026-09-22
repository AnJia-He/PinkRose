import { describe, it, expect, vi, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { readJsonBody, sendJson, sendError, HttpError } from './http.ts'
import { SnError } from './sn.ts'

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
})
