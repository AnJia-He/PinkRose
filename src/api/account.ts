import { del, get, post } from './client'

/** 后端给的公开信息。**绝不含密码或哈希。** */
export type AccountUser = { id: number; username: string; email: string }

/** 用量（§6.6）：作品张数 / 总共占了多少字节 / 上限。 */
export type Usage = { count: number; bytes: number; limit: number }

/**
 * 问一次用量。走的是 `GET /api/me`（2026-10-04 起它带上 `usage`）。
 *
 * 拿不到**不抛**（回 null）—— 和 `me()` 同一个理由，而且这一格宁可整格不出现，
 * 也不写一个"0"（§3.6：那对存过东西的人就是假话）。
 */
export async function usage(): Promise<Usage | null> {
  try {
    return (await get<{ user: AccountUser; usage: Usage }>('/api/me')).usage
  } catch {
    return null
  }
}

export async function signup(o: { username: string; email: string; password: string }): Promise<AccountUser> {
  return (await post<{ user: AccountUser }>('/api/signup', o)).user
}

export async function login(o: { username: string; password: string }): Promise<AccountUser> {
  return (await post<{ user: AccountUser }>('/api/login', o)).user
}

export async function logout(): Promise<void> {
  await post<{ ok: true }>('/api/logout', {})
}

/**
 * 改密码（§6.5）。服务端改完之后会**发一张新票** —— 签名里掺着密码哈希，
 * 所以这一改等于把**所有设备**踢下线（当前这台拿到新票，不会掉）。
 */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await post<{ ok: true }>('/api/password', { oldPassword, newPassword })
}

/**
 * 注销账号（§5）：作品、照片、会话一起删。
 *
 * ⚠️ **删了就找不回来**（我们也没有备份）—— 调用方必须先让用户确认过。
 */
export async function deleteAccount(): Promise<void> {
  await del<{ ok: true }>('/api/account')
}

/**
 * 问后端"我是谁"。
 *
 * **返回 null 表示没登录，不抛** —— 这不是错误，是打开页面时最常见的情况
 * （每个新访客都会走到这里）。让调用方每次 try/catch 一个"正常情况"会把真正的
 * 错误淹掉：App 里的 catch 分不出"没登录"和"服务器挂了"，两者都会变成登录页，
 * 而后者本来该说一句"出问题了"。
 */
export async function me(): Promise<AccountUser | null> {
  try {
    return (await get<{ user: AccountUser }>('/api/me')).user
  } catch {
    return null
  }
}
