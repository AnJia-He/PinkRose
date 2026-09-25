import { describe, it, expect } from 'vitest'
import { checkUsername, checkEmail, checkPassword, normalizeUsername, USERNAME_MIN } from './account.ts'

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

  it('汉字按 Unicode 的 Unified_Ideograph（表意文字本体）收 —— 既不是码点范围，也不是更宽的 Han 脚本', () => {
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
    // 收进 Unified_Ideograph 之后，charLen 才第一次真的产生可观察差异 ——
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

  it('部首不算汉字 —— 看着一样的"部首名字"不能冒充真名', () => {
    // ⼀(U+2F00 康熙部首) 和 一(U+4E00 汉字) 渲染出来一模一样。
    // `Script=Han` 把两大块部首（U+2E80–U+2EF3、U+2F00–U+2FD5）都算了进来 ——
    // 于是两个看着完全相同的名字能成为两个账号，正是这个文件说要防的那种事。
    expect(checkUsername('⼀明').ok).toBe(false)   // U+2F00 康熙部首「一」
    expect(checkUsername('⺀明').ok).toBe(false)   // U+2E80 CJK 部首补充
    expect(checkUsername('一明').ok).toBe(true)       // U+4E00 真汉字 —— 它必须照收
  })

  it('〇 收、々 不收 —— 两个都拍过板了，不再是待定', () => {
    // ⚠️ 这一条钉的不是"这样最对"，而是"现在就是这样"。
    // 汉字的规则从"`一` 到 `龥` 这个范围"换成 Unified_Ideograph（表意文字本体）时，
    // **顺带**把这两个字符从"能注册"翻成了"不能注册"，而当时**一条测试都没有**。
    // 这个文件开头的规矩是「产品决定被改了就应该是测试红」—— 顺带的副作用不算数，
    // 它得有人在守。
    //
    // ——2026-09-25 用户拍板（DECISIONS.md 的 D0b）。两边的理由都列着：
    // `〇` 是中文正式写法里的零（`二〇二六`），审查判它"收下不花钱"；
    // `々` 是重复号、不是中文人名用字，判它“拒掉无所谓”。
    // 收的那边，成本是**实测过的零**（见 account.ts 那段）：四种 Unicode 规范化都不动它，
    // 整个 BMP+SMP 里也没有任何码点 NFKC 之后会变成它 —— 它**没有同形伙伴**。
    expect(checkUsername('〇〇').ok).toBe(true)    // U+3007 中文的零，`二〇二六` 的那个字
    expect(checkUsername('二〇二六').ok).toBe(true)  // 真实场景：中文正式写法的年份
    expect(checkUsername('佐々木').ok).toBe(false) // U+3005 重复号（佐々木 是日文汉字姓）
  })

  it('光有中点不算名字 —— 两个中点凑够"至少 2 个字"也不行', () => {
    // 实测过：`checkUsername('・・')` 曾经回 `{ok: true, value: '··'}` —— 屏幕上
    // 就是一个纯标点的展示名。中点放行的唯一理由是少数民族全名要用它当分隔
    // （见下一条），那个理由里没有"名字整个都是中点"这一种。
    expect(checkUsername('・・').ok).toBe(false)         // U+00B7 中点 ×2
    expect(checkUsername('・・').ok).toBe(false)   // U+30FB 片假名中点 ×2（折叠之后同上）
    // 带真名字的中点照常放行 —— 防线不许把要保护的东西一起挡掉
    expect(checkUsername('迪丽热巴·迪力木拉提').ok).toBe(true)
  })

  it('保留名不让注册', () => {
    for (const n of ['admin', 'root', 'system', 'administrator', 'ADMIN']) {
      expect(checkUsername(n).ok).toBe(false)
    }
  })

  it('★ 保留名那句提示要把**原因**说出来 —— 用户把它读成了"被人占了"', () => {
    // 2026-09-25，用户在登录页上真撞的：他打了名字 `admin`、密码 `admin123`，
    // 看到提示之后问的是「**是已经有这个账户了吗**？还是提示信息不对？」
    // —— 原话「这个名字**被保留**了，换一个吧」里，他读到的是"被人占了"。
    //
    // 而"被人占了"在这个仓库里是**另一句话**（`server/account.ts` 那句
    // 「这个名字有人用了，换一个吧」，撞上数据库唯一约束才出现）——
    // 两句本来就分得开，问题只出在措辞：单独一个「保留」读不出
    // "被**谁**保留、**为什么**"。
    //
    // 所以这一条钉两件事，对应上面那两个问题：
    //   ① **不许再说「被保留」** —— 那正是被读成"被占"的那两个字；
    //   ② **必须说出「官方」** —— 原因不说出来，用户还是只能猜
    //      （换成「不能注册」「不行」之类都过不了这一条）。
    // 变异：把 message 改回原句 → 这一条红（第 ① 句先撞上）；
    //      改成「这个名字不能注册，换一个吧」→ 红在第 ② 句。
    const r = checkUsername('admin')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).not.toContain('被保留')
      expect(r.message).toContain('官方')
    }
  })

  it('失败时 message 是给人看的中文', () => {
    // 输入用 'a-b' 而不是 '!'：'!' 只有 1 个字符，**栽在长度那条检查上**，
    // 根本走不到字符类那条分支 —— 那条 message 于是永远没被测过。
    // 'a-b' 是 3 个字符，越过长度、正好栽在字符类上（正是它名字说的那个分支）。
    const r = checkUsername('a-b')
    expect(r.ok).toBe(false)
    // 只断言「非空」是抓不住东西的：任何字符串都能过，包括 'invalid' 和一段英文堆栈。
    // 这个项目被这类「没在测它名字说的东西」的测试咬过两次，所以这里真的验「是中文」。
    if (!r.ok) expect(/[\u4E00-\u9FFF]/.test(r.message)).toBe(true)
  })

  it('USERNAME_MIN 就是 2 —— 改大了「小明」就注册不了', () => {
    expect(USERNAME_MIN).toBe(2)
  })
})

describe('normalizeUsername', () => {
  it('★ 只做归一化，一条规矩都不带 —— 登录那条路就靠它', () => {
    // 2026-09-25 从 `checkUsername` 里抽出来的（抽出来本身是纯重构，
    // 上面那批断言负责证明"行为一个字节都没变"）。为什么它得单独存在：
    // **登录要的是"用户说的是哪个名字"，不是"这个名字合不合规矩"** ——
    // 用户已经有一个号了，他要问的是"我能不能进去"。
    //
    // 所以它必须**照收** checkUsername 会拒掉的那些：`admin` 是保留名、
    // `a-b` 带符号、`!` 太短 —— 这些在登录页上被拦就是答非所问
    // （2026-09-25 用户真撞过：登录时被告知"这个名字是留给官方账号的"）。
    // 变异：去掉 `.toLowerCase()` / `foldMiddleDot` / `.trim()` 任意一处 → 这一条红。
    expect(normalizeUsername('  Admin  ')).toBe('admin')
    expect(normalizeUsername('a-b')).toBe('a-b')
    expect(normalizeUsername('!')).toBe('!')
    expect(normalizeUsername('尼格买提・热合曼')).toBe('尼格买提·热合曼')
    expect(normalizeUsername('')).toBe('')
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

  it('username 传 null 时不能抛 —— JSON 里没填就是 null', () => {
    // `null !== undefined` 为真，所以 `username !== undefined` 那种守卫挡不住它，
    // 会一路走到 `null.toLowerCase()` 抛出去 —— 把「校验失败」变成 500。
    // 同一个形状 Task 2 已经修过一次（verifyPassword 对非字符串的 stored）。
    expect(checkPassword('long-enough', null as unknown as string).ok).toBe(true)
  })

  it('密码里的中点也要折 —— 看着和名字一模一样的密码不算过关', () => {
    // 名字里的中点折过了，密码这边不折，就能用一个视觉上完全相同的密码绕过去
    expect(checkPassword('尼格买提・热合曼', '尼格买提·热合曼').ok).toBe(false)
  })

  it('超长不行（防被人拿它当 DoS）', () => {
    expect(checkPassword('a'.repeat(129)).ok).toBe(false)
  })
})
