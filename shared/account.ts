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

export function checkUsername(raw: string): Check {
  const v = raw.trim().toLowerCase()
  if (v.length === 0) return { ok: false, message: '起个名字吧' }
  const n = charLen(v)
  // 下限是 2 不是 3：英文网站常写 3（"ab" 这种两字母看着像垃圾号），但中文里
  // **两个字的名字太常见**（小明、阿宝、李雷），按 3 个卡他们会直接注册不了。
  if (n < USERNAME_MIN) return { ok: false, message: `名字至少 ${USERNAME_MIN} 个字` }
  if (n > USERNAME_MAX) return { ok: false, message: `名字最多 ${USERNAME_MAX} 个字` }
  // 中文、字母、数字、下划线。**空格和符号不收** —— 空格开头结尾会让人看不出区别，
  // 符号则是纯给冒充留余地（"官方客服★"）
  if (!/^[一-龥a-z0-9_]+$/.test(v)) {
    return { ok: false, message: '只能用中文、字母、数字和下划线' }
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
  // 拿**原始输入**去比**库里的名字**，所以要把密码这边折成小写：名字传进来时
  // 已经是 `checkUsername` 归一过的小写（Task 5 传的就是 `u.value`），
  // 而密码是用户原样敲的。只差大小写也算一样 —— 否则把名字换个大小写就等于没设防。
  if (username !== undefined && raw.toLowerCase() === username) {
    return { ok: false, message: '密码不能和名字一样' }
  }
  return { ok: true, value: raw }
}
