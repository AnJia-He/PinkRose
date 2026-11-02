import { describe, expect, it } from 'vitest'
import { openDb, type Db } from './db.ts'
import {
  SESSION_MEMORY_RECENT_MESSAGES,
  SESSION_MEMORY_TRIGGER_CHARS,
  clearUserMemory,
  invalidateSessionSummaryIfChanged,
  loadRouteMemory,
  parseMemoryUpdate,
  readUserMemory,
  saveProfileSummary,
  saveSessionSummary,
  setUserMemoryEnabled,
} from './memory.ts'
import type { SessionMessage } from '../shared/sessions.ts'

const user = { id: 1, username: '小明', email: 'a@b.c' }

function setup(): { db: Db; sessionId: number } {
  const db = openDb(':memory:')
  db.raw.prepare(
    'INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?,?,?,?,?)',
  ).run(1, user.username, user.email, 'x', 0)
  db.raw.prepare(
    'INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?,?,?,?,?)',
  ).run(2, '小红', 'd@e.f', 'x', 0)
  const messages: SessionMessage[] = []
  const r = db.raw.prepare(
    `INSERT INTO sessions
       (user_id, created_at, updated_at, title, original, original_name, base, thumb, messages, steps, files, bytes)
     VALUES (?, 0, 0, NULL, 'o.jpg', NULL, 'o.jpg', NULL, ?, '[]', '["o.jpg"]', 1)`,
  ).run(1, JSON.stringify(messages))
  return { db, sessionId: Number(r.lastInsertRowid) }
}

function messages(count: number, chars = 4): SessionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `${String(i + 1).padStart(2, '0')}:${'画'.repeat(Math.max(0, chars - 3))}`,
    at: 0,
  }))
}

function setMessages(db: Db, sessionId: number, list: SessionMessage[]): string {
  const json = JSON.stringify(list)
  db.raw.prepare('UPDATE sessions SET messages = ? WHERE id = ?').run(json, sessionId)
  return json
}

describe('单会话记忆', () => {
  it('超过 16 条时只直接送最近 8 条，更早的进入本轮整理窗口', () => {
    const { db, sessionId } = setup()
    setMessages(db, sessionId, messages(18))
    const memory = loadRouteMemory(db, user.id, sessionId)

    expect(memory.messages).toHaveLength(SESSION_MEMORY_RECENT_MESSAGES)
    expect(memory.messages[0]!.id).toBe(11)
    expect(memory.messages.at(-1)!.id).toBe(18)
    expect(memory.compact?.messages.map((m) => m.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    )
    expect(memory.compact?.throughMessageId).toBe(10)
    db.close()
  })

  it('正文超过 6000 字也会触发整理，不只是数消息条数', () => {
    const { db, sessionId } = setup()
    const list = messages(10, 700)
    expect(list.reduce((n, m) => n + m.text.length, 0)).toBeGreaterThan(
      SESSION_MEMORY_TRIGGER_CHARS,
    )
    setMessages(db, sessionId, list)
    const memory = loadRouteMemory(db, user.id, sessionId)

    expect(memory.messages).toHaveLength(8)
    expect(memory.compact?.messages).toHaveLength(2)
    db.close()
  })

  it('摘要覆盖越界消息后，最近原文仍独立保留', () => {
    const { db, sessionId } = setup()
    const list = messages(20)
    setMessages(db, sessionId, list)
    expect(saveSessionSummary(db, user.id, sessionId, '用户想保留黄昏，已调暖并提亮人物。', 10, {
      now: () => 123,
    })).toBe(true)

    const memory = loadRouteMemory(db, user.id, sessionId)
    expect(memory.sessionSummary).toContain('黄昏')
    expect(memory.messages.map((m) => m.id)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ])
    expect(memory.compact).toBeNull()
    db.close()
  })

  it('别的账号拿同一个会话 id 也读不到摘要或历史', () => {
    const { db, sessionId } = setup()
    setMessages(db, sessionId, messages(18))
    saveSessionSummary(db, user.id, sessionId, '这是用户自己的摘要', 10)

    const memory = loadRouteMemory(db, 2, sessionId)
    expect(memory.sessionSummary).toBeNull()
    expect(memory.messages).toEqual([])
    expect(memory.compact).toBeNull()
    db.close()
  })

  it('被摘要覆盖的消息一被删除或改写，旧摘要立即作废', () => {
    const { db, sessionId } = setup()
    const original = messages(12)
    const before = setMessages(db, sessionId, original)
    saveSessionSummary(db, user.id, sessionId, '旧摘要', 8)

    const appended = [...original, { id: 13, role: 'user' as const, text: '再暖一点', at: 0 }]
    expect(invalidateSessionSummaryIfChanged(
      db, sessionId, before, JSON.stringify(appended),
    )).toBe(false)

    const deleted = original.filter((m) => m.id !== 5)
    expect(invalidateSessionSummaryIfChanged(
      db, sessionId, before, JSON.stringify(deleted),
    )).toBe(true)
    expect(db.raw.prepare('SELECT * FROM session_memory WHERE session_id = ?').get(sessionId))
      .toBeUndefined()
    db.close()
  })

  it('删会话时摘要随外键级联删除', () => {
    const { db, sessionId } = setup()
    setMessages(db, sessionId, messages(12))
    saveSessionSummary(db, user.id, sessionId, '会话摘要', 8)
    db.raw.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    expect(db.raw.prepare('SELECT * FROM session_memory WHERE session_id = ?').get(sessionId))
      .toBeUndefined()
    db.close()
  })
})

describe('跨会话稳定偏好', () => {
  it('默认开启；关闭后不再返回摘要，重新开启后旧摘要还在', () => {
    const { db } = setup()
    expect(readUserMemory(db, user.id)).toEqual({
      enabled: true,
      summary: null,
      updatedAt: null,
    })
    expect(saveProfileSummary(db, user.id, '喜欢自然肤色和 4:5 画幅。', { now: () => 10 }))
      .toBe(true)
    expect(loadRouteMemory(db, user.id, null).profileSummary).toContain('4:5')

    expect(setUserMemoryEnabled(db, user.id, false, { now: () => 11 }).enabled).toBe(false)
    expect(loadRouteMemory(db, user.id, null).profileSummary).toBeNull()

    const enabled = setUserMemoryEnabled(db, user.id, true, { now: () => 12 })
    expect(enabled.enabled).toBe(true)
    expect(enabled.summary).toContain('4:5')
    db.close()
  })

  it('清除只清摘要，开关状态保留', () => {
    const { db } = setup()
    saveProfileSummary(db, user.id, '喜欢低调一些的对比。')
    setUserMemoryEnabled(db, user.id, false)
    const cleared = clearUserMemory(db, user.id, { now: () => 99 })
    expect(cleared.summary).toBeNull()
    expect(cleared.enabled).toBe(false)
    expect(cleared.updatedAt).toBe(99)
    db.close()
  })
})

describe('隐藏字段解析', () => {
  it('只接受调用方允许的记忆字段，并丢掉空内容', () => {
    expect(parseMemoryUpdate(JSON.stringify({
      session_memory: '  会话摘要  ',
      profile_memory: '  长期偏好  ',
    }), { session: true, profile: true })).toEqual({
      sessionSummary: '会话摘要',
      profileSummary: '长期偏好',
    })

    expect(parseMemoryUpdate(JSON.stringify({
      session_memory: '会话摘要',
      profile_memory: '长期偏好',
    }), { session: false, profile: true })).toEqual({
      sessionSummary: null,
      profileSummary: '长期偏好',
    })

    expect(parseMemoryUpdate('不是 JSON', { session: true, profile: true })).toEqual({
      sessionSummary: null,
      profileSummary: null,
    })
  })
})
