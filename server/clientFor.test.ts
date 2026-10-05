import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { createVault } from './keyvault.ts'
import { activateConfig, createConfig } from './models.ts'
import { SenseNovaClient, type ModelConnection } from './sn.ts'
import { AnthropicClient } from './anthropic.ts'
import { resolveClients, type ClientDeps } from './clientFor.ts'
import type { HostLookup } from './hostGuard.ts'

const USER = { id: 1, username: 'a', email: 'a@b.c' }
const CONFIG = {
  // ★ 2026-10-03：两条通道**不是同一家**（chat 走 Agnes、image 走商汤）。
  //   故意让两边的地址、钥匙、模型名**三个都不一样** —— 这样"取错了一条"
  //   在下面对每一处断言里都会立刻现形，不会因为两边长得像而蒙混过去。
  chat: { apiKey: 'sk-chat-default', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.5-flash' },
  image: { apiKey: 'sk-img-default', baseUrl: 'https://token.sensenova.cn/v1', model: 'sensenova-u1.5-fast' },
  port: 8787, dbPath: ':memory:', photoDir: '/tmp', lutDir: '/tmp/luts', sessionSecret: 's',
}

function fresh(lookupHost: HostLookup = async () => ['93.184.216.34']): ClientDeps {
  const db = openDb(':memory:')
  db.raw.prepare('INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?,?,?,?,?)')
    .run(USER.id, USER.username, USER.email, 'h', 1)
  // lookupHost 默认给"解析到公网"—— 单测不碰真 DNS（见 clientFor.ts 里那个注入点的注释）
  return { db, vault: createVault('test-secret'), config: CONFIG, lookupHost }
}

describe('按用户取客户端', () => {
  it('没配 → 两个都用默认那个，而且**各用各的那一条通道**', async () => {
    const c = await resolveClients(USER, fresh())
    // ★ 2026-10-03：这一条现在钉的是"chat 走 Agnes、image 走商汤"这件事本身。
    //   三样（地址 / 钥匙 / 模型名）一起比 —— 只比一样的话，"两条通道接错但
    //   恰好有一处相同"这种错法会溜过去。
    expect([c.chat.baseUrl, c.chat.apiKey, c.chat.vlmModel])
      .toEqual([CONFIG.chat.baseUrl, CONFIG.chat.apiKey, CONFIG.chat.model])
    expect([c.image.baseUrl, c.image.apiKey, c.image.imageModel])
      .toEqual([CONFIG.image.baseUrl, CONFIG.image.apiKey, CONFIG.image.model])
  })

  it('★ 只配了对话 → 对话换掉，图片一个字不变', async () => {
    const d = fresh()
    const m = createConfig({
      kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1',
      apiKey: 'sk-chat-only', modelId: 'my-vlm', alias: '甲',
    }, USER, d)
    activateConfig({ kind: 'chat', id: m.id }, USER, d)

    const c = await resolveClients(USER, d)
    expect(c.chat.apiKey).toBe('sk-chat-only')
    expect(c.chat.baseUrl).toBe('https://chat.example.com/v1')
    expect(c.image.apiKey).toBe(CONFIG.image.apiKey)
    expect(c.image.baseUrl).toBe(CONFIG.image.baseUrl)
  })

  it('★ 只配了图片 → 图片换掉，对话一个字不变', async () => {
    const d = fresh()
    const m = createConfig({
      kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1',
      apiKey: 'sk-img-only', modelId: 'my-editor', alias: '乙',
    }, USER, d)
    activateConfig({ kind: 'image', id: m.id }, USER, d)

    const c = await resolveClients(USER, d)
    expect(c.image.apiKey).toBe('sk-img-only')
    expect(c.chat.apiKey).toBe(CONFIG.chat.apiKey)
  })

  it('★ 两边都配了 → 各走各的，绝不串（§7.4 四条必测里最要紧的一条）', async () => {
    const d = fresh()
    const a = createConfig({ kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat', modelId: 'vlm', alias: '甲' }, USER, d)
    const b = createConfig({ kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-img', modelId: 'edit', alias: '乙' }, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    activateConfig({ kind: 'image', id: b.id }, USER, d)

    const c = await resolveClients(USER, d)
    expect([c.chat.apiKey, c.chat.baseUrl]).toEqual(['sk-chat', 'https://chat.example.com/v1'])
    expect([c.image.apiKey, c.image.baseUrl]).toEqual(['sk-img', 'https://img.example.com/v1'])
  })

  it('★ 图片的钥匙读不出来（主密钥换过）→ 只有图片回默认，对话不受影响', async () => {
    const d = fresh()
    const b = createConfig({ kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-img', modelId: 'edit', alias: '乙' }, USER, d)
    activateConfig({ kind: 'image', id: b.id }, USER, d)

    const broken: ClientDeps = { ...d, vault: createVault('another-secret') }
    const c = await resolveClients(USER, broken)
    expect(c.image.apiKey).toBe(CONFIG.image.apiKey)   // 回默认
    expect(c.chat.apiKey).toBe(CONFIG.chat.apiKey)
  })

  it('★ 模型名用的是用户填的那个', async () => {
    const d = fresh()
    const a = createConfig({ kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat', modelId: 'my-vlm', alias: '甲' }, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    expect((await resolveClients(USER, d)).chat.vlmModel).toBe('my-vlm')
  })

  it('★ provider=anthropic-compatible 的对话配置 → 造的是 AnthropicClient（2026-10-05）', async () => {
    // 这是"两种协议形状"的分叉本身：同一栏、同一份 resolveClients，
    // 用户存的是哪种形状就该造出哪个客户端。图片那一栏没得选
    //（`models.ts` 拒了 image × anthropic），所以它永远是 SenseNovaClient。
    const d = fresh()
    const a = createConfig({
      kind: 'chat', provider: 'anthropic-compatible', baseUrl: 'https://claude.example.com/v1',
      apiKey: 'sk-ant', modelId: 'claude-test', alias: '克劳德',
    }, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)

    const c = await resolveClients(USER, d)
    expect(c.chat).toBeInstanceOf(AnthropicClient)
    expect(c.image).toBeInstanceOf(SenseNovaClient)
    // 类选对了，连接三样也要是对的
    expect([c.chat.baseUrl, c.chat.apiKey, c.chat.vlmModel])
      .toEqual(['https://claude.example.com/v1', 'sk-ant', 'claude-test'])
  })

  /**
   * ★ 上面六条钉的都是"用户配了的那一条"。这一条盯的是**默认那一份的模型名** ——
   * 2026-10-03 之前这里写的是 `kind === 'chat' ? vlmModel : imageModel`，
   * 写反了上面六条照样全绿，后果是"什么都没配的人，改图走的是看图的模型"。
   * 现在两条通道各带一个 `model`，"串了"这件事由上面第一条（三样一起比）接住；
   * 这里留着是因为**模型名最容易在重构里被漏掉**：地址和钥匙改对了、模型名忘了，
   * 表现是"请求发到了对的家、却点了一个不存在的模型"。
   */
  it('★ 默认那一份：两边各拿自己那个模型名，不能串', async () => {
    const c = await resolveClients(USER, fresh())
    expect(c.chat.vlmModel).toBe(CONFIG.chat.model)
    expect(c.image.imageModel).toBe(CONFIG.image.model)
  })

  /**
   * ★ 上面六条走的都是**默认工厂**，所以它们对"工厂到底有没有被用上"一个字都没说 ——
   * 把 `clientFactory` 那一行删掉，它们照样全绿。而那个口子正是 Task 7 用来
   * 注入假客户端、检查出站请求的口子（"两套钥匙绝不串"那几条断言全靠它）。
   * 所以这一条单独钉住"注入真的生效"：看不见 seen 非空，就等于没有这个口子。
   */
  it('★ 注入的 clientFactory 真的被用上 —— 两个类别各拿一条连接', async () => {
    const d = fresh()
    const a = createConfig({ kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat', modelId: 'my-vlm', alias: '甲' }, USER, d)
    const b = createConfig({ kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-img', modelId: 'my-editor', alias: '乙' }, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    activateConfig({ kind: 'image', id: b.id }, USER, d)

    const seen: ModelConnection[] = []
    const c = await resolveClients(USER, {
      ...d,
      clientFactory: (conn) => { seen.push(conn); return new SenseNovaClient(conn) },
    })
    // 排序后再比：工厂的调用顺序是巧合，两条连接本身才是要钉的东西。
    expect(seen.map(x => `${x.apiKey}@${x.modelId}`).sort())
      .toEqual(['sk-chat@my-vlm', 'sk-img@my-editor'])
    expect(c.chat.vlmModel).toBe('my-vlm')
    expect(c.image.imageModel).toBe('my-editor')
  })

  /**
   * ★ 2026-10-04 补的一组：字面量黑名单挡不住**公共通配 DNS** —— `127.0.0.1.nip.io`
   *   这类域名免费、开箱即用，域名本身看着完全正常（实测可绕）。所以真正发请求前
   *   要按**解析出来的 IP** 再判一次。下面三条钉的是"判的是解析结果"，
   *   而不是"域名长得像不像内网"。
   */
  it('★ 用户配的地址解析到内网 → 拒绝（哪怕域名本身看着完全正常）', async () => {
    const d = fresh(async () => ['127.0.0.1'])
    const m = createConfig({
      kind: 'chat', provider: 'custom', baseUrl: 'https://looks-fine.example.test/v1',
      apiKey: 'sk-x', modelId: 'vlm', alias: '甲',
    }, USER, d)
    activateConfig({ kind: 'chat', id: m.id }, USER, d)

    await expect(resolveClients(USER, d)).rejects.toThrow(/内网/)
  })

  it('解析到公网 → 照常放行（别把正常用户误伤）', async () => {
    const d = fresh(async () => ['93.184.216.34'])
    const m = createConfig({
      kind: 'chat', provider: 'custom', baseUrl: 'https://looks-fine.example.test/v1',
      apiKey: 'sk-x', modelId: 'vlm', alias: '甲',
    }, USER, d)
    activateConfig({ kind: 'chat', id: m.id }, USER, d)

    const c = await resolveClients(USER, d)
    expect(c.chat.apiKey).toBe('sk-x')
  })

  it('★ 只拦**用户配**的那一条 —— 默认那条不做 DNS 查询（它不是攻击面）', async () => {
    let called = 0
    const d = fresh(async () => { called++; return ['93.184.216.34'] })
    await resolveClients(USER, d)   // 什么都没配 → 两条都走默认
    expect(called).toBe(0)
  })
})
