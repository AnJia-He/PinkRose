import { describe, it, expect, vi, afterEach } from 'vitest'
import { postRoute, ApiError } from './client'
import { ZERO } from '../core/adjustments'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } })
  })
  return calls
}

const REQ = { imageDataUrl: 'data:image/jpeg;base64,AA', text: '亮一点', params: ZERO }

describe('postRoute', () => {
  it('把 decision 解出来（不是整个响应体）', async () => {
    stubFetch(200, { decision: { route: 'params', paramDeltas: { exposure: 20 }, reply: '好', editPrompt: '', needsDisambiguation: false, degraded: false } })
    const d = await postRoute(REQ)
    expect(d.route).toBe('params')
    expect(d.paramDeltas).toEqual({ exposure: 20 })
  })

  it('打到 /api/route，带 JSON content-type', async () => {
    const calls = stubFetch(200, { decision: { route: 'params', paramDeltas: {}, reply: '', editPrompt: '', needsDisambiguation: false, degraded: false } })
    await postRoute(REQ)
    expect(calls[0].url).toBe('/api/route')
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toContain('application/json')
  })

  it('上游错误体被翻成 ApiError，带上 code 和给人看的文案', async () => {
    stubFetch(503, { error: { code: 'UPSTREAM_LIMIT', message: '排队的人有点多，稍等一下' } })
    const e = await postRoute(REQ).catch(e => e)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.code).toBe('UPSTREAM_LIMIT')
    expect(e.message).toContain('稍等')
  })

  it('响应不是 JSON 时给一句人话，不是抛 JSON.parse 的 SyntaxError', async () => {
    stubFetch(502, '<html>bad gateway</html>')
    const e = await postRoute(REQ).catch(e => e)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.message.length).toBeGreaterThan(0)
  })

  it('网络断了也给 ApiError —— 调用方只需要认识一种错误类型', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch') })
    await expect(postRoute(REQ)).rejects.toBeInstanceOf(ApiError)
  })
})
