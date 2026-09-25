import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'rx_session'
export const SESSION_DAYS = 30
/** 离过期不到这么多天就重新签一张，把 30 天推满 */
export const RENEW_WITHIN_DAYS = 15

const DAY_MS = 86400_000

/**
 * 票的内容是 `用户ID.过期时间.签名`。
 *
 * ★ 签名里**掺了当前的密码哈希** —— 这是这一版最省事的一招：
 *
 *   - 用户改了密码 → 数据库里的哈希变了 → 旧票**自己就验不过**
 *   - 于是"改密码 = 所有设备自动下线"成了**签名的性质**
 *   - 也于是：不用建会话表、不用记"哪些票该作废"、不用定时清理
 *
 * 哈希**不在票里**，只在 HMAC 的输入里 —— 票上看得见的仍然只有 ID 和时间。
 */
function sign(userId: number, expiresAt: number, passwordHash: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${userId}.${expiresAt}.${passwordHash}`)
    .digest('base64url')
}

export function signSession(
  userId: number, passwordHash: string, expiresAt: number, secret: string,
): string {
  return `${userId}.${expiresAt}.${sign(userId, expiresAt, passwordHash, secret)}`
}

/**
 * 校验。**任何不对都返回 null，绝不抛。**
 *
 * 票是从网上来的，所以要假设它什么形状都可能 —— 畸形输入只该让这个人
 * 变成"没登录"，不该让接口 500。
 */
export function verifySession(
  token: string, passwordHash: string, nowMs: number, secret: string,
): { userId: number; expiresAt: number } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [rawId, rawExp, sig] = parts as [string, string, string]
  const userId = Number(rawId)
  const expiresAt = Number(rawExp)
  if (!Number.isInteger(userId) || userId <= 0) return null
  if (!Number.isInteger(expiresAt)) return null
  if (expiresAt <= nowMs) return null

  const expected = sign(userId, expiresAt, passwordHash, secret)
  // 比的是签名这串**文字**：`Buffer.from` 不给编码时按 utf8 编，所以逐字符比。
  // 别顺手改成 `'base64'` —— base64 解码会丢掉最后那几个 bit，末尾字符翻一下
  // 解出来还是同一串字节，于是"改一个字节"的那种票会被判成有效。
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  // 长度不等时 timingSafeEqual 会抛，先挡掉。挡在这里才叫"验不过"，
  // 不然一个畸形签名会把"这个人没登录"变成"接口 500"。
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null

  return { userId, expiresAt }
}

/** 过期时间：从现在起 30 天 */
export function sessionExpiry(nowMs: number): number {
  return nowMs + SESSION_DAYS * DAY_MS
}

/** 还差几天过期 —— 用来决定要不要续签 */
export function daysLeft(expiresAt: number, nowMs: number): number {
  return (expiresAt - nowMs) / DAY_MS
}

/**
 * 票上写的过期时间。**只解析，不验签** —— 给"要不要续期"用。
 *
 * ⚠️ 这个名字带着一个前提：**调用方手里的票必须已经验过签**
 * （server/app.ts 拿到的那张，是 findUserByCookie 交给 verifySession 验过的）。
 * 它自己什么都验不了，拿它当"这张票是真的"用，等于没有签名。
 *
 * 为什么不做成"顺手再验一次"：调用点已经验过一遍，再验就是同一个 HMAC 算两遍，
 * 还得把密码哈希到处递 —— 而那张票的形状（三段、过期时间是整数）本来就是
 * verifySession 的返回值**保证**过的。
 *
 * 形状不对给 null：让调用方安静地跳过续期，而不是拿个 NaN 去跟 15 天比大小。
 */
export function expiryOf(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const expiresAt = Number(parts[1])
  return Number.isInteger(expiresAt) ? expiresAt : null
}

/**
 * 拼 Set-Cookie 的值。
 *
 * HttpOnly：JS 读不到 → 页面被塞了坏代码也偷不走。
 * SameSite=Lax：别的网站伪造请求带不上这张票（CSRF）。
 * Path=/：整站都带上。
 *
 * ⚠️ 没有 Secure —— 因为本地跑的是明文 http，加了它浏览器根本不发这张票。
 * **上线前必须加上**（设计文档 §6.5 / §11 都记着这笔）。
 */
export function sessionCookie(token: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

/**
 * 解析 Cookie 头。手写是因为 node:http 不带这个 —— 而为了三行代码引一个
 * cookie 库，会破坏"零新依赖"。
 *
 * 容错：值里的空白去掉；没有 `=` 的段直接跳过，不抛。
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return out
}
