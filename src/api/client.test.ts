import { describe, it, expect, vi, afterEach } from 'vitest'
import { postEdit, postRoute, postSuggest, patch, put, del, ApiError } from './client'
import { ZERO } from '../../shared/adjustments.ts'

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

const sentBody = (c: { init: RequestInit }) => JSON.parse(String(c.init.body))

describe('postSuggest', () => {
  it('打到 /api/suggest，带 JSON content-type，请求体带 imageDataUrl', async () => {
    const calls = stubFetch(200, { cards: [], degraded: false })
    await postSuggest({ imageDataUrl: 'data:image/jpeg;base64,AA' })
    expect(calls[0].url).toBe('/api/suggest')
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toContain('application/json')
    // 服务端 parseRequest 只认这个字段名；改名服务端会 400。
    expect(sentBody(calls[0]).imageDataUrl).toBe('data:image/jpeg;base64,AA')
  })
})

describe('postEdit', () => {
  it('打到 /api/edit，带 JSON content-type，请求体带 editPrompt 与数字 width/height', async () => {
    const calls = stubFetch(200, { imageDataUrl: 'data:image/png;base64,QQ==', width: 1024, height: 768 })
    const res = await postEdit({
      imageDataUrl: 'data:image/jpeg;base64,AA',
      editPrompt: 'Remove the person behind the subject.',
      width: 1024,
      height: 768,
    })
    expect(calls[0].url).toBe('/api/edit')   // 这条走的是付费路，路径写错会 404
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toContain('application/json')
    const sent = sentBody(calls[0])
    expect(sent.imageDataUrl).toBe('data:image/jpeg;base64,AA')
    expect(sent.editPrompt).toBe('Remove the person behind the subject.')
    // 服务端要求数字（typeof width !== 'number' 直接 400）——字符串化会静默丢字段
    expect(typeof sent.width).toBe('number')
    expect(typeof sent.height).toBe('number')
    expect(res.width).toBe(1024)
  })
})

/**
 * 作品集那一组要的三个动词（Task 11 抽出来的 `send`）。
 *
 * ⚠️ **别再在这里列「谁调谁」。** 那是一件"每多一个调用方就作废一次"的事，
 * 本段已经为它错过三次：
 *   ① 初版写「它们今天还没有人调」—— Task 12 接上详情页，作废；
 *   ② Task 12 的改法改成逐个点名，但把 `put` 点错了（复审 R2 抓的）；
 *   ③ 改成对的那一版 —— Task 13 接通保存流程之后又作废。
 * **别写第四版。** 想知道今天有没有调用方，去搜函数名；想知道有哪些接口函数、
 * 各自干什么，看 `src/api/works.ts` 的注释。这个位置只留不会过期的话。
 *
 * 不会过期的是这一句：方法名或路径写错**不会报错** —— 显形方式是那个界面上
 * 「点了没反应」，所以这里钉的是打出去的到底是哪个动词。变异：把
 * `send('PUT', …)` 写成 `send('POST', …)`…… 这条立刻红，而后端那条路由
 * 是精确匹配，真跑到就是 404。
 */
describe('patch / put / del', () => {
  it('PATCH 和 PUT 带 JSON 体，走各自的方法', async () => {
    const calls = stubFetch(200, {})
    await patch('/api/works/7', { alias: '海边的日落' })
    expect(calls[0].url).toBe('/api/works/7')
    expect(calls[0].init.method).toBe('PATCH')
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toContain('application/json')
    expect(sentBody(calls[0])).toEqual({ alias: '海边的日落' })

    await put('/api/works/7', { image: 'data:image/jpeg;base64,AA' })
    expect(calls[1].init.method).toBe('PUT')
    expect(sentBody(calls[1]).image).toBe('data:image/jpeg;base64,AA')
  })

  it('DELETE 不带请求体 —— 没有体就不该有 content-type 那套头', async () => {
    // 后端那条 DELETE 明确**不读请求体**（读了会挂住等一个永远不会来的流）。
    // 变异：给它也塞一个 `{}`（"四个动词长得一样"最顺手的写法）→ 这条红。
    const calls = stubFetch(200, { ok: true })
    await del('/api/works/7')
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].init.body).toBeUndefined()
    expect(calls[0].init.headers).toBeUndefined()
  })
})
