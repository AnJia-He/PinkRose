import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from './db.ts'
import { createStorage, type Storage } from './storage.ts'
import { handleCreateWork, handleWorkFile, handleWorkThumb } from './works.ts'
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

  it('★ 缩略图**存不下去**（第二次 save 抛）→ 整张图照样存进去，thumb_name 是 NULL', async () => {
    // 裁定 ② 的核心承诺：缩略图是**附带**的，它失败不能拖垮整张图。
    // 真的把盘写满做不到，但这里要验的恰恰是"第二次 save 抛出来之后 handleCreateWork 怎么走"
    // —— 那件事只取决于 storage 会不会抛，所以造一个"第一次成功、第二次抛"的就够了。
    let calls = 0
    const flaky: Storage = {
      ...storage,
      save: (bytes, ext) => {
        if (++calls === 2) return Promise.reject(new Error('ENOSPC: 盘满了'))
        return storage.save(bytes, ext)
      },
    }
    // 代码里那句"不能静默"要留一声响 —— 顺手把 console.error 打桩掉，不然这条用例
    // 会把 stderr 弄脏（http.test.ts 里验日志的那几条是同一个做法）。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { id } = await handleCreateWork(
        { image: JPEG, thumb: JPEG }, USER, { ...deps, storage: flaky })

      const row = db.raw.prepare('SELECT stored_name, thumb_name FROM works WHERE id = ?')
        .get(id) as { stored_name: string; thumb_name: string | null }
      expect(row.thumb_name).toBe(null)
      // 不只是"库里有一行"：原图那个文件得真的在盘上、真的读得回来
      expect(readdirSync(root)).toEqual([row.stored_name])
      expect(await storage.read(row.stored_name))
        .toEqual(new Uint8Array(Buffer.from('/9j/4AAQSkZJRg==', 'base64')))
      expect(String(spy.mock.calls.flat().join(' '))).toContain('缩略图')
    } finally {
      spy.mockRestore()
    }
  })

  it('★ 缩略图**解不开**（非空但形状坏）→ 也只丢缩略图，不丢整张图', async () => {
    // 和上一条是同一个承诺的另一个入口：形状不对时 decodeDataUrl 会抛。
    // 那个抛必须和"存不下去"走同一条路（记日志、thumb_name 留 NULL）——
    // 解码要是留在 try 外面，这一条会变成 400，整张照片跟着一起丢。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { id } = await handleCreateWork(
        { image: JPEG, thumb: 'data:image/gif;base64,AAAA' }, USER, deps)
      const row = db.raw.prepare('SELECT thumb_name FROM works WHERE id = ?')
        .get(id) as { thumb_name: string | null }
      expect(row.thumb_name).toBe(null)
      expect(readdirSync(root)).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
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

  it('取自己的图 —— 字节原样回来', async () => {
    const b64 = bytesOf(64)
    const { id } = await handleCreateWork({ image: `data:image/jpeg;base64,${b64}` }, USER, deps)
    const got = await handleWorkFile(id, USER, deps)
    expect(got.contentType).toBe('image/jpeg')
    expect(got.bytes.byteLength).toBe(64)
  })

  it('★ 取别人的图 → 当它不存在（404），不是 403、更不能给图', async () => {
    // ⚠️ 这条是整段里最要紧的一条断言（spec §10 说它"最重要"）。
    // 变异：把 loadOwned 里的 `AND user_id = ?` 去掉 → 它必须红。
    //
    // 回 404 而不是 403 是**故意的**：301/403 会告诉他"这个 id 是真的、只是不是你的"，
    // 那就成了枚举别人作品 id 的入口 —— 和登录那句"用户名或密码不对"同一个道理。
    const other: PublicUser = { id: 2, username: '小红', email: 'b@x.com' }
    db.raw.prepare(`INSERT INTO users (username, email, password_hash, created_at) VALUES (?,?,?,?)`)
      .run(other.username, other.email, 'h', 1)
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)

    // ⚠️ **指名道姓** —— 这两条守的是**安全属性**（不许取别人的图）。
    // 不带参数的 `toThrow()` 会让"别的什么抛了"也算过关。
    await expect(handleWorkFile(id, other, deps)).rejects.toThrow(/没有这张作品/)
    await expect(handleWorkThumb(id, other, deps)).rejects.toThrow(/没有这张作品/)
  })

  it('没有缩略图的，/thumb 退回原图 —— 不白屏', async () => {
    const b64 = bytesOf(64)
    const { id } = await handleCreateWork({ image: `data:image/jpeg;base64,${b64}` }, USER, deps)
    const got = await handleWorkThumb(id, USER, deps)
    expect(got.bytes.byteLength).toBe(64)   // 原图那 64 字节，不是 404
  })

  it('★ 缩略图那个文件被手工删了 → 退回原图，不是 500，而且留一声响', async () => {
    // 库里记着有缩略图、盘上那个文件却没了（被手工删了 / 换过盘）—— 这正是"兜底"要接的场景：
    // 用户该看到一张大图，而不是一个 500。光判 `thumb_name` 是不够的，兜底得兜到**读文件这一步**。
    //
    // 而且**兜底不等于静默**：那条 catch 吞掉的可能是权限、是名字守卫、是将来 storage 层的 bug，
    // 不记一声的话"缩略图整个坏掉"我们永远不会知道 —— 和 handleCreateWork 里那条 catch
    // 同一条规矩（那边写的就是"不能静默"）。顺手把 console.error 打桩掉，
    // 不然这条用例每次跑都会把 ENOENT 打到 stderr 上（本文件上面已有两条是这么做的）。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const b64 = bytesOf(64)
      const { id } = await handleCreateWork(
        { image: `data:image/jpeg;base64,${b64}`, thumb: JPEG }, USER, deps)
      const row = db.raw.prepare('SELECT stored_name, thumb_name FROM works WHERE id = ?')
        .get(id) as { stored_name: string; thumb_name: string }
      rmSync(join(root, row.thumb_name))

      const got = await handleWorkThumb(id, USER, deps)
      expect(got.bytes.byteLength).toBe(64)   // 原图那 64 字节，不是缩略图那 10 字节
      expect(got.contentType).toBe('image/jpeg')
      // 响了那一声才叫兜底；不响就是静默降级。把那句 console.error 删掉，下面这条当场红。
      expect(String(spy.mock.calls.flat().join(' '))).toContain('缩略图')

      // ⚠️ 原图自己也不在的时候**不许再兜** —— 那就真的没了，照实抛，别吞成一张空图。
      // 指名道姓：要的是"文件真的读不到"这件事（ENOENT），不是随便抛了什么。
      rmSync(join(root, row.stored_name))
      await expect(handleWorkThumb(id, USER, deps)).rejects.toThrow(/ENOENT/)
    } finally {
      spy.mockRestore()
    }
  })
})
