import { del, get, patch, post } from './client'

/** 后端给的公开信息。**绝不含密码或哈希。** */
export type AccountUser = {
  id: number
  username: string
  email: string
  /** 账号级偏好（今天主要是导出默认值）；老接口缺这一格时按没有处理。 */
  preferences?: Record<string, unknown> | null
}

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
 * 改用户名（★ 2026-10-09）。
 *
 * ⚠️ 和 `changePassword` **正相反**：这一趟**不发新票**。票的签名里掺的是
 * 密码哈希和 userId，**没有用户名**（`server/session.ts`）—— 所以别的设备
 * 不会被踢，当前这台也不用换票。别照着上面那条的注释写"所有设备下线"。
 *
 * 回的是**改完之后**那份 user：调用方拿它更新屏幕上那一行。
 */
export async function changeUsername(username: string): Promise<AccountUser> {
  return (await post<{ user: AccountUser }>('/api/username', { username })).user
}

/** 保存账号级偏好；成功返回**带新偏好**的 user，调用方据此更新 App 的 user。 */
export async function savePreferences(
  preferences: Record<string, unknown>,
): Promise<AccountUser> {
  return (await patch<{ user: AccountUser }>('/api/me', { preferences })).user
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
