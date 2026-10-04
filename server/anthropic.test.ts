import { describe, it, expect } from 'vitest'
import { AnthropicClient } from './anthropic.ts'
import { SnError, type ModelConnection } from './sn.ts'

// 这一份测的是**形状转换**：Anthropic 协议和 OpenAI 协议差的那几处
//（URL、请求头、system 位置、图片块、相邻 user 合并、响应解析）。
// 出站的安全性质（重定向/体积/超时/错误分类/抹钥匙）在 sn.test.ts 里守着 ——
// 两边共用 `requestJson`，这里只抽一条 401 证明"分类真的接上了"。

const cfg: ModelConnection = {
  apiKey: 'sk-ant-test', baseUrl: 'https://x.example.com/v1',
  modelId: 'claude-test',
}

/** 造一个假 fetch，记录请求，返回给定响应（和 sn.test.ts 同一把）。 */
function fakeFetch(reply: { status?: number; body?: unknown; text?: string }) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! })
    const status = reply.status ?? 200
    const text = reply.text ?? JSON.stringify(reply.body ?? {})
    return new Response(text, { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const bodyOf = (c: { init: RequestInit }) => JSON.parse(String(c.init.body))
const headersOf = (c: { init: RequestInit }) => c.init.headers as Record<string, string>
const ok = (body: unknown) => fakeFetch({ body })

describe('AnthropicClient.chatJson —— 请求形状', () => {
  it('打在 /messages 上（baseUrl 归一化过、总以 /v1 结尾）；x-api-key + 版本头，**没有** authorization', async () => {
    const { impl, calls } = ok({ content: [{ type: 'text', text: 'x' }] })
    await new AnthropicClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }])

    expect(calls[0].url).toBe('https://x.example.com/v1/messages')
    const h = headersOf(calls[0])
    expect(h['x-api-key']).toBe('sk-ant-test')
    expect(h['anthropic-version']).toBe('2023-06-01')
    // ⚠️ 两种协议的鉴权头**互斥** —— 多带一个是给对面的"踩雷"，少带认证又没有
    expect(h).not.toHaveProperty('authorization')
  })

  it('system 提升到顶层；相邻 user 合并成一条（roles must alternate，连着两条 user 官方会 400）', async () => {
    const { impl, calls } = ok({ content: [{ type: 'text', text: 'x' }] })
    await new AnthropicClient(cfg, impl).chatJson([
      { role: 'system', content: '你是修图助手' },
      { role: 'system', content: '只回 JSON' },
      { role: 'user', content: '第一句' },
      { role: 'user', content: '第二句' },
    ])

    const b = bodyOf(calls[0])
    expect(b.system).toBe('你是修图助手\n\n只回 JSON')   // 多条 system 合并进顶层字段
    expect(b.messages).toHaveLength(1)                  // **两条 user 合成一条**
    expect(b.messages[0].role).toBe('user')
    expect(b.messages[0].content).toEqual([
      { type: 'text', text: '第一句' },
      { type: 'text', text: '第二句' },
    ])
  })

  it('图片块：data URL → base64 source（media_type 从 data URL 头上取）', async () => {
    const { impl, calls } = ok({ content: [{ type: 'text', text: 'x' }] })
    await new AnthropicClient(cfg, impl).chatJson([{ role: 'user', content: [
      { type: 'text', text: '看看这张' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ] }])

    const b = bodyOf(calls[0])
    expect(b.messages[0].content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
    })
  })

  it('不是 data URL 的图片 —— 当场说清楚（BAD_REQUEST），不把 http 链接塞进 source 等对面报错', async () => {
    const { impl } = ok({ content: [{ type: 'text', text: 'x' }] })
    await expect(new AnthropicClient(cfg, impl).chatJson([{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://x.example.com/a.jpg' } },
    ] }])).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('max_tokens 必有、至少 1200（这个协议里它是必填字段）', async () => {
    const { impl, calls } = ok({ content: [{ type: 'text', text: 'x' }] })
    await new AnthropicClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }])
    expect(bodyOf(calls[0]).max_tokens).toBeGreaterThanOrEqual(1200)
  })
})

describe('AnthropicClient.chatJson —— 响应与错误', () => {
  it('多个 text 块拼起来；别的类型（thinking）跳过', async () => {
    const { impl } = ok({ content: [
      { type: 'thinking', thinking: '想了很多' },
      { type: 'text', text: '{"a":' },
      { type: 'text', text: '1}' },
    ] })
    const out = await new AnthropicClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }])
    expect(out).toBe('{"a":1}')
  })

  it('没有 text 块（被 max_tokens 截光）→ 可重试的 UPSTREAM_FAILED，stop_reason 带进消息', async () => {
    const { impl } = ok({ content: [], stop_reason: 'max_tokens' })
    const e = await new AnthropicClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }]).catch(e => e)
    expect(e).toBeInstanceOf(SnError)
    expect(e.code).toBe('UPSTREAM_FAILED')
    expect(e.retryable).toBe(true)
    expect(e.message).toContain('max_tokens')
  })

  it('错误分类和 OpenAI 形状共用一套：401 → UPSTREAM_AUTH 且不可重试', async () => {
    const { impl } = fakeFetch({ status: 401, body: { error: { message: 'invalid x-api-key' } } })
    const e = await new AnthropicClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }]).catch(e => e)
    expect(e.code).toBe('UPSTREAM_AUTH')
    expect(e.retryable).toBe(false)
  })

  it('edit() 抛清楚的错 —— 这个形状没有图片生成（正常路径有服务端和界面两道闸拦着）', async () => {
    const { impl } = ok({})
    const e = await new AnthropicClient(cfg, impl)
      .edit({ imageDataUrl: 'data:image/jpeg;base64,AA', prompt: 'x', size: { width: 4, height: 4 } })
      .catch(e => e)
    expect(e).toBeInstanceOf(SnError)
    expect(e.code).toBe('BAD_REQUEST')
    expect(e.message).toContain('兼容 OpenAI')   // 说"不行"的时候要带出路
  })
})
