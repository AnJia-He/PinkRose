import { describe, it, expect, afterEach } from 'vitest'
import type { Server } from 'node:http'
import { createApp, type AppDeps } from './app.ts'
import type { Config } from './config.ts'
import { SerialQueue } from './queue.ts'
import { SenseNovaClient } from './sn.ts'

const cfg: Config = {
  apiKey: 'sk-secret-must-not-leak',
  baseUrl: 'https://x.cn/v1',
  imageModel: 'm',
  vlmModel: 'v',
  port: 0,
}

let server: Server | undefined
afterEach(async () => { await new Promise<void>(r => server?.close(() => r())) })

async function boot(extra: Partial<AppDeps> = {}): Promise<string> {
  server = createApp({ config: cfg, ...extra })
  await new Promise<void>(r => server!.listen(0, r))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

/** 端点断言用的合法 /api/edit 请求体。 */
const editBody = {
  imageDataUrl: 'data:image/jpeg;base64,AA',
  editPrompt: '删掉后面那个人',
  width: 1024,
  height: 768,
}

/**
 * 桩上游：记下每次请求体，**不真出网**。`status !== 200` 时回一个带独特
 * 哨兵串的错误体——用来验证"上游原文不会漏进给用户的响应"。
 */
function stubUpstream(status = 200) {
  const calls: any[] = []
  const impl = (async (_u: any, init: any) => {
    calls.push(JSON.parse(init.body))
    return status === 200
      ? new Response('{"choices":[{"message":{"content":"{\\"cards\\":[]}"}}]}', { status: 200 })
      : new Response('{"error":{"message":"SENTINEL-UPSTREAM-BODY-c4d1"}}', { status })
  }) as unknown as typeof fetch
  return {
    calls,
    deps: { client: new SenseNovaClient(cfg, impl), queue: new SerialQueue({ sleep: async () => {} }) },
  }
}

async function post(base: string, path: string, body: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() as { error?: { code: string; message: string } } }
}

describe('createApp', () => {
  it('GET /api/health 返回 ok', async () => {
    const base = await boot()
    const r = await fetch(`${base}/api/health`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it('未知 /api 路径返回 404 的 JSON 错误，不是 HTML', async () => {
    const base = await boot()
    const r = await fetch(`${base}/api/nope`)
    expect(r.status).toBe(404)
    const body = await r.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_REQUEST')
  })

  it('任何响应体里都不能出现 API key', async () => {
    const base = await boot()
    for (const p of ['/api/health', '/api/nope']) {
      const r = await fetch(`${base}${p}`)
      expect(await r.text()).not.toContain('sk-secret-must-not-leak')
    }
  })

  it('非 /api 路径不回 JSON —— 那是静态资源的领地', async () => {
    const base = await boot()
    const r = await fetch(`${base}/some/asset.js`)
    expect(r.headers.get('content-type') ?? '').not.toContain('application/json')
  })

  it('POST /api/route 在没接客户端时返回 503 的结构化错误', async () => {
    const base = await boot()
    const r = await fetch(`${base}/api/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,AA', text: '亮一点' }),
    })
    expect(r.status).toBe(503)
    // tsconfig.server.json 的 lib 不含 DOM：Response.json() 是 unknown，
    // 断言形状跟本文件其它用例一致（Task 1 起的写法）。
    const body = await r.json() as { error: { code: string } }
    expect(body.error.code).toBe('INTERNAL')
  })

  it('POST /api/route 的请求体超限时不把内存吃光', async () => {
    // **必须注入 deps**：否则 503 守卫会先于 readJsonBody 触发，
    // 这条测试永远拿不到 413（brief 原稿的缺陷，已由控制方裁定）。
    // 这里不需要 client 真的能工作——只要守卫放行。
    const base = await boot({
      client: new SenseNovaClient(cfg, (async () => new Response('{}')) as unknown as typeof fetch),
      queue: new SerialQueue({ sleep: async () => {} }),
    })
    const r = await fetch(`${base}/api/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(13 * 1024 * 1024), text: 'x' }),
    })
    expect(r.status).toBe(413)
  })

  it('POST /api/suggest 在没接客户端时返回 503 的结构化错误', async () => {
    const base = await boot()
    const r = await post(base, '/api/suggest', { imageDataUrl: 'data:image/jpeg;base64,AA' })
    expect(r.status).toBe(503)
    expect(r.body.error!.code).toBe('INTERNAL')
  })

  it('POST /api/edit 在没接客户端时返回 503 的结构化错误', async () => {
    const base = await boot()
    const r = await post(base, '/api/edit', editBody)
    expect(r.status).toBe(503)
    expect(r.body.error!.code).toBe('INTERNAL')
  })

  it('POST /api/suggest 接上客户端后确实走进了 handler（400 是 handler 给的，且没出网）', async () => {
    const { deps, calls } = stubUpstream()
    const base = await boot(deps)
    const r = await post(base, '/api/suggest', {})
    expect(r.status).toBe(400)
    expect(r.body.error!.message).toContain('imageDataUrl')
    expect(calls).toHaveLength(0)
  })

  it('POST /api/edit 接上客户端后确实走进了 handler（不合规尺寸在本地就拒掉，一次 API 都不调）', async () => {
    const { deps, calls } = stubUpstream()
    const base = await boot(deps)
    const r = await post(base, '/api/edit', { ...editBody, width: 1000 })
    expect(r.status).toBe(400)
    expect(r.body.error!.message).toContain('图片尺寸 1000x768')
    expect(calls).toHaveLength(0)
  })

  it('POST /api/edit 上游 429 -> 503 UPSTREAM_LIMIT，上游原文只进日志', async () => {
    const { deps, calls } = stubUpstream(429)
    const base = await boot(deps)
    const r = await fetch(`${base}/api/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(editBody),
    })
    expect(r.status).toBe(503)
    const text = await r.text()
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe('UPSTREAM_LIMIT')
    expect(text).not.toContain('SENTINEL-UPSTREAM-BODY-c4d1')
    expect(calls.length).toBeGreaterThan(0)   // 是上游真的挂了，不是本地拒的
  })
})
