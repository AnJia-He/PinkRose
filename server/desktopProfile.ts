import { randomBytes } from 'node:crypto'
import type { PublicUser } from './account.ts'
import type { Db } from './db.ts'

/**
 * Electron 主进程为本地服务注入的不可见请求头。
 *
 * 这不是给用户看的登录步骤：窗口打开前由主进程自动加上，页面拿不到令牌，
 * 普通浏览器或同机其他网页也不能直接调用本机接口。
 */
export const DESKTOP_AUTH_HEADER = 'x-pinkrose-desktop-token'

type UserRow = PublicUser

/**
 * 桌面版一个数据目录只对应一份本机资料。
 *
 * 新数据目录会建立一个不可登录的本地用户。升级已有数据时沿用最早的原账号，
 * 让旧作品、会话和偏好继续可见；桌面模式之后只认这一条用户记录，
 * 其他历史账号即使仍留在数据库里，也不会被本机窗口切换过去。
 */
export function ensureDesktopProfile(
  db: Db,
  now: () => number = Date.now,
): PublicUser {
  const existing = db.raw
    .prepare('SELECT id, username, email FROM users ORDER BY id LIMIT 1')
    .get() as UserRow | undefined
  if (existing) return existing

  // 这条哈希只占住非空列。本地资料不走账号密码登录；
  // 即使有人手动请求 /api/login，也不会得到一个可用的密码。
  const unusableHash = `desktop-local$${randomBytes(32).toString('base64url')}`
  db.raw.prepare(
    'INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
  ).run('本机用户', 'local@pinkrose.invalid', unusableHash, now())

  const created = db.raw
    .prepare('SELECT id, username, email FROM users ORDER BY id LIMIT 1')
    .get() as UserRow | undefined
  if (!created) throw new Error('没有建立本机资料')
  return created
}
