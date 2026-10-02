import { describe, it, expect } from 'vitest'
import { isPrivateHostname, assertModelHostAllowed } from './hostGuard.ts'

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
