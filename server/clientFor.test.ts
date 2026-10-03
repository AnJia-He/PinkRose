import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { createVault } from './keyvault.ts'
import { activateConfig, createConfig } from './models.ts'
import { SenseNovaClient, type ModelConnection } from './sn.ts'
import { resolveClients, type ClientDeps } from './clientFor.ts'

const USER = { id: 1, username: 'a', email: 'a@b.c' }
const CONFIG = {
  // ★ 2026-10-03：两条通道**不是同一家**（chat 走 Agnes、image 走商汤）。
  //   故意让两边的地址、钥匙、模型名**三个都不一样** —— 这样"取错了一条"
  //   在下面对每一处断言里都会立刻现形，不会因为两边长得像而蒙混过去。
  chat: { apiKey: 'sk-chat-default', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.5-flash' },
  image: { apiKey: 'sk-img-default', baseUrl: 'https://token.sensenova.cn/v1', model: 'sensenova-u1.5-fast' },
  port: 8787, dbPath: ':memory:', photoDir: '/tmp', sessionSecret: 's',
}

function fresh(): ClientDeps {
  const db = openDb(':memory:')
  db.raw.prepare('INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?,?,?,?,?)')
    .run(USER.id, USER.username, USER.email, 'h', 1)
  return { db, vault: createVault('test-secret'), config: CONFIG }
}

describe('按用户取客户端', () => {
  it('没配 → 两个都用默认那个，而且**各用各的那一条通道**', () => {
    const c = resolveClients(USER, fresh())
    // ★ 2026-10-03：这一条现在钉的是"chat 走 Agnes、image 走商汤"这件事本身。
    //   三样（地址 / 钥匙 / 模型名）一起比 —— 只比一样的话，"两条通道接错但
    //   恰好有一处相同"这种错法会溜过去。
    expect([c.chat.baseUrl, c.chat.apiKey, c.chat.vlmModel])
      .toEqual([CONFIG.chat.baseUrl, CONFIG.chat.apiKey, CONFIG.chat.model])
    expect([c.image.baseUrl, c.image.apiKey, c.image.imageModel])
      .toEqual([CONFIG.image.baseUrl, CONFIG.image.apiKey, CONFIG.image.model])
  })

  it('★ 只配了对话 → 对话换掉，图片一个字不变', () => {
    const d = fresh()
    const m = createConfig({
      kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1',
      apiKey: 'sk-chat-only', modelId: 'my-vlm', alias: '甲',
    }, USER, d)
    activateConfig({ kind: 'chat', id: m.id }, USER, d)

    const c = resolveClients(USER, d)
    expect(c.chat.apiKey).toBe('sk-chat-only')
    expect(c.chat.baseUrl).toBe('https://chat.example.com/v1')
    expect(c.image.apiKey).toBe(CONFIG.image.apiKey)
    expect(c.image.baseUrl).toBe(CONFIG.image.baseUrl)
  })

  it('★ 只配了图片 → 图片换掉，对话一个字不变', () => {
    const d = fresh()
    const m = createConfig({
      kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1',
      apiKey: 'sk-img-only', modelId: 'my-editor', alias: '乙',
    }, USER, d)
    activateConfig({ kind: 'image', id: m.id }, USER, d)

    const c = resolveClients(USER, d)
    expect(c.image.apiKey).toBe('sk-img-only')
    expect(c.chat.apiKey).toBe(CONFIG.chat.apiKey)
  })

  it('★ 两边都配了 → 各走各的，绝不串（§7.4 四条必测里最要紧的一条）', () => {
    const d = fresh()
    const a = createConfig({ kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat', modelId: 'vlm', alias: '甲' }, USER, d)
    const b = createConfig({ kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-img', modelId: 'edit', alias: '乙' }, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    activateConfig({ kind: 'image', id: b.id }, USER, d)

    const c = resolveClients(USER, d)
    expect([c.chat.apiKey, c.chat.baseUrl]).toEqual(['sk-chat', 'https://chat.example.com/v1'])
    expect([c.image.apiKey, c.image.baseUrl]).toEqual(['sk-img', 'https://img.example.com/v1'])
  })

  it('★ 图片的钥匙读不出来（主密钥换过）→ 只有图片回默认，对话不受影响', () => {
    const d = fresh()
    const b = createConfig({ kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-img', modelId: 'edit', alias: '乙' }, USER, d)
    activateConfig({ kind: 'image', id: b.id }, USER, d)

    const broken: ClientDeps = { ...d, vault: createVault('another-secret') }
    const c = resolveClients(USER, broken)
    expect(c.image.apiKey).toBe(CONFIG.image.apiKey)   // 回默认
    expect(c.chat.apiKey).toBe(CONFIG.chat.apiKey)
  })

  it('★ 模型名用的是用户填的那个', () => {
    const d = fresh()
    const a = createConfig({ kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat', modelId: 'my-vlm', alias: '甲' }, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    expect(resolveClients(USER, d).chat.vlmModel).toBe('my-vlm')
  })

  /**
   * ★ 上面六条钉的都是"用户配了的那一条"。这一条盯的是**默认那一份的模型名** ——
   * 2026-10-03 之前这里写的是 `kind === 'chat' ? vlmModel : imageModel`，
   * 写反了上面六条照样全绿，后果是"什么都没配的人，改图走的是看图的模型"。
   * 现在两条通道各带一个 `model`，"串了"这件事由上面第一条（三样一起比）接住；
   * 这里留着是因为**模型名最容易在重构里被漏掉**：地址和钥匙改对了、模型名忘了，
   * 表现是"请求发到了对的家、却点了一个不存在的模型"。
   */
  it('★ 默认那一份：两边各拿自己那个模型名，不能串', () => {
    const c = resolveClients(USER, fresh())
    expect(c.chat.vlmModel).toBe(CONFIG.chat.model)
    expect(c.image.imageModel).toBe(CONFIG.image.model)
  })

  /**
   * ★ 上面六条走的都是**默认工厂**，所以它们对"工厂到底有没有被用上"一个字都没说 ——
   * 把 `clientFactory` 那一行删掉，它们照样全绿。而那个口子正是 Task 7 用来
   * 注入假客户端、检查出站请求的口子（"两套钥匙绝不串"那几条断言全靠它）。
   * 所以这一条单独钉住"注入真的生效"：看不见 seen 非空，就等于没有这个口子。
   */
  it('★ 注入的 clientFactory 真的被用上 —— 两个类别各拿一条连接', () => {
    const d = fresh()
    const a = createConfig({ kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat', modelId: 'my-vlm', alias: '甲' }, USER, d)
    const b = createConfig({ kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-img', modelId: 'my-editor', alias: '乙' }, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    activateConfig({ kind: 'image', id: b.id }, USER, d)

    const seen: ModelConnection[] = []
    const c = resolveClients(USER, {
      ...d,
      clientFactory: (conn) => { seen.push(conn); return new SenseNovaClient(conn) },
    })
    // 排序后再比：工厂的调用顺序是巧合，两条连接本身才是要钉的东西。
    expect(seen.map(x => `${x.apiKey}@${x.modelId}`).sort())
      .toEqual(['sk-chat@my-vlm', 'sk-img@my-editor'])
    expect(c.chat.vlmModel).toBe('my-vlm')
    expect(c.image.imageModel).toBe('my-editor')
  })
})
