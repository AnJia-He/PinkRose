import { describe, it, expect } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('迁移在真文件上幂等 —— 同一个物理库开两次，第二次从 version=1 接着走', () => {
    // ⚠️ 这条不是上面「开两次不炸」的重复，是它的补丁：开两次 :memory: 开的是**两个全新的
    // 空库**，走的永远是 current === 0 那条路 —— 把迁移循环改成 `for (let i = 0; ...)`
    // 上面那条照样全绿（实测过）。而「同一个库升上来，不会重跑已经跑过的迁移」是迁移系统
    // 的核心承诺，后面加作品表/模型配置表/预设表全都压在这上面，只有真文件测得到。
    const file = join(tmpdir(), `ruixing-migrate-${process.pid}-${Date.now()}.db`)
    try {
      openDb(file).close()
      // 第二次开：users 已经在了，schema_version 已经是 1，循环必须从 1 起 ——
      // 从 0 起就会重跑建表，炸在 "table users already exists" 上。
      expect(() => { openDb(file).close() }).not.toThrow()
    } finally {
      // 清不掉也不能把测试判红：临时目录里的残留不说明任何被测行为对错，
      // 而 Windows 上杀软/索引器偶尔会短暂占住刚建出来的文件。顺带清 sqlite 的边车文件。
      try {
        for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
          rmSync(f, { force: true })
        }
      } catch { /* 见上：清理失败与被测行为无关 */ }
    }
  })
})
