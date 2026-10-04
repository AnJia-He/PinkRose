import { describe, it, expect } from 'vitest'
import { isPrivateHostname, assertModelHostAllowed, assertResolvedHostAllowed } from './hostGuard.ts'

/**
 * ★ 2026-10-02 补的（安全审计 S1）。之前 `normalizeBaseUrl` 只要求
 *   "主机名里得有个点"，于是 **127.0.0.1 / 169.254.169.254 / 10.x / 192.168.x
 *   全部放行** —— 实测过，整套出站接口就是一个可以扫内网的跳板。
 */
describe('isPrivateHostname', () => {
  const PRIVATE = [
    '127.0.0.1', '127.1.2.3',           // 回环
    '10.0.0.1', '172.16.5.5', '172.31.255.1', '192.168.1.50',  // 私有段
    '169.254.169.254',                  // 链路本地（云 metadata 就在这儿）
    '100.64.0.1', '100.127.255.255',    // CGNAT
    '0.0.0.0', '0.1.2.3',
    'localhost', 'a.localhost', 'redis.internal', 'metadata.google.internal',
    '[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]',
    '[::ffff:127.0.0.1]', '[::ffff:7f00:1]',
  ]
  it.each(PRIVATE)('%s 是内网', (h) => {
    expect(isPrivateHostname(h)).toBe(true)
  })

  const PUBLIC = [
    'api.deepseek.com', 'token.sensenova.cn', '8.8.8.8',
    '172.15.0.1', '172.32.0.1',         // 私有段的**外面**，别误伤
    '11.0.0.1', '126.0.0.1', '128.0.0.1',
    '100.63.0.1', '100.128.0.1',        // CGNAT 的两侧
    '[2606:4700::1111]',                // Cloudflare 的 v6
    'notinternal.example',
  ]
  it.each(PUBLIC)('%s 不是内网', (h) => {
    expect(isPrivateHostname(h)).toBe(false)
  })
})

describe('assertModelHostAllowed', () => {
  it('内网地址：默认拒绝，而且那句话要说清为什么、怎么解开', () => {
    expect(() => assertModelHostAllowed('http://127.0.0.1:11434/v1', {}))
      .toThrow(/内网/)
  })

  it('公网地址照常放行', () => {
    expect(() => assertModelHostAllowed('https://api.deepseek.com/v1', {})).not.toThrow()
    expect(() => assertModelHostAllowed('http://8.8.8.8/v1', {})).not.toThrow()
  })

  it('★ 自建服务（Ollama 那一类）要**显式**开关才放行 —— 默认关死', () => {
    // 这条是取舍：默认关死会挡住自建服务，但那是一个"少一个功能"的代价，
    // 而默认放行是"任何人注册一个号就能拿我们当跳板扫内网"。谁更贵很清楚。
    expect(() => assertModelHostAllowed('http://127.0.0.1:11434/v1', {})).toThrow()
    expect(() => assertModelHostAllowed('http://127.0.0.1:11434/v1', { ALLOW_PRIVATE_MODEL_HOSTS: '1' })).not.toThrow()
  })

  it('开关只认 "1" —— 写成 0/false/空都要当没开', () => {
    for (const v of ['0', 'false', '', 'no', 'true']) {
      expect(() => assertModelHostAllowed('http://10.0.0.1/v1', { ALLOW_PRIVATE_MODEL_HOSTS: v }))
        .toThrow()
    }
  })

  it('解析不出主机名的（不是网址）也拒绝', () => {
    expect(() => assertModelHostAllowed('不是网址', {})).toThrow()
  })
})

/**
 * ★ 2026-10-04 补的一层。上面那条只认**字面量**，而**公共通配 DNS** 能把任意
 *   内网地址包装成"看着完全正常"的域名：`127.0.0.1.nip.io` / `10.0.0.1.sslip.io`
 *   —— 免费、开箱即用（本机实测三个全中）。所以真正发请求前要按**解析出来的
 *   IP** 再判一次。这一组用例全部注入假 lookup，不碰真 DNS。
 */
describe('assertResolvedHostAllowed（按解析出的 IP 再判一次）', () => {
  const PUBLIC_IP = '93.184.216.34'

  it('★ 域名看着正常、解析到内网 → 拒（nip.io 那一类，原来就是从这儿绕的）', async () => {
    await expect(
      assertResolvedHostAllowed('https://looks-fine.example.test/v1', {
        lookup: async () => ['127.0.0.1'],
      }),
    ).rejects.toThrow(/内网/)
  })

  it('★ 解析出多条、只要有一条是内网就拒 —— 不能只看第一条', async () => {
    await expect(
      assertResolvedHostAllowed('https://mixed.example.test/v1', {
        lookup: async () => [PUBLIC_IP, '10.0.0.5'],
      }),
    ).rejects.toThrow(/内网/)
  })

  it('★ 解析出内网 IPv6（DNS 返回不带方括号）→ 也拒', async () => {
    // 方括号是 URL 的形状，不是 DNS 的形状 —— 漏了归一化这条会静默放行。
    await expect(
      assertResolvedHostAllowed('https://v6.example.test/v1', {
        lookup: async () => ['fd00::1'],
      }),
    ).rejects.toThrow(/内网/)
  })

  it('解析到公网 → 放行', async () => {
    await expect(
      assertResolvedHostAllowed('https://api.deepseek.com/v1', {
        lookup: async () => [PUBLIC_IP],
      }),
    ).resolves.toBeUndefined()
  })

  it('★ 解析不出来就放行 —— 打错字是常事，让真正的请求去报它自己的错', async () => {
    await expect(
      assertResolvedHostAllowed('https://nowhere.example.test/v1', {
        lookup: async () => { throw new Error('ENOTFOUND') },
      }),
    ).resolves.toBeUndefined()
  })

  it('字面量内网：直接拒，**DNS 一次都不查**', async () => {
    let called = 0
    await expect(
      assertResolvedHostAllowed('http://127.0.0.1:11434/v1', {
        lookup: async () => { called++; return [PUBLIC_IP] },
      }),
    ).rejects.toThrow(/内网/)
    expect(called).toBe(0)
  })

  it('开关打开（ALLOW_PRIVATE_MODEL_HOSTS=1）→ 放行，且不查 DNS', async () => {
    let called = 0
    await expect(
      assertResolvedHostAllowed('http://127.0.0.1:11434/v1', {
        env: { ALLOW_PRIVATE_MODEL_HOSTS: '1' },
        lookup: async () => { called++; return ['127.0.0.1'] },
      }),
    ).resolves.toBeUndefined()
    expect(called).toBe(0)
  })

  it('不是网址 → 拒', async () => {
    await expect(
      assertResolvedHostAllowed('不是网址', { lookup: async () => [PUBLIC_IP] }),
    ).rejects.toThrow(/网址/)
  })
})
