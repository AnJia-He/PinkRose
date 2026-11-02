import type { SessionMessage } from '../shared/sessions.ts'
import type { Db } from './db.ts'
import { nowMs, type ClockDeps } from './clock.ts'
import { coerceToObject } from './validate.ts'

/**
 * 单会话内部记忆的触发阈值。
 *
 * 消息条数和字符数**任一**超过就会整理。最近 8 条始终按原文进入上下文，
 * 这些值只控制“更早的内容什么时候收进摘要”，不影响用户可见消息。
 */
export const SESSION_MEMORY_TRIGGER_MESSAGES = 16
export const SESSION_MEMORY_TRIGGER_CHARS = 6_000
export const SESSION_MEMORY_RECENT_MESSAGES = 8
export const SESSION_MEMORY_MAX_CHARS = 800
export const PROFILE_MEMORY_MAX_CHARS = 1_200

/** 一次整理最多带上这么多旧消息，避免长会话把单次请求撑爆。 */
const SESSION_MEMORY_WINDOW_MESSAGES = 24
const SESSION_MEMORY_WINDOW_CHARS = 12_000

export type MemoryDeps = ClockDeps & { db: Db }

export type UserMemory = {
  enabled: boolean
  summary: string | null
  updatedAt: number | null
}

export type CompactTask = {
  summary: string | null
  messages: SessionMessage[]
  throughMessageId: number
}

export type RouteMemory = {
  profileEnabled: boolean
  profileSummary: string | null
  sessionSummary: string | null
  messages: SessionMessage[]
  compact: CompactTask | null
}

export type MemoryUpdate = {
  sessionSummary: string | null
  profileSummary: string | null
}

type SessionMemoryRow = {
  session_id: number
  summary: string
  summary_until_message_id: number
  updated_at: number
}

type UserMemoryRow = {
  user_id: number
  summary: string | null
  enabled: number
  updated_at: number
}

function parseMessages(raw: string): SessionMessage[] {
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const m = item as Record<string, unknown>
      if (m.role !== 'user' && m.role !== 'assistant') return []
      if (typeof m.text !== 'string') return []
      const id = Number(m.id)
      return [{
        id: Number.isInteger(id) && id > 0 ? id : 0,
        role: m.role,
        text: m.text,
        at: Number(m.at) || 0,
      }]
    })
  } catch {
    return []
  }
}

function messageChars(messages: readonly SessionMessage[]): number {
  return messages.reduce((sum, message) => sum + message.text.length, 0)
}

function memoryWindow(messages: readonly SessionMessage[]): SessionMessage[] {
  const out: SessionMessage[] = []
  let chars = 0
  for (const message of messages) {
    if (out.length >= SESSION_MEMORY_WINDOW_MESSAGES) break
    if (out.length > 0 && chars + message.text.length > SESSION_MEMORY_WINDOW_CHARS) break
    out.push(message)
    chars += message.text.length
  }
  return out
}

function cleanSummary(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\r\n?/g, '\n').trim()
  return text ? text.slice(0, maxChars) : null
}

export function readUserMemory(db: Db, userId: number): UserMemory {
  const row = db.raw.prepare(
    'SELECT * FROM user_memory WHERE user_id = ?',
  ).get(userId) as UserMemoryRow | undefined
  if (!row) return { enabled: true, summary: null, updatedAt: null }
  return {
    enabled: row.enabled === 1,
    summary: cleanSummary(row.summary, PROFILE_MEMORY_MAX_CHARS),
    updatedAt: row.updated_at,
  }
}

/**
 * 构建这一轮模型需要的内部上下文。
 *
 * 会话 id 不存在、不属于这个人或已经删掉时，不报错、也不泄露任何信息；
 * 当前这句话仍会正常路由，只是没有历史可带。跨会话偏好与具体会话无关，
 * 所以即使还没建好会话 id，也可以单独使用。
 */
export function loadRouteMemory(
  db: Db, userId: number, sessionId: number | null,
): RouteMemory {
  const profile = readUserMemory(db, userId)
  const profileSummary = profile.enabled ? profile.summary : null
  if (sessionId === null) {
    return {
      profileEnabled: profile.enabled,
      profileSummary,
      sessionSummary: null,
      messages: [],
      compact: null,
    }
  }

  const session = db.raw.prepare(
    'SELECT messages FROM sessions WHERE id = ? AND user_id = ?',
  ).get(sessionId, userId) as { messages: string } | undefined
  if (!session) {
    return {
      profileEnabled: profile.enabled,
      profileSummary,
      sessionSummary: null,
      messages: [],
      compact: null,
    }
  }

  const stored = db.raw.prepare(
    'SELECT * FROM session_memory WHERE session_id = ?',
  ).get(sessionId) as SessionMemoryRow | undefined
  const sessionSummary = cleanSummary(stored?.summary, SESSION_MEMORY_MAX_CHARS)
  const summaryUntil = stored?.summary_until_message_id ?? 0
  const all = parseMessages(session.messages)
  const unsummarized = all.filter((message) => message.id > summaryUntil)

  const triggered = unsummarized.length > SESSION_MEMORY_TRIGGER_MESSAGES
    || messageChars(unsummarized) > SESSION_MEMORY_TRIGGER_CHARS
  const recent = unsummarized.slice(-SESSION_MEMORY_RECENT_MESSAGES)
  const older = unsummarized.slice(0, Math.max(0, unsummarized.length - SESSION_MEMORY_RECENT_MESSAGES))
  const compactMessages = triggered ? memoryWindow(older) : []
  const compact = compactMessages.length > 0
    ? {
      summary: sessionSummary,
      messages: compactMessages,
      throughMessageId: compactMessages[compactMessages.length - 1]!.id,
    }
    : null

  return {
    profileEnabled: profile.enabled,
    profileSummary,
    sessionSummary,
    // 超过阈值时只把最近原文直接送进当前轮；更旧的内容通过摘要和本轮整理任务进入模型。
    messages: triggered ? recent : unsummarized,
    compact,
  }
}

export function saveSessionSummary(
  db: Db,
  userId: number,
  sessionId: number,
  summary: string,
  throughMessageId: number,
  deps: ClockDeps = {},
): boolean {
  const clean = cleanSummary(summary, SESSION_MEMORY_MAX_CHARS)
  if (!clean || !Number.isInteger(throughMessageId) || throughMessageId <= 0) return false
  const owned = db.raw.prepare(
    'SELECT id FROM sessions WHERE id = ? AND user_id = ?',
  ).get(sessionId, userId)
  if (!owned) return false
  db.raw.prepare(
    `INSERT INTO session_memory
       (session_id, summary, summary_until_message_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       summary = excluded.summary,
       summary_until_message_id = excluded.summary_until_message_id,
       updated_at = excluded.updated_at
     WHERE excluded.summary_until_message_id >= session_memory.summary_until_message_id`,
  ).run(sessionId, clean, throughMessageId, nowMs(deps))
  return true
}

export function saveProfileSummary(
  db: Db,
  userId: number,
  summary: string,
  deps: ClockDeps = {},
): boolean {
  const clean = cleanSummary(summary, PROFILE_MEMORY_MAX_CHARS)
  if (!clean) return false
  const res = db.raw.prepare(
    `INSERT INTO user_memory (user_id, summary, enabled, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       summary = excluded.summary,
       updated_at = excluded.updated_at
     WHERE user_memory.enabled = 1`,
  ).run(userId, clean, nowMs(deps))
  return res.changes > 0
}

export function setUserMemoryEnabled(
  db: Db, userId: number, enabled: boolean, deps: ClockDeps = {},
): UserMemory {
  const now = nowMs(deps)
  db.raw.prepare(
    `INSERT INTO user_memory (user_id, summary, enabled, updated_at)
     VALUES (?, NULL, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).run(userId, enabled ? 1 : 0, now)
  return readUserMemory(db, userId)
}

export function clearUserMemory(db: Db, userId: number, deps: ClockDeps = {}): UserMemory {
  const now = nowMs(deps)
  db.raw.prepare(
    `INSERT INTO user_memory (user_id, summary, enabled, updated_at)
     VALUES (?, NULL, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       summary = NULL,
       updated_at = excluded.updated_at`,
  ).run(userId, now)
  return readUserMemory(db, userId)
}

/**
 * 用户删除或改写一条已被摘要覆盖的消息时，旧摘要不能再继续使用。
 * 仅仅追加新消息不会清摘要。
 */
export function invalidateSessionSummaryIfChanged(
  db: Db, sessionId: number, previousMessagesJson: string, nextMessagesJson: string,
): boolean {
  const memory = db.raw.prepare(
    'SELECT summary_until_message_id FROM session_memory WHERE session_id = ?',
  ).get(sessionId) as { summary_until_message_id: number } | undefined
  if (!memory) return false

  const previous = parseMessages(previousMessagesJson)
  const next = parseMessages(nextMessagesJson)
  const nextById = new Map(next.map((message) => [message.id, message]))
  const covered = previous.filter((message) => message.id <= memory.summary_until_message_id)
  const changed = covered.some((message) => {
    const after = nextById.get(message.id)
    return !after || after.role !== message.role || after.text !== message.text
  })
  if (!changed) return false

  db.raw.prepare('DELETE FROM session_memory WHERE session_id = ?').run(sessionId)
  return true
}

/**
 * 只解析隐藏记忆字段，不改变现有路由决策。
 * 调用方决定这次是否允许更新本会话摘要 / 跨会话偏好。
 */
export function parseMemoryUpdate(
  raw: unknown,
  allow: { session: boolean; profile: boolean },
): MemoryUpdate {
  const obj = coerceToObject(raw)
  if (!obj) return { sessionSummary: null, profileSummary: null }
  return {
    sessionSummary: allow.session
      ? cleanSummary(obj.session_memory ?? obj.sessionMemory, SESSION_MEMORY_MAX_CHARS)
      : null,
    profileSummary: allow.profile
      ? cleanSummary(obj.profile_memory ?? obj.profileMemory, PROFILE_MEMORY_MAX_CHARS)
      : null,
  }
}
