import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from './db.ts'
import { createStorage, type Storage } from './storage.ts'
import { handleCreateWork } from './works.ts'
import type { PublicUser } from './account.ts'

const USER: PublicUser = { id: 1, username: '小明', email: 'a@x.com' }
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

/** 一张最小但**合法**的 base64 图。用它，别用 'AAAA' —— 那样测的是"能解码"不是"存对了" */
const bytesOf = (n: number): string => Buffer.from(new Uint8Array(n).fill(7)).toString('base64')

describe('handleCreateWork', () => {
  let root: string
  let db: Db
  let storage: Storage
  let deps: { db: Db; storage: Storage; now: () => number }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ruixing-works-'))
    db = openDb(':memory:')
    db.raw.prepare(
      `INSERT INTO users (username, email, password_hash, created_at) VALUES (?,?,?,?)`)
      .run(USER.username, USER.email, 'h', 1)
    storage = createStorage(root)
    deps = { db, storage, now: () => 1_700_000_000_000 }
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

  it('存一张 —— 数据库一行、硬盘一个文件、字节数对得上', async () => {
    const b64 = bytesOf(200)
    const { id } = await handleCreateWork(
      { image: `data:image/jpeg;base64,${b64}`, thumb: JPEG, recipe: { params: {}, edits: [] } },
      USER, deps)
    const row = db.raw.prepare('SELECT * FROM works WHERE id = ?').get(id) as Record<string, unknown>
    expect(row.user_id).toBe(USER.id)
    expect(row.bytes).toBe(200)
    expect(row.alias).toBe(null)
    expect(row.updated_at).toBe(1_700_000_000_000)
    // 硬盘上真的有两个文件（图 + 缩略图），不是只有一个
    expect(readdirSync(root).sort()).toEqual(
      [row.stored_name, row.thumb_name].sort())
  })

  it('没带缩略图也存得进去 —— 生成缩略图失败不该让整张图丢掉', async () => {
    const { id } = await handleCreateWork(
      { image: JPEG, recipe: { params: {}, edits: [] } }, USER, deps)
    const row = db.raw.prepare('SELECT thumb_name FROM works WHERE id = ?').get(id) as { thumb_name: string | null }
    expect(row.thumb_name).toBe(null)
  })

  it('recipe 不传 = 什么都没改过（八个 0 + 没有原话），不是 null', async () => {
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    const row = db.raw.prepare('SELECT recipe FROM works WHERE id = ?').get(id) as { recipe: string }
    const r = JSON.parse(row.recipe)
    expect(r.edits).toEqual([])
    expect(Object.values(r.params).every((v) => v === 0)).toBe(true)
  })

  it('不是 data:image 的、或者空的 → 400，而且一个文件都不落盘', async () => {
    // ⚠️ **指名道姓** —— 见全局约束里那条。不带参数的 `toThrow()` 任何抛都能让它过，
    // 包括"图根本不是 data URL"之外的任何原因（代码崩了也算）。
    await expect(handleCreateWork({ image: 'http://x/y.jpg' }, USER, deps))
      .rejects.toThrow(/图得是 data:image/)
    await expect(handleCreateWork({ image: 'data:image/jpeg;base64,' }, USER, deps))
      .rejects.toThrow(/图得是 data:image/)
    expect(readdirSync(root)).toEqual([])
  })

  it('★ 用户不存在（外键挡住 INSERT）→ 刚写进去的文件必须被收回来', async () => {
    // 先落盘再插库，插不进去的话文件就成了孤儿 —— 永远留在盘上、没人知道它是什么。
    // 这条钉的就是那个"收回来"。
    const ghost: PublicUser = { id: 999, username: 'x', email: 'x@x.com' }
    // 指名道姓：这条守的是"外键挡住了 INSERT"，不是"随便抛了什么"
    await expect(handleCreateWork({ image: JPEG }, ghost, deps)).rejects.toThrow(/FOREIGN KEY/)
    expect(readdirSync(root)).toEqual([])
  })
})
