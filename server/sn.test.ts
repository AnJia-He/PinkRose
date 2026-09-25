import { describe, it, expect } from 'vitest'
import { SenseNovaClient, SnError } from './sn.ts'
import type { Config } from './config.ts'

const cfg: Config = {
  apiKey: 'sk-test', baseUrl: 'https://x.cn/v1',
  imageModel: 'sensenova-u1.5-fast', vlmModel: 'sensenova-6.8-flash-lite', port: 0,
  dbPath: ':memory:',
  // Config 上的必填字段（起服务要它），这个文件不碰账号
  sessionSecret: 'test-secret',
}

/** 造一个假 fetch，记录请求体，返回给定响应。 */
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

describe('chatJson', () => {
  it('正常返回 content 字符串', async () => {
    const { impl } = fakeFetch({ body: { choices: [{ message: { content: '{"a":1}' } }] } })
    const out = await new SenseNovaClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }])
    expect(out).toBe('{"a":1}')
  })

  it('绝不发送 temperature —— kimi-k3 只接受 1，传 0 会被 400 拒', async () => {
    const { impl, calls } = fakeFetch({ body: { choices: [{ message: { content: 'x' } }] } })
    await new SenseNovaClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }])
    expect(bodyOf(calls[0])).not.toHaveProperty('temperature')
  })

  it('max_tokens 至少 1200 —— 否则 reasoning 会把正文吃光', async () => {
    const { impl, calls } = fakeFetch({ body: { choices: [{ message: { content: 'x' } }] } })
    await new SenseNovaClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }])
    expect(bodyOf(calls[0]).max_tokens).toBeGreaterThanOrEqual(1200)
  })

  it('带 response_format: json_object', async () => {
    const { impl, calls } = fakeFetch({ body: { choices: [{ message: { content: 'x' } }] } })
    await new SenseNovaClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }])
    expect(bodyOf(calls[0]).response_format).toEqual({ type: 'json_object' })
  })

  it('content 为 null（reasoning 吃光 token）时抛可重试的错，而不是崩在取值上', async () => {
    const { impl } = fakeFetch({
      body: { choices: [{ message: { content: null, reasoning_content: '想了很多' }, finish_reason: 'length' }] },
    })
    await expect(new SenseNovaClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }]))
      .rejects.toMatchObject({ code: 'UPSTREAM_FAILED', retryable: true })
  })

  it('choices 整个缺失也抛 SnError，不是 TypeError', async () => {
    const { impl } = fakeFetch({ body: { error: { message: 'boom' } } })
    await expect(new SenseNovaClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }]))
      .rejects.toBeInstanceOf(SnError)
  })

  it('429 抛 UPSTREAM_LIMIT 且标可重试', async () => {
    const { impl } = fakeFetch({ status: 429, body: { error: { message: 'inference exceeds tpm/rpm limit' } } })
    const e = await new SenseNovaClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }]).catch(e => e)
    expect(e).toBeInstanceOf(SnError)
    expect(e.code).toBe('UPSTREAM_LIMIT')
    expect(e.retryable).toBe(true)
  })

  it('5xx 可重试，400 不可重试', async () => {
    const mk = (status: number) => fakeFetch({ status, body: { error: { message: 'x' } } })
    const a = await new SenseNovaClient(cfg, mk(500).impl).chatJson([{ role: 'user', content: 'h' }]).catch(e => e)
    const b = await new SenseNovaClient(cfg, mk(400).impl).chatJson([{ role: 'user', content: 'h' }]).catch(e => e)
    expect(a.retryable).toBe(true)
    expect(b.retryable).toBe(false)
  })

  it('非 429 的 4xx 归 BAD_REQUEST（上游拒了，重试永远不会成功），5xx 才归 UPSTREAM_FAILED', async () => {
    // 原来所有非 429 的 4xx 都映成 UPSTREAM_FAILED → 502 +
    // 「AI 服务暂时没响应，再试一次」——对一次被上游拒绝的请求，
    // 这是一句永远不可能成功的指令。归 BAD_REQUEST（400），文案才说人话。
    const mk = (status: number) => fakeFetch({ status, body: { error: { message: 'x' } } })
    const bad = await new SenseNovaClient(cfg, mk(400).impl)
      .chatJson([{ role: 'user', content: 'h' }]).catch(e => e)
    const down = await new SenseNovaClient(cfg, mk(500).impl)
      .chatJson([{ role: 'user', content: 'h' }]).catch(e => e)
    expect(bad.code).toBe('BAD_REQUEST')
    expect(down.code).toBe('UPSTREAM_FAILED')
    expect(bad.retryable).toBe(false)
  })

  it('网络异常归一化成可重试的 SnError', async () => {
    const impl = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const e = await new SenseNovaClient(cfg, impl).chatJson([{ role: 'user', content: 'h' }]).catch(e => e)
    expect(e).toBeInstanceOf(SnError)
    expect(e.retryable).toBe(true)
  })

  it('读正文时连接中断也抛可重试的 SnError，不是裸 TypeError', async () => {
    // fetch 在**响应头**到达时就 resolve 了，正文是随后独立的一次网络往返：
    // 连接下载到一半被重置、或 AbortSignal.timeout 掐在几 MB 的 edit 正文
    // 传输途中，都落在这一步。裸异常逃出去的话，调用方按
    // `SnError && retryable` 判断要不要重试的网关会把它当成永久失败——
    // 于是"一次抖动"变成用户可见的硬错误，正是本文件要挡的那类静默故障。
    const impl = (async () => new Response(
      new ReadableStream({ start: c => c.error(new TypeError('terminated')) }),
    )) as unknown as typeof fetch
    const e = await new SenseNovaClient(cfg, impl).chatJson([{ role: 'user', content: 'h' }]).catch(e => e)
    expect(e).toBeInstanceOf(SnError)
    expect(e.retryable).toBe(true)
  })

  it('请求带上 Bearer 认证头', async () => {
    const { impl, calls } = fakeFetch({ body: { choices: [{ message: { content: 'x' } }] } })
    await new SenseNovaClient(cfg, impl).chatJson([{ role: 'user', content: 'hi' }])
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
  })
})

describe('edit', () => {
  const imgs = [{ image_url: 'data:image/jpeg;base64,AAA' }]

  it('取 data[0].b64_json 并返回纯 base64（不带 data: 前缀）', async () => {
    const { impl } = fakeFetch({ body: { data: [{ b64_json: 'QUJD' }] } })
    const out = await new SenseNovaClient(cfg, impl)
      .edit({ imageDataUrl: imgs[0].image_url, prompt: 'p', size: { width: 1024, height: 768 } })
    expect(out).toBe('QUJD')
  })

  it('response_format 必须是 b64_json —— url 那个 OSS 域名经常超时', async () => {
    const { impl, calls } = fakeFetch({ body: { data: [{ b64_json: 'QQ==' }] } })
    await new SenseNovaClient(cfg, impl)
      .edit({ imageDataUrl: imgs[0].image_url, prompt: 'p', size: { width: 1024, height: 768 } })
    expect(bodyOf(calls[0]).response_format).toBe('b64_json')
  })

  it('size 必须是 WIDTHxHEIGHT 字面量，绝不能是 auto', async () => {
    const { impl, calls } = fakeFetch({ body: { data: [{ b64_json: 'QQ==' }] } })
    await new SenseNovaClient(cfg, impl)
      .edit({ imageDataUrl: imgs[0].image_url, prompt: 'p', size: { width: 1024, height: 768 } })
    expect(bodyOf(calls[0]).size).toBe('1024x768')
  })

  it('返回体里没有 b64_json 时抛错，不静默退回 url', async () => {
    const { impl } = fakeFetch({ body: { data: [{ url: 'https://aoss.example/x.png' }] } })
    await expect(new SenseNovaClient(cfg, impl)
      .edit({ imageDataUrl: imgs[0].image_url, prompt: 'p', size: { width: 1024, height: 768 } }))
      .rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
  })
})
