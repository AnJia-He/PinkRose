import { describe, it, expect } from 'vitest'
import { checkUsername, checkEmail, checkPassword, USERNAME_MIN } from './account.ts'

/**
 * 账号格式规则的测试。这一份刻意不测"实现长什么样"，只测**规矩本身** ——
 * 每条断言背后都对应一个真实会发生的用户，或者一次真实会被利用的冒充：
 * 「小明」是两字中文名的日常、「Zhang → zhang」防的是同名冒充、
 * 「不强制符号」防的是被规则逼出来的 `Password1!`。
 * 所以几个关键数字（`USERNAME_MIN` 就是 2、密码就是 8）在这里是**写死的**：
 * 它们不是实现细节，是产品决定，被改了就应该是测试红，而不是测试跟着改。
 */

describe('checkUsername', () => {
  it('两个汉字可以 —— 中文两个字的名字太常见了', () => {
    expect(checkUsername('小明')).toEqual({ ok: true, value: '小明' })
  })

  it('一个字不行', () => {
    expect(checkUsername('李').ok).toBe(false)
  })

  it('21 个字不行', () => {
    expect(checkUsername('a'.repeat(21)).ok).toBe(false)
  })

  it('大写转小写 —— Zhang 和 zhang 得算同一个，防冒充', () => {
    expect(checkUsername('Zhang')).toEqual({ ok: true, value: 'zhang' })
  })

  it('前后空白去掉', () => {
    expect(checkUsername('  abc  ')).toEqual({ ok: true, value: 'abc' })
  })

  it('中文、字母、数字、下划线可以；空格和符号不行', () => {
    expect(checkUsername('小_明2').ok).toBe(true)
    expect(checkUsername('小 明').ok).toBe(false)
    expect(checkUsername('a-b').ok).toBe(false)
    expect(checkUsername('a@b').ok).toBe(false)
    expect(checkUsername('a😀').ok).toBe(false)
  })

  it('保留名不让注册', () => {
    for (const n of ['admin', 'root', 'system', 'administrator', 'ADMIN']) {
      expect(checkUsername(n).ok).toBe(false)
    }
  })

  it('失败时 message 是给人看的中文', () => {
    const r = checkUsername('!')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0)
  })

  it('USERNAME_MIN 就是 2 —— 改大了「小明」就注册不了', () => {
    expect(USERNAME_MIN).toBe(2)
  })
})

describe('checkEmail', () => {
  it('正常邮箱可以，转小写', () => {
    expect(checkEmail('  A@B.COM ')).toEqual({ ok: true, value: 'a@b.com' })
  })
  it('缺 @ 或点不行', () => {
    expect(checkEmail('abc').ok).toBe(false)
    expect(checkEmail('a@b').ok).toBe(false)
    expect(checkEmail('@b.com').ok).toBe(false)
    expect(checkEmail('a@.com').ok).toBe(false)
  })
  it('太长不行', () => {
    expect(checkEmail('a'.repeat(250) + '@b.com').ok).toBe(false)
  })
})

describe('checkPassword', () => {
  it('八位可以，七位不行', () => {
    expect(checkPassword('12345678').ok).toBe(true)
    expect(checkPassword('1234567').ok).toBe(false)
  })

  it('不强制大写数字符号 —— 强制会逼出 Password1! 这种更好猜的', () => {
    expect(checkPassword('aaaaaaaa').ok).toBe(true)
    expect(checkPassword('我的密码我的密码').ok).toBe(true)
    expect(checkPassword('有 空格 !@#').ok).toBe(true)
  })

  it('不能和用户名一样', () => {
    expect(checkPassword('same-name-1', 'same-name-1').ok).toBe(false)
    expect(checkPassword('other-name', 'same-name-1').ok).toBe(true)
    // 名字传进来的样子**就是它在库里的样子**：`checkUsername` 的 value 已经小写过了。
    // 而密码这边是**用户原样敲的输入** —— 所以「只差大小写」也得算一样，
    // 否则 Same-Name-1 这种等于把名字抄了一遍、只换个大小写就能过。
    expect(checkPassword('Same-Name-1', 'same-name-1').ok).toBe(false)
  })

  it('超长不行（防被人拿它当 DoS）', () => {
    expect(checkPassword('a'.repeat(129)).ok).toBe(false)
  })
})
