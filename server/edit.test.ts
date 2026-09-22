import { describe, it, expect } from 'vitest'
import { handleEdit } from './edit.ts'
import { SenseNovaClient } from './sn.ts'
import { SerialQueue } from './queue.ts'
import type { Config } from './config.ts'

const cfg: Config = {
  apiKey: 'sk-test', baseUrl: 'https://x.cn/v1',
  imageModel: 'sensenova-u1.5-fast', vlmModel: 'v', port: 0,
}
const IMG = 'data:image/jpeg;base64,AAAA'
const deps = (c: SenseNovaClient) => ({ client: c, queue: new SerialQueue({ sleep: async () => {} }) })
const body = { imageDataUrl: IMG, editPrompt: 'Remove the person behind the subject.', width: 1024, height: 768 }

function replying(b64: string | undefined, status = 200) {
  const calls: any[] = []
  const impl = (async (_u: any, init: any) => {
    calls.push(JSON.parse(init.body))
    return status !== 200
      ? new Response('{"error":{"message":"boom"}}', { status })
      : new Response(JSON.stringify({ data: b64 === undefined ? [{}] : [{ b64_json: b64 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { client: new SenseNovaClient(cfg, impl), calls }
}

describe('handleEdit', () => {
  it('返回可直接给 <img> 用的 data URL', async () => {
    const { client } = replying('QUJD')
    const res = await handleEdit(body, deps(client))
    expect(res.imageDataUrl).toBe('data:image/png;base64,QUJD')
    expect(res.width).toBe(1024)
    expect(res.height).toBe(768)
  })

  it('发给模型的是补过保留项的 prompt —— 这一句决定了脸保不保得住', async () => {
    const { client, calls } = replying('QQ==')
    await handleEdit(body, deps(client))
    expect(calls[0].prompt).toContain('Remove the person behind the subject.')
    expect(calls[0].prompt).toContain('Preserve the person')
    expect(calls[0].prompt).toContain('Keep everything else exactly as it is')
  })

  it('宽高不是 32 的倍数 -> 400，且**一次 API 都不调**', async () => {
    const { client, calls } = replying('QQ==')
    await expect(handleEdit({ ...body, width: 1000 }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(calls).toHaveLength(0)   // 省钱的关键：不合规在本地就拒掉
  })

  it('宽高比超过 3:1 -> 400', async () => {
    const { client } = replying('QQ==')
    await expect(handleEdit({ ...body, width: 2048, height: 512 + 32 * 0 }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('超出 [512,4096] -> 400', async () => {
    const { client } = replying('QQ==')
    await expect(handleEdit({ ...body, width: 256, height: 512 }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(handleEdit({ ...body, width: 4096 + 32, height: 768 }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('空 editPrompt -> 400', async () => {
    const { client } = replying('QQ==')
    await expect(handleEdit({ ...body, editPrompt: '  ' }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('上游限流 -> 503 UPSTREAM_LIMIT（队列已经退避重试过）', async () => {
    const { client } = replying(undefined, 429)
    await expect(handleEdit(body, deps(client))).rejects.toMatchObject({ code: 'UPSTREAM_LIMIT' })
  })

  it('上游挂了 -> 502，且响应里不带任何 key 痕迹', async () => {
    const { client } = replying(undefined, 500)
    const e = await handleEdit(body, deps(client)).catch(e => e)
    expect(e.code).toBe('UPSTREAM_FAILED')
    expect(String(e.message)).not.toContain('sk-test')
  })

  it('透传图像模型的响应不是 JSON 时也归一化成 SnError', async () => {
    const { client } = replying(undefined, 200)
    // 上游返回 200 但没有 b64_json
    await expect(handleEdit(body, deps(client))).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
  })
})
