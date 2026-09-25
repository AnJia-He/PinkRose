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

  it('汉字按 Unicode 的 Han 脚本收，不是码点范围 —— 真名不该被范围挡在外面', () => {
    // 这几个都是「合法的汉字却被拒」：旧的范围（U+4E00–U+9FA5）只到 U+9FA5，
    // 再往上全是真名用字 —— 而汉字并不止于那一个码点。
    // 被它拒掉的人看到的是「只能用中文、字母、数字和下划线」——
    // 等于被告知「你的名字不是中文」。
    expect(checkUsername('龦明').ok).toBe(true)   // \u9FA6，就在 CJK 基本区里，只排在 U+9FA5 之上
    expect(checkUsername('䶮明').ok).toBe(true)   // \u4DAE，扩展 A，龑 的简化形，人名用字
    expect(checkUsername('𠮷明').ok).toBe(true)  // \u20BB7，扩展 B
    expect(checkUsername('𪚥明').ok).toBe(true)  // \u2A6A5，扩展 B
  })

  it('长度按字符数算，扩展区汉字也算一个字 —— 否则真名会被长度卡掉', () => {
    // 11 个 𠮷：按字符数是 11（合规），按 UTF-16 码元是 22（会被上限 20 拒）。
    // 收进 Han 脚本之后，charLen 才第一次真的产生可观察差异 ——
    // 在这之前它其实一直没被任何一条测试咬到。
    expect(checkUsername('𠮷'.repeat(11)).ok).toBe(true)
  })

  it('名字里的中点不是符号 —— 少数民族全名能注册', () => {
    expect(checkUsername('迪丽热巴·迪力木拉提')).toEqual({ ok: true, value: '迪丽热巴·迪力木拉提' })
  })

  it('三个长得一样的中点折成一个 —— 不然两个看着相同的名字会变成两个账号', () => {
    const canonical = '尼格买提·热合曼'
    expect(checkUsername('尼格买提・热合曼')).toEqual({ ok: true, value: canonical })   // \u30FB 片假名中点
    expect(checkUsername('尼格买提‧热合曼')).toEqual({ ok: true, value: canonical })   // \u2027 连字点
  })

  it('保留名不让注册', () => {
    for (const n of ['admin', 'root', 'system', 'administrator', 'ADMIN']) {
      expect(checkUsername(n).ok).toBe(false)
    }
  })

  it('失败时 message 是给人看的中文', () => {
    const r = checkUsername('!')
    expect(r.ok).toBe(false)
    // 只断言「非空」是抓不住东西的：任何字符串都能过，包括 'invalid' 和一段英文堆栈。
    // 这个项目被这类「没在测它名字说的东西」的测试咬过两次，所以这里真的验「是中文」。
    if (!r.ok) expect(/[\u4E00-\u9FFF]/.test(r.message)).toBe(true)
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
    // 名字在库里存的**必然**是小写，所以传进来一个没归一化的名字也必须挡住 ——
    // 只折一边的话，错在这一侧的调用方会让这条规则**悄悄失效**（不报错、不红，最难查）。
    expect(checkPassword('Other-Name', 'Other-Name').ok).toBe(false)
  })

  it('超长不行（防被人拿它当 DoS）', () => {
    expect(checkPassword('a'.repeat(129)).ok).toBe(false)
  })
})
