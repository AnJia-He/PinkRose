import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password.ts'

describe('password', () => {
  it('哈希里不含明文', () => {
    const h = hashPassword('my-secret-pw')
    expect(h).not.toContain('my-secret-pw')
  })

  it('同一个密码两次哈希结果不同（盐是随机的）', () => {
    expect(hashPassword('same-pw-1234')).not.toBe(hashPassword('same-pw-1234'))
  })

  it('对得上就是 true，对不上就是 false', () => {
    const h = hashPassword('correct-horse')
    expect(verifyPassword('correct-horse', h)).toBe(true)
    expect(verifyPassword('correct-horsf', h)).toBe(false)
    expect(verifyPassword('', h)).toBe(false)
  })

  it('中文密码、空格、符号都支持', () => {
    const h = hashPassword('我的密码 有空格!@#')
    expect(verifyPassword('我的密码 有空格!@#', h)).toBe(true)
  })

  it('存坏的哈希不抛异常，只返回 false', () => {
    // 数据库被手工改坏、或者格式换了代，都不能让登录接口 500
    for (const bad of ['', 'garbage', 'scrypt$1$2$3', 'md5$a$b$c$d']) {
      expect(verifyPassword('x', bad)).toBe(false)
    }
  })
})
