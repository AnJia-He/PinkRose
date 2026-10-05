import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from './db.ts'
import { createStorage, type Storage } from './storage.ts'
import { createLut, deleteLut, handleLutFile, listLuts, lutUsage, renameLut, resolveLutRef } from './luts.ts'
import { MAX_LUTS } from '../shared/lut.ts'
import type { PublicUser } from './account.ts'

const user: PublicUser = { id: 1, username: 'a', email: 'a@b.c' }

/** 一个 2×2×2 恒等 cube 的文本 */
const CUBE2 = ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n')

let dir: string
let db: Db
let storage: Storage
let deps: { db: Db; storage: Storage }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'luts-'))
  db = openDb(':memory:')
  db.raw.exec(`INSERT INTO users (username, email, password_hash, created_at) VALUES ('a','a@b.c','x',0)`)
  storage = createStorage(join(dir, 'luts'))
  deps = { db, storage }
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('createLut / listLuts', () => {
  it('导入一个，默认名字用 TITLE', async () => {
    const t = CUBE2.replace('LUT_3D_SIZE 2', 'TITLE "Portra"\nLUT_3D_SIZE 2')
    const { lut } = await createLut({ cube: t }, user, deps)
    expect(lut.name).toBe('Portra')
    expect(lut.size).toBe(2)
    expect(listLuts(user, deps).luts).toHaveLength(1)
  })

  it('bytes 记的是 UTF-8 字节数 —— 中文 TITLE 让它和码元数不相等', async () => {
    // ★ 审查 I2（2026-10-05）：原来闸、配额和这一列都用 `text.length`（UTF-16 码元数）。
    //   纯 ASCII 的 .cube 上两者相等，所以只有非 ASCII 才分得出来 —— 而一个中文 TITLE
    //   就够（一个汉字 1 码元 / 3 字节）。Task 4 起这一列要进 5 GB 配额账本，
    //   口径必须和 works/sessions 一样是 `.byteLength`。
    //   （实测：把这一列换回 `text.length`，这条立刻红 —— 72 ≠ 76。）
    const t = CUBE2.replace('LUT_3D_SIZE 2', 'TITLE "黄昏"\nLUT_3D_SIZE 2')
    const { lut } = await createLut({ cube: t }, user, deps)
    expect(lut.name).toBe('黄昏')
    expect(lut.bytes).toBe(new TextEncoder().encode(t).byteLength)
    expect(lut.bytes).toBeGreaterThan(t.length)   // 少了这句，一个又按码元数的实现照样绿
  })

  it('名字重了要拒绝（忽略大小写）', async () => {
    await createLut({ name: 'Sunset', cube: CUBE2 }, user, deps)
    await expect(createLut({ name: 'sunset', cube: CUBE2 }, user, deps)).rejects.toThrow(/换个名字/)
  })

  it('坏文件被拒，且一个字都没落盘', async () => {
    await expect(createLut({ name: 'x', cube: 'hello' }, user, deps)).rejects.toThrow(/不是 \.cube/)
    expect(listLuts(user, deps).luts).toHaveLength(0)
  })

  it(`超过 ${MAX_LUTS} 个要拒绝`, async () => {
    for (let i = 0; i < MAX_LUTS; i++) await createLut({ name: `f${i}`, cube: CUBE2 }, user, deps)
    await expect(createLut({ name: 'one-more', cube: CUBE2 }, user, deps)).rejects.toThrow(/最多 30 个/)
  })

  it('别人的滤镜取不到', async () => {
    const { lut } = await createLut({ name: 'mine', cube: CUBE2 }, user, deps)
    const other: PublicUser = { id: 999, username: 'b', email: 'b@b.c' }
    await expect(handleLutFile(lut.id, other, deps)).rejects.toThrow(/没有这个滤镜/)
  })
})

describe('取文件 / 改名 / 删除 / 用量', () => {
  it('取回来的就是原文', async () => {
    const { lut } = await createLut({ name: 'x', cube: CUBE2 }, user, deps)
    const { bytes, contentType } = await handleLutFile(lut.id, user, deps)
    expect(new TextDecoder().decode(bytes)).toBe(CUBE2)
    expect(contentType).toContain('text/plain')
  })

  it('改名，重名拒绝', async () => {
    const { lut } = await createLut({ name: 'x', cube: CUBE2 }, user, deps)
    await createLut({ name: 'y', cube: CUBE2 }, user, deps)
    expect(renameLut(lut.id, { name: 'z' }, user, deps).lut.name).toBe('z')
    expect(() => renameLut(lut.id, { name: 'y' }, user, deps)).toThrow(/换个名字/)
  })

  it('删除：行没了、文件也没了', async () => {
    const { lut } = await createLut({ name: 'x', cube: CUBE2 }, user, deps)
    const row = db.raw.prepare('SELECT stored_name FROM luts WHERE id = ?').get(lut.id) as { stored_name: string }
    await deleteLut(lut.id, user, deps)
    expect(listLuts(user, deps).luts).toHaveLength(0)
    await expect(storage.read(row.stored_name)).rejects.toThrow()
  })

  it('用量：数得出哪几条会话在用', async () => {
    const { lut } = await createLut({ name: 'x', cube: CUBE2 }, user, deps)
    const steps = JSON.stringify([{ id: 1, label: '原图', params: {}, at: 0, image: 'a.jpg', lut: { lutId: lut.id, amount: 80 } }])
    db.raw.exec(`INSERT INTO sessions (user_id, created_at, updated_at, original, base, messages, steps, files)
                 VALUES (1, 0, 0, 'a.jpg', 'a.jpg', '[]', '${steps.replace(/'/g, "''")}', '["a.jpg"]')`)
    expect(lutUsage(lut.id, user, deps).sessions).toBe(1)
  })
})

describe('resolveLutRef（两道闸用的那个）', () => {
  it('存在 → 原样；不存在 / 别人的 → null', async () => {
    const { lut } = await createLut({ name: 'x', cube: CUBE2 }, user, deps)
    expect(resolveLutRef(db, user.id, { lutId: lut.id, amount: 50 })).toEqual({ lutId: lut.id, amount: 50 })
    expect(resolveLutRef(db, user.id, { lutId: 12345, amount: 50 })).toBeNull()
    expect(resolveLutRef(db, 999, { lutId: lut.id, amount: 50 })).toBeNull()
    expect(resolveLutRef(db, user.id, null)).toBeNull()
  })
})
