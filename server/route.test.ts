import { describe, it, expect } from 'vitest'
import { handleRoute } from './route.ts'
import { SenseNovaClient } from './sn.ts'
import { SerialQueue } from './queue.ts'
import { ROUTER_SYSTEM } from './prompt.ts'
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
    // 必须**钉住整句**：`toContain('param_deltas')` 那种弱断言区分不出
    // ROUTER_SYSTEM 和 SUGGEST_SYSTEM——后者也含这个词（实测：把系统提示
    // 换成 SUGGEST_SYSTEM，弱断言照样绿）。
    expect(sent.messages[0].content).toBe(ROUTER_SYSTEM)
  })

  it('LLM 抛错时返回降级决策，不是 500', async () => {
    const { client } = clientReplying(null, 500)
    const res = await handleRoute(body, deps(client))
    expect(res.decision.degraded).toBe(true)
    expect(res.decision.route).toBe('generate')
    expect(res.decision.editPrompt).toBe('天太灰了')
  })

  // 名字与断言都改准了：模型吐垃圾时，parseDecision 的内部收敛和 handleRoute
  // 的 catch **都会**给出 degraded: true，所以单看 degraded 区分不出两条降级路径
  // （实测：把 parseDecision(content) 换成 parseDecision(JSON.parse(content))，
  // 弱版本照样绿）。它确实咬住了"不抛错"，但名字声称得比它强。
  // 下面补的 editPrompt 断言才真正区分二者：走 catch 的话 prompt 是**用户原话**，
  // 只有 validate 那条容错解析器接住了，才会留下模型原文。
  it('模型吐垃圾时不抛错，且由 parseDecision 收敛（不是 catch 兜的）', async () => {
    const { client } = clientReplying('这不是 JSON')
    const res = await handleRoute(body, deps(client))
    expect(res.decision.degraded).toBe(true)
    expect(res.decision.editPrompt).toBe('这不是 JSON')
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
    // 钉住的是"截断到 MAX_USER_TEXT 个字符"这件事本身，而不只是"比原来短"——
    // `toBeLessThan(3000)` 那种写法在 MAX_USER_TEXT 被改成 2500 时照样绿。
    expect(text).toContain('啊'.repeat(500))
    expect(text).not.toContain('啊'.repeat(501))
  })

  it('params 字段缺失或不是对象时按全零处理，是对象时走钳制', async () => {
    // 这条原来只有两个 `resolves.toBeTruthy()`——而 handleRoute 在任何情况下
    // 都返回对象，所以那两个断言对它们命名的事**恒真**（变异探针实测：把
    // normalizeParams 换成 `return v as Adjustments`，两行照样绿）。
    // 改成断言**真正发出去的内容**。
    const { client, calls } = clientReplying('{"route":"params","param_deltas":{"exposure":5}}')

    await handleRoute({ imageDataUrl: IMG, text: '亮一点' }, deps(client))
    expect(calls[0].messages[1].content[1].text).toContain('用户当前未做任何调整')

    await handleRoute({ ...body, params: 'nope' }, deps(client))
    expect(calls[1].messages[1].content[1].text).toContain('用户当前未做任何调整')

    // 关键的一条：上游收到的必须是**钳到 100 之后**的值。
    // normalizeParams 若被改成原样透传，这里会看到 +999。
    await handleRoute({ ...body, params: { exposure: 999 } }, deps(client))
    expect(calls[2].messages[1].content[1].text).toContain('亮度 +100')
  })
})
