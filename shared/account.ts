/**
 * 账号的格式规则。**前后端共用** —— 前端要一边打一边提示，后端要再验一遍
 * （前端那遍是体验，后端那遍才是规矩：请求可以伪造）。
 *
 * 为什么只留一份：这两遍一定会漂 —— 前端松、后端紧，用户会看到"输的时候说没问题，
 * 一提交被拒"；反过来则是页面上的提示形同虚设。漂了之后没人会发现，因为两边各自
 * 都"看起来对"。所以规则只能有一个来源，就是这里。
 */

import { NAME_REQUIRED } from './copy.ts'

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
  'admin', 'administrator', 'root', 'system', 'official', 'pinkrose', 'support', 'help',
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

/**
 * 归一化：把用户打的字折成"这个名字到底是谁"。
 *
 * 三件事，全是"同一个名字的几种写法"，一件都不是规矩：
 * 去掉首尾空白、折成小写、把那几个同形中点折成 `·`（见 foldMiddleDot）。
 *
 * ⚠️ **它和 `checkUsername` 里那些规矩是两件事**，抽出来正是为了这个区分：
 * 这一句回答「用户说的是哪个名字」，后面那些（长度、字符类、保留名）回答
 * 「这个名字能不能拿来开号」。**登录只用得上前一句** —— 用户已经有一个号了，
 * 他问的是"我能不能进去"，不是"这个名字合不合注册的规矩"。
 * 少了归一化，一个已经存在的账号用户照着打都进不去
 * （他打 `Admin`，库里存的是 `admin`）；多了那些规矩，他会在登录页上
 * 收到一句答非所问的话（见 `src/ui/LoginPage.tsx` 里那段，2026-09-25 真撞过）。
 */
export function normalizeUsername(raw: string): string {
  return foldMiddleDot(raw.trim().toLowerCase())
}

export function checkUsername(raw: string): Check {
  const v = normalizeUsername(raw)
  if (v.length === 0) return { ok: false, message: NAME_REQUIRED }
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
  //
  // **`〇`（U+3007）单独放行** —— 它不在 Unified_Ideograph 里（Unicode 类别是 Nl，不是 Lo），
  // 但它是**中文正式写法里的零**（二〇二六），中文输入法打得出来，当展示用昵称很自然。
  // 收它的成本是零，而且是**实测过的零**：四种 Unicode 规范化都不动它，
  // 整个 BMP+SMP 里也没有任何一个码点 NFKC 之后会变成它 —— 也就是说它**没有同形伙伴**，
  // 而「防两个看着一样的账号」正是上面这一大段唯一的理由；最像它的 `0` 和 `O` 本来就放行。
  // 反过来，拒掉它等于告诉一个中国人「二〇二六」不是中文 —— 和上面「下限 2 不是 3」
  // 是**同一个形状的错误**：拿一套“常见范围”去卡别人的真字。
  //
  // **`々`（U+3005）仍然不收** —— 它是“重复前一个字”的符号，不是中文人名用字；
  // 唯一现实场景是日文汉字姓（佐佐木 = 佐々木），而那两个写法本来也不同形。
  // 收与不收**两边都有测试钉着** —— 它俩原本只是换规则时的副作用，光靠注释守不住。
  // `u` 标志是必须的 —— `\p{...}` 没有 `u` 直接是语法错误。
  if (!/^[\p{Unified_Ideograph}〇a-z0-9_\u00B7]+$/u.test(v)) {
    return { ok: false, message: '只能用中文、字母、数字、下划线和 ·' }
  }
  // ★ **至少要有一个非中点的字符** —— 光拿中点凑够"名字至少 2 个字"的不算名字。
  // 中点放行的唯一理由是"少数民族全名要用它当分隔"（见 foldMiddleDot），
  // 而 `・・` 这种名字不在那条理由里：屏幕上就是一个纯标点的展示名，
  // 它干成的唯一一件事是把上面那条长度下限绕过去（两个中点也算 2 个字）。
  // 放在长度和字符类**之后**：这样单独一个 `·` 还是先撞长度那条，
  // 报出来的话更贴近用户真正的问题（他就打了一个字符）。
  // 写成 `[^·]` 而不是再排一遍合法字符：走到这一行的字符串已经过了上面那个
  // 字符类，所以"除了中点之外还有东西吗"就是这一条要问的全部。
  if (!/[^·]/.test(v)) {
    return { ok: false, message: '名字里至少得有一个中文、字母或数字' }
  }
  // ⚠️ 措辞改过一版（2026-09-25，用户在登录页上撞出来的）。
  // 原来是「**这个名字被保留了**，换一个吧」—— 一个真实用户读了之后问的是
  // 「我输的密码是admin123，**是已经有这个账户了吗**？还是提示信息不对？」
  // 也就是说，他把这一句读成了「**这个名字被人占了**」。
  //
  // 两句本来是分得开的：「有人用了」是 **server/account.ts:89** 那句
  // （撞上数据库唯一约束才出现，那是真的被占了）。问题只出在措辞 ——
  // 「保留」单独出现时读不出"**被谁**保留、**为什么**"，而用户遇到的那件事
  // 恰恰要靠这两个问题才能想明白。所以这里把原因说出来：
  // 不是有人占了，是**留给官方的**（理由见上面 RESERVED_USERNAMES 那一段：
  // 防的是冒充，不是攻击）。server 那句**不要跟着改** ——
  // 对"真的撞了唯一约束"那个场景，「有人用了」是准确的。
  //
  // `shared/account.test.ts` 里「保留名那句提示要把**原因**说出来」那一条
  // 钉着这句话的两个要害（不许再说"被保留"、必须说出"官方"）。
  if (RESERVED_USERNAMES.includes(v)) {
    return { ok: false, message: '这个名字是留给官方账号的，换一个吧' }
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
