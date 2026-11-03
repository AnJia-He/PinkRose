import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { ensureDesktopProfile } from './desktopProfile.ts'

describe('桌面版本机资料', () => {
  it('首次启动建立唯一的本机用户，重复启动仍用同一个人', () => {
    const db = openDb(':memory:')
    try {
      const first = ensureDesktopProfile(db, () => 123)
      const again = ensureDesktopProfile(db, () => 456)

      expect(first).toEqual(again)
      expect(first).toMatchObject({
        id: 1,
        username: '本机用户',
        email: 'local@pinkrose.invalid',
      })
    } finally {
      db.close()
    }
  })

  it('升级已有桌面数据时沿用最早的原账号，不另建一个空账号', () => {
    const db = openDb(':memory:')
    try {
      db.raw.prepare(
        'INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
      ).run('老用户', 'old@example.com', 'scrypt$invalid', 42)

      expect(ensureDesktopProfile(db, () => 999)).toEqual({
        id: 1,
        username: '老用户',
        email: 'old@example.com',
      })
    } finally {
      db.close()
    }
  })

  it('两个独立数据目录各自建立本机资料，不共享同一条用户记录', () => {
    const first = openDb(':memory:')
    const second = openDb(':memory:')
    try {
      const a = ensureDesktopProfile(first)
      const b = ensureDesktopProfile(second)
      expect(a.id).toBe(1)
      expect(b.id).toBe(1)
      expect(a).not.toBe(b)
    } finally {
      first.close()
      second.close()
    }
  })
})
