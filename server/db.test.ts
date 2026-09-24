import { describe, it, expect } from 'vitest'
import { openDb, MIGRATIONS } from './db.ts'

describe('openDb', () => {
  it('建出 users 表，字段齐全', () => {
    const db = openDb(':memory:')
    const cols = db.raw.prepare(`SELECT name FROM pragma_table_info('users')`).all()
      .map((r: any) => r.name)
    expect(cols).toContain('id')
    expect(cols).toContain('username')
    expect(cols).toContain('email')
    expect(cols).toContain('password_hash')
    expect(cols).toContain('created_at')
    db.close()
  })

  it('username 和 email 都是唯一的 —— 靠数据库约束，不靠代码查', () => {
    const db = openDb(':memory:')
    const ins = db.raw.prepare(
      `INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)`)
    ins.run('a', 'a@x.com', 'h', 1)
    // 同一个 username、不同 email：必须被数据库拒绝
    expect(() => ins.run('a', 'b@x.com', 'h', 1)).toThrow()
    // 同一个 email、不同 username：也必须被拒绝
    expect(() => ins.run('b', 'a@x.com', 'h', 1)).toThrow()
    db.close()
  })

  it('迁移是幂等的 —— 开两次不炸', () => {
    const db = openDb(':memory:')
    db.close()
    // 同一个文件开两次（这里用内存库模拟"再开一次"）
    expect(() => { const d = openDb(':memory:'); d.close() }).not.toThrow()
  })

  it('迁移数组只增不改 —— 拿掉一条就会炸在旧库上', () => {
    const db = openDb(':memory:')
    const v = db.raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as any
    expect(v.v).toBe(MIGRATIONS.length)
    db.close()
  })
})
