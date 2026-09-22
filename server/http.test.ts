import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import { readJsonBody, sendJson, HttpError } from './http.ts'

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
