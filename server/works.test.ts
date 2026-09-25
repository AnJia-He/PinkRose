import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from './db.ts'
import { createStorage, type Storage } from './storage.ts'
import {
  handleCreateWork, handleDeleteWork, handleDeleteWorks, handleGetWork,
  handleListWorks, handleRenameWork, handleReplaceWork, handleWorkFile, handleWorkThumb,
} from './works.ts'
import type { PublicUser } from './account.ts'

const USER: PublicUser = { id: 1, username: '小明', email: 'a@x.com' }
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

/** 一张最小但**合法**的 base64 图。用它，别用 'AAAA' —— 那样测的是"能解码"不是"存对了" */
const bytesOf = (n: number): string => Buffer.from(new Uint8Array(n).fill(7)).toString('base64')

// ⚠️ 夹具写在**文件这一层**：这个文件从 Task 6 起有两个 describe（存一张 / 列全部），
// 两边要的是同一套东西（一个内存库 + 一个临时目录）。各写一份 hook 只会多出一份
// 要跟着同步的副本 —— 而"两边夹具不一样"这种偏差，测试里最难看出来。
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

describe('handleCreateWork', () => {
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

describe('handleListWorks', () => {
  it('列表：只有自己的、按最后改动倒序、不带图也不带路径', async () => {
    const other: PublicUser = { id: 2, username: '小红', email: 'b@x.com' }
    db.raw.prepare(`INSERT INTO users (username, email, password_hash, created_at) VALUES (?,?,?,?)`)
      .run(other.username, other.email, 'h', 1)

    // ⚠️ 故意让**时间**和**入库先后**拧着来：先存的那条（id 更小）时间反而更晚。
    // 两件事同向的话，"按最后改动倒序"和"按 id 倒序"给出的是同一个答案 ——
    // 那就钉不住 §3.5 要的那件事（**按最后改动的时间**，新的在上面）。
    const later = await handleCreateWork({ image: JPEG }, USER, { ...deps, now: () => 300 })
    const earlier = await handleCreateWork({ image: JPEG }, USER, { ...deps, now: () => 100 })
    await handleCreateWork({ image: JPEG }, other, { ...deps, now: () => 200 })

    const r = handleListWorks(USER, deps)
    expect(r.works.map((w) => w.id)).toEqual([later.id, earlier.id])   // 时间晚的在前，别人的不在
    // ★ 响应里**不许**出现硬盘上的文件名，也不许出现配方（那是详情页才给的）
    for (const w of r.works) expect(Object.keys(w).sort()).toEqual(
      ['alias', 'bytes', 'createdAt', 'hasThumb', 'id', 'updatedAt'])
  })

  it('一条都没有 → 空数组，不是 null、不是 404', () => {
    expect(handleListWorks(USER, deps)).toEqual({ works: [] })
  })
})

describe('handleGetWork / handleRenameWork', () => {
  it('★ 详情里的配方是**两栏**：调色一栏、AI 原话一栏，永远是两个字段', async () => {
    // spec §10 点名了这条变异：把它们合成一个数组的话，用户会以为
    // "这一整套都能复用"—— 而「把后面那个人去掉」换一张照片就是另一回事（§3.5.1）。
    const { id } = await handleCreateWork({
      image: JPEG,
      recipe: { params: { exposure: 20, contrast: 5 }, edits: ['把后面那个人去掉', '天空换成傍晚的'] },
    }, USER, deps)

    const d = handleGetWork(id, USER, deps)
    expect(Object.keys(d.recipe).sort()).toEqual(['edits', 'params'])          // ★ 恰好两个字段
    expect(Array.isArray(d.recipe)).toBe(false)                                // ★ 不是合成的一个数组
    expect(d.recipe.params.exposure).toBe(20)
    expect(d.recipe.edits).toEqual(['把后面那个人去掉', '天空换成傍晚的'])
  })

  it('改名生效，但 **updated_at 一点都不动**', async () => {
    const { id } = await handleCreateWork({ image: JPEG }, USER, { ...deps, now: () => 100 })
    handleRenameWork(id, { alias: '海边那张' }, USER, { ...deps, now: () => 999 })

    const row = db.raw.prepare('SELECT alias, updated_at FROM works WHERE id = ?').get(id)
    expect(row).toEqual({ alias: '海边那张', updated_at: 100 })   // ★ 还是 100，不是 999
  })

  it('别名给 null 或空串 = 改回"用时间当名字"', async () => {
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    handleRenameWork(id, { alias: 'x' }, USER, deps)
    expect(handleRenameWork(id, { alias: null }, USER, deps).alias).toBe(null)
    expect(handleRenameWork(id, { alias: '   ' }, USER, deps).alias).toBe(null)
  })

  it('改别人的名字 → 当它不存在', async () => {
    const other: PublicUser = { id: 2, username: '小红', email: 'b@x.com' }
    db.raw.prepare(`INSERT INTO users (username, email, password_hash, created_at) VALUES (?,?,?,?)`)
      .run(other.username, other.email, 'h', 1)
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    // ⚠️ **指名道姓** —— 这条守的是**安全属性**（不许改别人的作品），
    // 不带参数的 `toThrow()` 会让"别的什么抛了"也算过关。
    expect(() => handleRenameWork(id, { alias: 'x' }, other, deps)).toThrow(/没有这张作品/)
    // 而且**真的一动没动**
    expect(handleGetWork(id, USER, deps).alias).toBe(null)
  })
})

/**
 * 删 / 批量删 / 替换。
 *
 * 这一组最要紧的不是功能，是**顺序** —— 三条顺序写反了都会丢东西：
 * 删一张要先删记录再删文件（反过来会留下一条永远删不掉的记录）、
 * 替换要**先写新文件再删旧的**（反过来新文件写失败就等于把图删了）、
 * 批量删要**逐个删**（全有全无的话 12 张里有 1 张出问题就一张都删不掉）。
 *
 * ⚠️ 「替换时新文件写失败」那条用的是**假 storage**：真把盘写满做不到，
 * 而它要验的恰恰是"save 抛出来之后 handleReplaceWork 走的下一步" —— 那件事
 * 只取决于 storage 会不会抛。它同时钉着上面第二条顺序：把"删旧文件"提到
 * "写新文件"前面，旧文件在 save 抛之前就已经没了，`readdirSync(root).length`
 * 那行当场红（remove 是真的，没被打桩）。
 */
describe('handleDeleteWork / handleDeleteWorks / handleReplaceWork', () => {
  it('删一张 —— 记录和**文件**都没了（只删记录是经典的漏）', async () => {
    const { id } = await handleCreateWork({ image: JPEG, thumb: JPEG }, USER, deps)
    const row = db.raw.prepare('SELECT stored_name, thumb_name FROM works WHERE id = ?')
      .get(id) as { stored_name: string; thumb_name: string }
    expect(readdirSync(root).length).toBe(2)

    await handleDeleteWork(id, USER, deps)

    expect(db.raw.prepare('SELECT * FROM works WHERE id = ?').get(id)).toBeUndefined()
    expect(readdirSync(root)).toEqual([])          // ★ 两个文件都得没
    expect(row.stored_name).toBeTruthy()           // （读一下，免得上面那行被优化掉）
  })

  it('★ 文件删不掉 → 照样成功、记录照样没了，而且**响一声**', async () => {
    // ★ 这条钉的是「先删记录、再删文件」那个顺序**换来的结果**：文件那一步炸了，
    // 也绝不能连累记录 —— 记录没了，对用户来说这件事**就是成功了**（§3.5「目标已达成」），
    // 盘上留个孤儿文件只是浪费一点空间。
    //
    // 反过来写（先删文件，且让它抛出去）会怎么样：`remove` 一炸就**轮不到删记录** ——
    // 请求失败、记录还在。而那条记录指向的文件已经没了，于是它**永远打不开、
    // 也删不掉第二次**（再删一次还是同样的顺序）。这条用例在那种写法下必红。
    //
    // 假 storage 只换掉 `remove`（真把文件删不掉：权限、盘满、被占用，现场都造不出来）；
    // 顺便把 console.error 打桩掉 —— 这条要**验**那一声响，不是要它把 stderr 弄脏
    // （本文件上面已有三条是同一个做法）。
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    const broken = {
      ...deps,
      storage: { ...deps.storage, remove: async () => { throw new Error('EACCES: 删不掉') } } as unknown as Storage,
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // ① 请求**成功** —— 文件删不掉不该让用户看到失败
      await expect(handleDeleteWork(id, USER, broken)).resolves.toEqual({ ok: true })
      // ② 记录**真的没了** —— 这才是"先删记录"那一步的落点
      expect(db.raw.prepare('SELECT * FROM works WHERE id = ?').get(id)).toBeUndefined()
      // ③ 吞掉不等于静默（和 handleCreateWork 那条 catch 同一条规矩）
      expect(String(spy.mock.calls.flat().join(' '))).toContain('作品文件没删掉')
    } finally {
      spy.mockRestore()
    }
  })

  it('删两次：第二次当"它已经不在了"，不炸', async () => {
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    await handleDeleteWork(id, USER, deps)
    await expect(handleDeleteWork(id, USER, deps)).rejects.toThrow(/没有这张作品/)  // loadOwned 404
  })

  it('删别人的 → 拒，而且他的一动没动', async () => {
    const other: PublicUser = { id: 2, username: '小红', email: 'b@x.com' }
    db.raw.prepare(`INSERT INTO users (username, email, password_hash, created_at) VALUES (?,?,?,?)`)
      .run(other.username, other.email, 'h', 1)
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    // ⚠️ **指名道姓** —— 这条守的是**安全属性**（不许删别人的）
    await expect(handleDeleteWork(id, other, deps)).rejects.toThrow(/没有这张作品/)
    expect(readdirSync(root).length).toBe(1)
    expect(handleGetWork(id, USER, deps).id).toBe(id)
  })

  it('★ 批量删：12 个里 2 个"已经不在了" —— 删掉那 10 个，并如实报出那 2 个', async () => {
    const made: number[] = []
    for (let i = 0; i < 12; i++) {
      made.push((await handleCreateWork({ image: JPEG }, USER, deps)).id)
    }
    // 前两个已经被别处删掉了（另一台设备 / 另一个标签页）
    await handleDeleteWork(made[0]!, USER, deps)
    await handleDeleteWork(made[1]!, USER, deps)

    const r = await handleDeleteWorks({ ids: made }, USER, deps)

    expect(r.missing.sort()).toEqual([made[0], made[1]].sort())   // ★ 报出来，不静默
    expect(r.deleted.length).toBe(10)
    expect(readdirSync(root)).toEqual([])                          // 10 张的文件也都没了
    expect(handleListWorks(USER, deps).works).toEqual([])
  })

  it('批量删里混进别人的 id → 那个不删、也不报错，只算 missing', async () => {
    const other: PublicUser = { id: 2, username: '小红', email: 'b@x.com' }
    db.raw.prepare(`INSERT INTO users (username, email, password_hash, created_at) VALUES (?,?,?,?)`)
      .run(other.username, other.email, 'h', 1)
    const mine = (await handleCreateWork({ image: JPEG }, USER, deps)).id
    const theirs = (await handleCreateWork({ image: JPEG }, other, deps)).id

    const r = await handleDeleteWorks({ ids: [mine, theirs] }, USER, deps)
    expect(r.deleted).toEqual([mine])
    expect(r.missing).toEqual([theirs])
    expect(handleGetWork(theirs, other, deps).id).toBe(theirs)   // ★ 别人的图好好地在
  })

  it('★ 替换：id 不变、旧文件没了、新文件在、时间和大小都变了', async () => {
    const { id } = await handleCreateWork({ image: JPEG }, USER, { ...deps, now: () => 100 })
    const oldName = (db.raw.prepare('SELECT stored_name FROM works WHERE id = ?')
      .get(id) as { stored_name: string }).stored_name
    const big = `data:image/jpeg;base64,${bytesOf(999)}`

    const meta = await handleReplaceWork(id, { image: big }, USER, { ...deps, now: () => 500 })

    expect(meta.id).toBe(id)                       // ★ id 不变（外面存着的链接不能失效）
    expect(meta.bytes).toBe(999)
    expect(meta.updatedAt).toBe(500)
    const newName = (db.raw.prepare('SELECT stored_name FROM works WHERE id = ?')
      .get(id) as { stored_name: string }).stored_name
    expect(newName).not.toBe(oldName)
    expect(readdirSync(root)).toEqual([newName])   // ★ 旧的真的没了，也没多出别的
  })

  it('★ 替换时新文件写失败 → 旧的**一点没动**（这才是"先写后删"的意义）', async () => {
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    const before = db.raw.prepare('SELECT * FROM works WHERE id = ?').get(id)
    const broken = {
      ...deps,
      storage: { ...deps.storage, save: async () => { throw new Error('盘满了') } } as unknown as Storage,
    }
    // 指名道姓：这条守的是"新文件写失败"这件事本身
    await expect(handleReplaceWork(id, { image: JPEG }, USER, broken)).rejects.toThrow(/盘满了/)

    expect(db.raw.prepare('SELECT * FROM works WHERE id = ?').get(id)).toEqual(before)  // 记录没动
    expect(readdirSync(root).length).toBe(1)                                            // 文件还在
  })
})
