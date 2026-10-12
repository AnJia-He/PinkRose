import { describe, it, expect } from 'vitest'
import { handleSuggest } from './suggest.ts'
import { SenseNovaClient } from './sn.ts'
import { SerialQueue } from './queue.ts'
import { SUGGEST_SYSTEM } from './prompt.ts'
import type { Config } from './config.ts'

const cfg: Config = {
  // ★ 2026-10-03：两条通道分开之后各有自己的默认连接（chat 走 Agnes、image 走商汤）。
  //   这个文件走的是**chat 那一路**，所以看的是 `cfg.chat`。
  chat: { apiKey: 'sk-test', baseUrl: 'https://x.cn/v1', model: 'v' },
  image: { apiKey: 'sk-img', baseUrl: 'https://img.example.cn/v1', model: 'm' },
  port: 0,
  dbPath: ':memory:',
  // 这两个是 Config 上的必填字段（起服务要它），这个文件既不碰账号也不碰图
  photoDir: 'unused',
  lutDir: 'unused',
  sessionSecret: 'test-secret',
  // 微信那两把钥匙（★ 2026-10-12）：空串 = 没配。这个文件碰不到那条路。
  wx: { appid: '', secret: '' },
}

// sn.ts 收窄之后，客户端吃的是「一条连接 + 一个模型名」，不再是整份 Config（Task 6）。
// cfg 本身照旧按 Config 用，这里只是把这一条连接显式拼出来 —— 走的是 chat 那一路。
const conn = { apiKey: cfg.chat.apiKey, baseUrl: cfg.chat.baseUrl, modelId: cfg.chat.model }

const IMG = 'data:image/jpeg;base64,AAAA'
const deps = (c: SenseNovaClient) => ({ client: c, queue: new SerialQueue({ sleep: async () => {} }) })

// 记录每次出站的请求体。不记录就钉不住"系统提示送对了没""图是不是用户那张"——
// 实测：把系统提示换成 ROUTER_SYSTEM、把图写死成 BOGUS，两种变异都全绿。
function replying(content: string | null, status = 200) {
  const calls: any[] = []
  const impl = (async (_u: any, init: any) => {
    calls.push(JSON.parse(init.body))
    return status !== 200
      ? new Response('{}', { status })
      : new Response(JSON.stringify({ choices: [{ message: { content } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { client: new SenseNovaClient(conn, impl), calls }
}

describe('handleSuggest', () => {
  it('解出卡片，并带上预计算的 paramDeltas', async () => {
    const { client, calls } = replying(JSON.stringify({ cards: [
      { label: '想让天蓝一点', route: 'params', param_deltas: { saturation: 20, clarity: 15 }, edit_prompt: '' },
      { label: '把后面的人去掉', route: 'generate', param_deltas: {}, edit_prompt: 'Remove the person in the background.' },
      { label: '整体亮一点', route: 'params', param_deltas: { exposure: 25 }, edit_prompt: '' },
    ] }))
    const res = await handleSuggest({ imageDataUrl: IMG }, deps(client))
    expect(res.cards).toHaveLength(3)
    expect(res.cards[0].paramDeltas).toEqual({ saturation: 20, clarity: 15 })
    expect(res.cards[1].editPrompt).toContain('Remove the person')
    expect(res.degraded).toBe(false)

    // 系统提示必须是 SUGGEST_SYSTEM —— 换成 ROUTER_SYSTEM 现在测试全绿
    expect(calls[0].messages[0].content).toBe(SUGGEST_SYSTEM)
    // 上游图必须是请求里那张 —— 写死 BOGUS 现在测试全绿
    expect(calls[0].messages[1].content[0].image_url.url).toBe(IMG)
  })

  it('最多 3 条，多的丢掉', async () => {
    const { client } = replying(JSON.stringify({ cards: Array.from({ length: 6 }, (_, i) =>
      ({ label: `第${i}条`, route: 'params', param_deltas: { exposure: 5 }, edit_prompt: '' })) }))
    expect((await handleSuggest({ imageDataUrl: IMG }, deps(client))).cards).toHaveLength(3)
  })

  it('label 为空的丢掉', async () => {
    const { client } = replying(JSON.stringify({ cards: [
      // 带上 deltas：否则它会被"空操作卡片"那条规则兜掉，
      // 这条断言就永远测不到 label 规则本身
      { label: '  ', route: 'params', param_deltas: { exposure: 10 }, edit_prompt: '' },
      { label: '亮一点', route: 'params', param_deltas: { exposure: 10 }, edit_prompt: '' },
    ] }))
    const res = await handleSuggest({ imageDataUrl: IMG }, deps(client))
    expect(res.cards.map(x => x.label)).toEqual(['亮一点'])
  })

  it('label 超过 20 字丢掉 —— prompt 里的 12 字是软要求，代码只兜底抽风', async () => {
    const { client } = replying(JSON.stringify({ cards: [
      { label: '啊'.repeat(30), route: 'params', param_deltas: { exposure: 10 }, edit_prompt: '' },
    ] }))
    expect((await handleSuggest({ imageDataUrl: IMG }, deps(client))).cards).toHaveLength(0)
  })

  it('route 是枚举外的值时按内容推断', async () => {
    const { client } = replying(JSON.stringify({ cards: [
      { label: '换个天空', route: 'ask', param_deltas: {}, edit_prompt: 'Replace the sky.' },
    ] }))
    expect((await handleSuggest({ imageDataUrl: IMG }, deps(client))).cards[0].route).toBe('generate')
  })

  it('deltas 走同一套量纲纠正 —— 卡片也会吐 0.4 这种小数', async () => {
    const { client } = replying(JSON.stringify({ cards: [
      { label: '蓝一点', route: 'params', param_deltas: { saturation: 0.2 }, edit_prompt: '' },
    ] }))
    expect((await handleSuggest({ imageDataUrl: IMG }, deps(client))).cards[0].paramDeltas).toEqual({ saturation: 20 })
  })

  it('既没有 deltas 也没有 edit_prompt 的卡片丢掉 —— 点了也没用', async () => {
    const { client } = replying(JSON.stringify({ cards: [
      { label: '看看这个', route: 'params', param_deltas: {}, edit_prompt: '' },
    ] }))
    expect((await handleSuggest({ imageDataUrl: IMG }, deps(client))).cards).toHaveLength(0)
  })

  it('上游失败时返回空卡片 + degraded，不是 500 —— 卡片没了不该挡住上传', async () => {
    const { client } = replying(null, 500)
    const res = await handleSuggest({ imageDataUrl: IMG }, deps(client))
    expect(res.cards).toEqual([])
    expect(res.degraded).toBe(true)
  })

  it('模型吐垃圾时同样返回空卡片', async () => {
    const { client } = replying('不是 JSON')
    const res = await handleSuggest({ imageDataUrl: IMG }, deps(client))
    expect(res.cards).toEqual([])
    expect(res.degraded).toBe(true)
  })

  it('模型合法地返回空卡片数组不算 degraded —— 那是有效回答，不是故障', async () => {
    const { client } = replying(JSON.stringify({ cards: [] }))
    const res = await handleSuggest({ imageDataUrl: IMG }, deps(client))
    expect(res.cards).toEqual([])
    expect(res.degraded).toBe(false)
  })

  it('缺图抛 BAD_REQUEST', async () => {
    const { client } = replying('{}')
    await expect(handleSuggest({}, deps(client))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('不是 data:image/ 开头的字符串也抛 BAD_REQUEST（http:// 这类同样拒）', async () => {
    // 上面那条 `{}` 死在第一个 disjunct（typeof !== 'string'）上，
    // 把 `!startsWith('data:image/')` 删掉它照样绿 —— 这条才钉住后半个守卫。
    const { client, calls } = replying('{}')
    await expect(handleSuggest({ imageDataUrl: 'http://evil/x.jpg' }, deps(client)))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(calls).toHaveLength(0)
  })
})
