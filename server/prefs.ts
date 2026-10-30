import { asObject, HttpError } from './http.ts'
import type { Db } from './db.ts'

/**
 * 账号级偏好（★ 2026-10-19）。
 *
 * 只存用户主动设为默认的东西；今天主要是导出格式 / 质量 / 尺寸 / 比例。
 * 结构故意留成 JSON 对象：以后加默认风格、外观不用再改一次表。
 * 服务端只负责对象校验和 8 KB 上限，具体字段由前端 `normalizeExportDefaults` 钳制。
 */
export const PREFS_MAX_CHARS = 8_000
export type UserPreferences = Record<string, unknown>

export function parsePreferences(raw: string | null | undefined): UserPreferences | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as UserPreferences
      : null
  } catch {
    return null
  }
}

export function readPreferences(db: Db, userId: number): UserPreferences | null {
  const row = db.raw
    .prepare('SELECT prefs FROM users WHERE id = ?')
    .get(userId) as { prefs?: string | null } | undefined
  return parsePreferences(row?.prefs)
}

export function writePreferences(
  db: Db, userId: number, input: unknown,
): UserPreferences {
  const preferences = asObject(input)
  const text = JSON.stringify(preferences)
  if (text.length > PREFS_MAX_CHARS) {
    throw new HttpError('BAD_REQUEST', `偏好超过 ${PREFS_MAX_CHARS} 字符上限`)
  }
  db.raw.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(text, userId)
  return preferences
}
