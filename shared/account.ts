/**
 * 账号的格式规则。**前后端共用** —— 前端要一边打一边提示，后端要再验一遍
 * （前端那遍是体验，后端那遍才是规矩：请求可以伪造）。
 *
 * 为什么只留一份：这两遍一定会漂 —— 前端松、后端紧，用户会看到"输的时候说没问题，
 * 一提交被拒"；反过来则是页面上的提示形同虚设。漂了之后没人会发现，因为两边各自
 * 都"看起来对"。所以规则只能有一个来源，就是这里。
 */

export const USERNAME_MIN = 2
export const USERNAME_MAX = 20
export const EMAIL_MAX = 254
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128

/**
 * 不让注册的名字。
 *
 * 不是为了防谁攻击，是为了**防冒充** —— 有个用户叫 "admin"，别人会以为他是官方。
 */
export const RESERVED_USERNAMES: readonly string[] = [
  'admin', 'administrator', 'root', 'system', 'official', 'ruixing', 'support', 'help',
]

export type Check =
  | { ok: true; value: string }
  | { ok: false; message: string }

/**
 * ⚠️ 名字长度按**字符数**算（`[...raw].length`），不是 `.length`。
 * JS 的 `.length` 数的是 UTF-16 码元，emoji 和部分汉字会算成 2，于是
 * 一个 emoji 就"占两个位置"，规则会变得莫名其妙。
 */
const charLen = (s: string): number => [...s].length

/**
 * `·` 的几个"看起来一模一样"的码点。
 *
 * 中文名字里该用的是 U+00B7（MIDDLE DOT），但输入法和复制粘贴常给出
 * U+30FB（片假名中点）、U+2027（连字点）—— 人眼分不出来。
 * 折成同一个的理由和大小写不敏感同源：不折的话，`尼格买提·热合曼` 和它的
 * U+30FB 版本会是**两个看着完全一样的账号**，冒充就有了空子。
 *
 * 这里刻意写成 `\u` 转义而不是字面量：这几个字符印出来一模一样，
 * 靠眼睛核对源码是核不出对错的，只有转义能让"到底是哪个码点"一眼可见。
 */
const MIDDLE_DOT = '\u00B7'
const MIDDLE_DOT_ALIASES = /[\u30FB\u2027]/g
const foldMiddleDot = (s: string): string => s.replace(MIDDLE_DOT_ALIASES, MIDDLE_DOT)

export function checkUsername(raw: string): Check {
  const v = foldMiddleDot(raw.trim().toLowerCase())
  if (v.length === 0) return { ok: false, message: '起个名字吧' }
  const n = charLen(v)
  // 下限是 2 不是 3：英文网站常写 3（"ab" 这种两字母看着像垃圾号），但中文里
  // **两个字的名字太常见**（小明、阿宝、李雷），按 3 个卡他们会直接注册不了。
  if (n < USERNAME_MIN) return { ok: false, message: `名字至少 ${USERNAME_MIN} 个字` }
  if (n > USERNAME_MAX) return { ok: false, message: `名字最多 ${USERNAME_MAX} 个字` }
  // 中文按 **Unicode 的 Unified_Ideograph** 判 —— 也就是"表意文字本体"，
  // 不是码点范围，也不是更宽的 `Script=Han`。
  // 范围写法（曾经是 U+4E00–U+9FA5）会拒掉**合法汉字**：`龥` 之上还有整个
  // CJK 基本区（到 U+9FFF）、扩展 A~H、以及兼容汉字，全是真名用字
  // （U+9FA6、U+4DAE、U+20BB7、U+FA0E…）—— 被拒的人看到"只能用中文"，
  // 等于被告知自己的名字不是中文。这跟上面「下限 2 不是 3」是**同一个形状的错误**。
  // 而 `Script=Han` 又**太宽**：它把**康熙部首**（U+2F00–U+2FD5）和 **CJK 部首补充**
  // （U+2E80–U+2EF3）也算进来，那些是基本区汉字的**同形字** —— 部首 U+2F00 和
  // 汉字 U+4E00 渲染出来一模一样，两个看着完全相同的名字就能变成两个账号。
  // 那正是下面这句要防的事，也是 foldMiddleDot 要防的事。
  // `Unified_Ideograph` 恰好把这两块排在外面；顺带还排掉了 U+F900 那一批兼容表意文字
  // （它们是基本区汉字的**规范等价重复码点** —— 同一种洞，不是另一种）。
  // **空格和符号不收** —— 空格开头结尾会让人看不出区别，符号则是纯给冒充留余地（"官方客服★"）。
  // 中点 `·` 是唯一放行的"符号"：它是少数民族名字的一部分，不是装饰（见 foldMiddleDot）。
  // `u` 标志是必须的 —— `\p{...}` 没有 `u` 直接是语法错误。
  if (!/^[\p{Unified_Ideograph}a-z0-9_\u00B7]+$/u.test(v)) {
    return { ok: false, message: '只能用中文、字母、数字、下划线和 ·' }
  }
  if (RESERVED_USERNAMES.includes(v)) {
    return { ok: false, message: '这个名字被保留了，换一个吧' }
  }
  return { ok: true, value: v }
}

export function checkEmail(raw: string): Check {
  const v = raw.trim().toLowerCase()
  if (v.length === 0) return { ok: false, message: '填个邮箱吧，忘记密码时要靠它' }
  if (v.length > EMAIL_MAX) return { ok: false, message: '邮箱太长了' }
  // 故意写得宽松：邮箱的真实规则复杂到没人实现对，而严格规则会把合法邮箱挡在外面。
  // 真正证明"这个邮箱是他的"靠第三段的验证邮件，不靠这里的正则。
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) {
    return { ok: false, message: '这个邮箱看起来不对' }
  }
  return { ok: true, value: v }
}

export function checkPassword(raw: string, username?: string): Check {
  if (raw.length === 0) return { ok: false, message: '设个密码吧' }
  if (charLen(raw) < PASSWORD_MIN) return { ok: false, message: `密码至少 ${PASSWORD_MIN} 位` }
  if (raw.length > PASSWORD_MAX) return { ok: false, message: `密码最多 ${PASSWORD_MAX} 位` }
  // **不强制大写/数字/符号。** 强制会逼出 Password1! 这种更好猜的密码 ——
  // 现在公认的做法是够长就行。中文、空格、符号都允许，它们只会让密码更强。
  // "不能和名字一样"这条**两边都**做两件事：折小写、折中点。
  // 折小写：名字在库里存的本来必然是小写（`checkUsername` 的 value 已归一，
  //   Task 5 传的就是 `u.value`），而密码是用户原样敲的。
  // 折中点：名字里的 `·` 已经折过了，密码这边不折的话，
  //   一个**看起来和名字一模一样**的密码（只是中点用了 U+30FB）就能绕过这条规则。
  // 对正确调用方这两件事都是空操作 —— 它是一张**给粗心调用方的网**：
  // 传进来没归一化的名字时，只折一边会让这条规则**悄悄失效**，
  // 而且失效得毫无动静（不报错、不红），比大声挂掉难查得多。
  // 守卫用 `typeof username === 'string'`，不是 `username !== undefined`：
  // **`null` 也是"没填"**，而 `null !== undefined` 为真 —— 那样会一路走到
  // `null.toLowerCase()` 抛出去，把「校验失败」变成 500。
  // 这个形状在 Task 2 已经修过一次（verifyPassword 对非字符串的 stored），别再来第三次。
  if (typeof username === 'string') {
    const name = foldMiddleDot(username).toLowerCase()
    if (foldMiddleDot(raw).toLowerCase() === name) {
      return { ok: false, message: '密码不能和名字一样' }
    }
  }
  // ⚠️ 折叠**只用在比较上**：返回值仍然是 `raw` 原文。
  // 密码是要拿去哈希的，顺手"归一化"一下会让用户下次照原样输就登不上。
  return { ok: true, value: raw }
}
