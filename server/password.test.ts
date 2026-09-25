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
    for (const bad of [
      '', 'garbage', 'scrypt$1$2$3', 'md5$a$b$c$d',
      // 六段齐全、只是哈希那段是空的。**这一条和上面四条走的不是同一条路**：
      // 上面四条连"段数对不对"这关都过不了，根本到不了 base64 解码那一步，
      // 于是守在后头那道空值判断一直没人碰过。而它守的是真的东西 ——
      // 少了它，keylen 会算成 0、两边都是空 buffer、timingSafeEqual 直接判相等，
      // 于是拿任意密码就能"登录"一条空哈希记录。
      'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$',
    ]) {
      expect(verifyPassword('x', bad)).toBe(false)
    }
  })

  it('stored 不是字符串也不抛 —— 运行时那道边界不归签名管', () => {
    // 签名写着 string，但 Node 的 TS 剥离模式运行时不验任何东西，
    // 而 verifyPassword 真正被调用的地方就是"把 password_hash 从数据库读出来"
    // 这个无类型的边界。这里不过关的话，一条被改坏的记录会让整个登录接口抛。
    expect(verifyPassword('x', null as unknown as string)).toBe(false)
    expect(verifyPassword('x', undefined as unknown as string)).toBe(false)
  })
})
