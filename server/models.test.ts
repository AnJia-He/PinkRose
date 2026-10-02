import { describe, expect, it } from 'vitest'
import { UNREADABLE_KEY_HINT } from '../shared/copy.ts'
import { openDb, type Db } from './db.ts'
import { createVault } from './keyvault.ts'
import {
  activateConfig, createConfig, deleteConfig, listConfigs, maskKey,
  normalizeBaseUrl, resolveSecret, resolveSecretById, updateConfig, type ModelConfigDeps,
} from './models.ts'

const USER = { id: 1, username: 'a', email: 'a@b.c' }
const OTHER = { id: 2, username: 'b', email: 'b@b.c' }

function fresh(): ModelConfigDeps {
  const db: Db = openDb(':memory:')
  for (const u of [USER, OTHER]) {
    db.raw.prepare('INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?,?,?,?,?)')
      .run(u.id, u.username, u.email, 'h', 1)
  }
  return { db, vault: createVault('test-secret'), now: () => 1_700_000_000_000 }
}

const BODY = {
  kind: 'chat', provider: 'custom',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-abcdefghijklmnop-4f2',
  modelId: 'some-vision-model', alias: '我的便宜货',
}

describe('掩盖码', () => {
  it('前 3 后 4', () => {
    // ⚠️ 后 4 个字符是 `-4f2`（分隔符正好落在第 4 位）——
    // 规则是"前 3 后 4"，不是"头尾各取几个好看的字符"。
    expect(maskKey('sk-abcdefghijklmnop-4f2')).toBe('sk-…-4f2')
  })
  it('太短的钥匙不露任何片段', () => {
    // 短钥匙露前 3 后 4 就等于全露了
    expect(maskKey('sk-12345')).toBe('•••••')
  })
})

describe('接口地址归一化', () => {
  it('没有协议的补 https://', () => {
    expect(normalizeBaseUrl('api.example.com/v1')).toBe('https://api.example.com/v1')
  })
  it('★ 误粘了整条对话路径 → 剥回主机名 + /v1', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/chat/completions'))
      .toBe('https://api.example.com/v1')
  })
  it('★ 漏了 /v1 → 补上', () => {
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com/v1')
  })
  it('已经是对的 → 一个字不动', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1')
  })
  it('结尾多余的斜杠去掉', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
  })
  it('★ 带墨迹的（查询串 / 片段 / 内嵌凭据）拒绝，而不是"尽力修"', () => {
    // 这两样是 SSRF 的常见载体，也是用户粘贴错了的信号 ——
    // 猜他想要什么比直接问更贵。
    expect(() => normalizeBaseUrl('https://api.example.com/v1?key=abc')).toThrow()
    expect(() => normalizeBaseUrl('https://api.example.com/v1#x')).toThrow()
    expect(() => normalizeBaseUrl('https://user:pw@api.example.com/v1')).toThrow()
  })
  it('★ 不是 http/https 的拒绝', () => {
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrow()
    expect(() => normalizeBaseUrl('javascript:alert(1)')).toThrow()
  })
  it('空串 / 乱码拒绝', () => {
    expect(() => normalizeBaseUrl('')).toThrow()
    expect(() => normalizeBaseUrl('not a url at all')).toThrow()
  })

  it('★ 内网 / 本机地址一律拒绝（SSRF，2026-10-02 加的）', () => {
    // 加这条之前实测过：下面这些**全部放行**，而用户填的地址会被服务端
    // 拿去发请求 —— 等于任何人注册一个号就能拿这台机器当跳板扫内网。
    for (const url of [
      'http://127.0.0.1:11434/v1',      // 自建 Ollama 那一档（要开开关才放行）
      'http://169.254.169.254/latest',  // 云上的凭据服务
      'http://10.0.0.1/v1',
      'http://172.16.5.5/v1',
      'http://192.168.1.50:8080/v1',
      'http://100.64.0.1/v1',
      'http://0.0.0.0/v1',
      'http://2130706433/v1',           // 十进制的 127.0.0.1，URL 解析器会还原
      'http://[::1]:11434/v1',
      'http://metadata.google.internal/latest',
    ]) {
      expect(() => normalizeBaseUrl(url), url).toThrow()
    }
  })

  it('内网那句提示要说清"为什么"和"怎么解开"（文案规范 5）', () => {
    expect(() => normalizeBaseUrl('http://10.0.0.1/v1')).toThrow(/内网/)
    expect(() => normalizeBaseUrl('http://10.0.0.1/v1')).toThrow(/ALLOW_PRIVATE_MODEL_HOSTS/)
  })

  it('公网地址不受影响', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('http://8.8.8.8/v1')).toBe('http://8.8.8.8/v1')
    expect(normalizeBaseUrl('https://172.15.0.1/v1')).toBe('https://172.15.0.1/v1')
  })
})

describe('增删改查', () => {
  it('建一套，回的是公开形状 —— ★ 里面没有钥匙', () => {
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    expect(c).toEqual({
      id: 1, kind: 'chat', provider: 'custom',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'some-vision-model', alias: '我的便宜货',
      keyHint: 'sk-…-4f2', active: false,
    })
    // 整个 JSON 里不许出现完整钥匙 —— 一个字都不许
    expect(JSON.stringify(c)).not.toContain('abcdefghijklmnop')
  })

  it('★ 库里存的确实是密文，不是明文', () => {
    const d = fresh()
    createConfig(BODY, USER, d)
    const row = d.db.raw.prepare('SELECT api_key_enc FROM model_configs WHERE id = 1')
      .get() as { api_key_enc: string }
    expect(row.api_key_enc).not.toContain('abcdefghijklmnop')
    expect(row.api_key_enc.startsWith('v1:')).toBe(true)
    // 而且是能解回来的（不然就是"存了个打不开的东西"）
    expect(d.vault.open(row.api_key_enc).plaintext).toBe('sk-abcdefghijklmnop-4f2')
  })

  it('★ 列表只回自己的，别人的一套都不许出现', () => {
    const d = fresh()
    createConfig(BODY, USER, d)
    createConfig({ ...BODY, alias: '他的' }, OTHER, d)
    const mine = listConfigs(USER, d)
    expect(mine.configs.map(c => c.alias)).toEqual(['我的便宜货'])
  })

  /**
   * ★ 密文读不出来时，名单里那一行必须**正好是那个占位**（Task 11 补）。
   *
   * 为什么这条值得单独钉：界面那一行是靠 `keyHint === UNREADABLE_KEY_HINT`
   * 这个**字符串相等**认出"这把钥匙废了"的（`src/ui/ModelSettings.tsx`）——
   * 认不出来不会报错，只会让一把坏钥匙长得和正常的一模一样，用户看到的是
   * "保存了却不能用"。而两边的**字面量**收进 `shared/copy.ts` 之后不可能再走岔，
   * 剩下唯一会坏的就是**服务端这个分支本身**（`toPublic` 里那句三目）。
   *
   * 变异：把 `server/models.ts` 的 `opened.authentic ? maskKey(...) : UNREADABLE_KEY_HINT`
   *      改成永远 `maskKey(...)` → 这条红（前端那边先看不出来：它喂的是自己造的
   *      keyHint，正是这条测试补上的那个洞）。
   */
  it('★ 密文读不出来（换了主钥匙）→ 名单里给「读不出来」那个占位，不是一段乱码', () => {
    const d = fresh()
    createConfig(BODY, USER, d)
    // 模拟"SESSION_SECRET 被人换过"：老密文从此打不开（keyvault 的 open 永不抛）
    const broken: ModelConfigDeps = { ...d, vault: createVault('another-secret') }
    expect(listConfigs(USER, broken).configs[0].keyHint).toBe(UNREADABLE_KEY_HINT)
  })

  it('★ 两个 kind 互不串场', () => {
    const d = fresh()
    createConfig(BODY, USER, d)
    createConfig({ ...BODY, kind: 'image', alias: '改图的' }, USER, d)
    const chat = listConfigs(USER, d).configs.filter(c => c.kind === 'chat')
    const image = listConfigs(USER, d).configs.filter(c => c.kind === 'image')
    expect(chat.map(c => c.alias)).toEqual(['我的便宜货'])
    expect(image.map(c => c.alias)).toEqual(['改图的'])
  })

  it('★ 改别人的一套 → 404（不是 403，不给"存在但你没权限"这个信号）', () => {
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    expect(() => updateConfig(c.id, { alias: 'x' }, OTHER, d)).toThrow(/没有/)
    // 而且真的没改
    expect(listConfigs(USER, d).configs[0]!.alias).toBe('我的便宜货')
  })

  it('★ 激活别人的一套 → 404，而且我的指针一点没动', () => {
    const d = fresh()
    const mine = createConfig({ ...BODY, alias: '我的' }, USER, d)
    activateConfig({ kind: 'chat', id: mine.id }, USER, d)
    // 他那一套也得是**真的在用**的 —— 被偷 id 的正是这样一套活着的配置
    const otherCfg = createConfig({ ...BODY, alias: '他的' }, OTHER, d)
    activateConfig({ kind: 'chat', id: otherCfg.id }, OTHER, d)

    expect(() => activateConfig({ kind: 'chat', id: otherCfg.id }, USER, d)).toThrow(/没有/)
    // ★ 光断言抛错是不够的 —— 那句话和"我的指针有没有被换掉"是两件事
    //   （UPDATE 一旦排在 ownRow 前面，错就落不到"抛没抛"上）。
    //   ⚠️ 也别只断言 `resolveSecret(...)` 回 null：那是**空的** ——
    //   就算别人的 id 真被写进我的指针，resolveSecret 自己那道 user_id 也会把它挡成 null。
    expect(listConfigs(USER, d).configs.find(c => c.id === mine.id)!.active).toBe(true)
    expect(resolveSecret('chat', USER, d)?.apiKey).toBe('sk-abcdefghijklmnop-4f2')
  })

  it('★ 删别人的一套 → 404，而且那一套还在', () => {
    const d = fresh()
    const otherCfg = createConfig({ ...BODY, alias: '他的' }, OTHER, d)
    activateConfig({ kind: 'chat', id: otherCfg.id }, OTHER, d)

    expect(() => deleteConfig(otherCfg.id, USER, d)).toThrow(/没有/)
    // 还在，而且**还在用** —— 不是"没抛错就完事"
    expect(listConfigs(OTHER, d).configs.map(c => c.alias)).toEqual(['他的'])
    expect(resolveSecret('chat', OTHER, d)?.apiKey).toBe('sk-abcdefghijklmnop-4f2')
  })

  it('★ 改的一套不给新钥匙 → 老钥匙一个字不动', () => {
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    // 先激活：`resolveSecret` 只认"正在用的那一套"（下面「配了但没激活 → 还是 null」钉的就是它），
    // 不激活的话最后那条断言只会拿到 null，验不到"老钥匙还在"。
    activateConfig({ kind: 'chat', id: c.id }, USER, d)
    const updated = updateConfig(c.id, { alias: '换个名字' }, USER, d)
    expect(updated.alias).toBe('换个名字')
    expect(updated.keyHint).toBe('sk-…-4f2')
    expect(resolveSecret('chat', USER, d)?.apiKey).toBe('sk-abcdefghijklmnop-4f2')
  })

  it('★ 改了接口地址但没给新钥匙 → 拒绝（防止偷到票的人把钥匙转发到自己的服务器）', () => {
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    expect(() => updateConfig(c.id, { baseUrl: 'https://evil.example.com/v1' }, USER, d))
      .toThrow(/重填/)
  })

  it('★ 改接口地址 + 同时给新钥匙 → 可以', () => {
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    // 同上：不激活的话 resolveSecret 回 null，验不到"新钥匙真的换上了"。
    activateConfig({ kind: 'chat', id: c.id }, USER, d)
    const updated = updateConfig(c.id,
      { baseUrl: 'https://other.example.com/v1', apiKey: 'sk-zzzzzzzzzzzzzzzz-999' }, USER, d)
    expect(updated.baseUrl).toBe('https://other.example.com/v1')
    expect(resolveSecret('chat', USER, d)?.apiKey).toBe('sk-zzzzzzzzzzzzzzzz-999')
  })
})

describe('哪一套在用 / 删除的两种行为（§7.4）', () => {
  it('激活一个 → 只有它 active', () => {
    const d = fresh()
    const a = createConfig({ ...BODY, alias: '甲' }, USER, d)
    const b = createConfig({ ...BODY, alias: '乙' }, USER, d)
    activateConfig({ kind: 'chat', id: b.id }, USER, d)
    const list = listConfigs(USER, d).configs
    expect(list.find(c => c.id === a.id)!.active).toBe(false)
    expect(list.find(c => c.id === b.id)!.active).toBe(true)
  })

  it('★ 激活成「默认」是允许的（不然想回默认只能删掉配置）', () => {
    const d = fresh()
    const a = createConfig(BODY, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    activateConfig({ kind: 'chat', id: null }, USER, d)
    expect(listConfigs(USER, d).configs[0]!.active).toBe(false)
    expect(resolveSecret('chat', USER, d)).toBeNull()
  })

  it('★ 删掉「不是在用的」→ 当前在用的那套一点没变', () => {
    const d = fresh()
    const a = createConfig({ ...BODY, alias: '在用的' }, USER, d)
    const b = createConfig({ ...BODY, alias: '不用的' }, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    expect(deleteConfig(b.id, USER, d)).toEqual({ wasActive: false })
    const list = listConfigs(USER, d).configs
    expect(list.map(c => c.alias)).toEqual(['在用的'])
    expect(list[0]!.active).toBe(true)
  })

  it('★ 删掉「正在用的」→ wasActive 为真，而且是回默认', () => {
    const d = fresh()
    const a = createConfig(BODY, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    expect(deleteConfig(a.id, USER, d)).toEqual({ wasActive: true })
    expect(resolveSecret('chat', USER, d)).toBeNull()
  })

  it('★ 删错 kind 那一边不影响另一边（两套彻底分开）', () => {
    const d = fresh()
    const chat = createConfig(BODY, USER, d)
    const image = createConfig({ ...BODY, kind: 'image' }, USER, d)
    activateConfig({ kind: 'chat', id: chat.id }, USER, d)
    activateConfig({ kind: 'image', id: image.id }, USER, d)
    deleteConfig(chat.id, USER, d)
    // 图片那边原封不动
    expect(resolveSecret('image', USER, d)?.modelId).toBe('some-vision-model')
  })
})

describe('取密钥（给"按用户造客户端"用）', () => {
  it('没配 → null（调用方走默认）', () => {
    expect(resolveSecret('chat', USER, fresh())).toBeNull()
  })

  it('配了但没激活 → 还是 null', () => {
    const d = fresh()
    createConfig(BODY, USER, d)
    expect(resolveSecret('chat', USER, d)).toBeNull()
  })

  it('★ 密文读不出来（换了主钥匙）→ null，不抛', () => {
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    activateConfig({ kind: 'chat', id: c.id }, USER, d)
    // 模拟"SESSION_SECRET 被人换过"
    const broken: ModelConfigDeps = { ...d, vault: createVault('another-secret') }
    expect(resolveSecret('chat', USER, broken)).toBeNull()
  })
})

describe('按 id 取密钥（给「测一下」用）', () => {
  it('★ 没激活也能取到 —— 这正是它和 resolveSecret 的区别', () => {
    // 「测一下」测的是**用户点的那一套**，可能还没保存成"在用的那套"。
    // ⚠️ 少了这条，一个"直接转调 resolveSecret"的实现两条负例全绿 ——
    //   而那种实现会让"测一下"永远报"没有这一套设置"。
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    expect(resolveSecret('chat', USER, d)).toBeNull()
    expect(resolveSecretById(c.id, 'chat', USER, d)).toEqual({
      provider: 'custom', baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-abcdefghijklmnop-4f2', modelId: 'some-vision-model',
    })
  })

  it('★ 别人的 id → null（不是抛错、不是 404 —— 和 resolveSecret 同一个处置）', () => {
    const d = fresh()
    const otherCfg = createConfig({ ...BODY, alias: '他的' }, OTHER, d)
    expect(resolveSecretById(otherCfg.id, 'chat', USER, d)).toBeNull()
  })

  it('★ kind 对不上 → null（id 确实是我的，但那是一套图片配置）', () => {
    const d = fresh()
    const img = createConfig({ ...BODY, kind: 'image' }, USER, d)
    expect(resolveSecretById(img.id, 'chat', USER, d)).toBeNull()
  })

  it('★ 密文读不出来（换了主钥匙）→ null，不抛', () => {
    // 和 resolveSecret 同一条：安静地回 null，由调用方回"没有这一套设置"，
    // 而不是把 SESSION_SECRET 被换过这件事变成一次 500。
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    const broken: ModelConfigDeps = { ...d, vault: createVault('another-secret') }
    expect(resolveSecretById(c.id, 'chat', USER, broken)).toBeNull()
  })
})
