import { describe, it, expect } from 'vitest'
import { handleRoute } from './route.ts'
import { SenseNovaClient } from './sn.ts'
import { SerialQueue } from './queue.ts'
import { ZERO } from '../src/core/adjustments.ts'
import type { Config } from './config.ts'

const cfg: Config = {
  apiKey: 'sk-test', baseUrl: 'https://x.cn/v1',
  imageModel: 'm', vlmModel: 'v', port: 0,
}

const IMG = 'data:image/jpeg;base64,AAAA'
const body = { imageDataUrl: IMG, text: '天太灰了', params: ZERO }

function clientReplying(content: string | null, status = 200) {
  const calls: any[] = []
  const impl = (async (_u: any, init: any) => {
    calls.push(JSON.parse(init.body))
    if (status !== 200) return new Response('{"error":{"message":"x"}}', { status })
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { client: new SenseNovaClient(cfg, impl), calls }
}

const deps = (client: SenseNovaClient) => ({ client, queue: new SerialQueue({ sleep: async () => {} }) })

describe('handleRoute', () => {
  it('把模型的 JSON 解成决策', async () => {
    const { client, calls } = clientReplying(JSON.stringify({
      route: 'params', param_deltas: { exposure: 25 },
      reply: '亮了点。', edit_prompt: '', needs_disambiguation: false,
    }))
    const res = await handleRoute(body, deps(client))
    expect(res.decision.route).toBe('params')
    expect(res.decision.paramDeltas).toEqual({ exposure: 25 })
    expect(res.decision.degraded).toBe(false)

    // 请求里带了图、用户的话、当前参数，且系统提示是 ROUTER_SYSTEM
    const sent = calls[0]
    expect(sent.model).toBe('v')
    const userParts = sent.messages[1].content
    expect(userParts[0].image_url.url).toBe(IMG)
    expect(userParts[1].text).toContain('天太灰了')
    expect(sent.messages[0].content).toContain('param_deltas')
  })

  it('LLM 抛错时返回降级决策，不是 500', async () => {
    const { client } = clientReplying(null, 500)
    const res = await handleRoute(body, deps(client))
    expect(res.decision.degraded).toBe(true)
    expect(res.decision.route).toBe('generate')
    expect(res.decision.editPrompt).toBe('天太灰了')
  })

  it('模型吐垃圾时也降级，不抛错', async () => {
    const { client } = clientReplying('这不是 JSON')
    const res = await handleRoute(body, deps(client))
    expect(res.decision.degraded).toBe(true)
  })

  it('缺 text 抛 BAD_REQUEST', async () => {
    const { client } = clientReplying('{}')
    await expect(handleRoute({ ...body, text: '' }, deps(client))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(handleRoute({ ...body, text: '   ' }, deps(client))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('缺图抛 BAD_REQUEST', async () => {
    const { client } = clientReplying('{}')
    await expect(handleRoute({ ...body, imageDataUrl: '' }, deps(client))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('图不是 data URL 就拒掉 —— 别把任意字符串当图送上去', async () => {
    const { client } = clientReplying('{}')
    await expect(handleRoute({ ...body, imageDataUrl: 'https://example.com/x.jpg' }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('超长输入被截断，不是原样送给模型', async () => {
    const { client, calls } = clientReplying('{"route":"params","param_deltas":{"exposure":5}}')
    await handleRoute({ ...body, text: '啊'.repeat(3000) }, deps(client))
    const text: string = calls[0].messages[1].content[1].text
    expect(text.length).toBeLessThan(3000)
  })

  it('params 字段缺失或不是对象时按全零处理，不崩', async () => {
    const { client } = clientReplying('{"route":"params","param_deltas":{"exposure":5}}')
    await expect(handleRoute({ imageDataUrl: IMG, text: '亮一点' }, deps(client))).resolves.toBeTruthy()
    await expect(handleRoute({ ...body, params: 'nope' }, deps(client))).resolves.toBeTruthy()
  })
})
