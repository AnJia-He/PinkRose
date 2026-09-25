import { get, post } from './client'

/** 后端给的公开信息。**绝不含密码或哈希。** */
export type AccountUser = { id: number; username: string; email: string }

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
