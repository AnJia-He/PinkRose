import { describe, expect, it } from 'vitest'
import { createVault } from './keyvault.ts'

const SECRET = 'test-secret-not-the-real-one'
const KEY = 'sk-abcdefghijklmnop-4f2'

describe('keyvault', () => {
  it('封进去再打开，拿到原文', () => {
    const v = createVault(SECRET)
    expect(v.open(v.seal(KEY)).plaintext).toBe(KEY)
  })

  it('★ 密文里不许出现原文 —— 这一条是整件事的意义', () => {
    const v = createVault(SECRET)
    const sealed = v.seal(KEY)
    expect(sealed).not.toContain(KEY)
    // 也不许出现原文的任何一段（防止"只加密了一半"这种半吊子）
    expect(sealed).not.toContain('abcdefghij')
    expect(sealed).not.toContain('4f2')
  })

  it('★ 同一把钥匙封两次，密文必须不一样 —— 随机 IV', () => {
    // 固定 IV 的后果：同明文→同密文，等于告诉看库的人「这两个用户用的是同一把钥匙」。
    // （LibreChat 的用户钥匙走的正是这条固定 IV 的老路，它自己代码里有随机 IV 的新版没用上。）
    const v = createVault(SECRET)
    expect(v.seal(KEY)).not.toBe(v.seal(KEY))
  })

  it('★ 密文被改一个字节 → authentic 为假，而且不抛', () => {
    const v = createVault(SECRET)
    const sealed = v.seal(KEY)
    // 翻最后一个 hex 字符（在 data 段里）
    const last = sealed.slice(-1)
    const flipped = sealed.slice(0, -1) + (last === '0' ? '1' : '0')
    const r = v.open(flipped)
    expect(r.authentic).toBe(false)
    expect(r.plaintext).toBe('')
  })

  it('★ 换一把主钥匙 → 打不开，authentic 为假', () => {
    const sealed = createVault(SECRET).seal(KEY)
    const r = createVault('a-completely-different-secret').open(sealed)
    expect(r.authentic).toBe(false)
    expect(r.plaintext).toBe('')
  })

  it('换主钥匙「打不开」这一条不会把接口变成 500 —— open 永不抛', () => {
    const v = createVault(SECRET)
    // 畸形输入：空串、乱码、前缀不对、段数不对、hex 不合法
    for (const bad of ['', 'garbage', 'v1:aa:bb', 'v2:aa:bb:cc', 'v1:zz:zz:zz', 'v1:00:00:00']) {
      expect(() => v.open(bad)).not.toThrow()
      expect(v.open(bad).authentic).toBe(false)
    }
  })

  it('空串也能封能开（钥匙理论上不该是空串，但工具本身不该有特例）', () => {
    const v = createVault(SECRET)
    expect(v.open(v.seal('')).plaintext).toBe('')
  })

  it('中文 / 长串 / emoji 都过得去', () => {
    const v = createVault(SECRET)
    for (const s of ['中文钥匙🔑', 'x'.repeat(5000), 'sk-带空格 和\n换行']) {
      expect(v.open(v.seal(s)).plaintext).toBe(s)
    }
  })
})
