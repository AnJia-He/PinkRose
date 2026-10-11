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
import type { HttpError } from './http.ts'
import { QUOTA_BYTES } from './quota.ts'
import { b64Of, jpegBytes } from './testImages.ts'

const USER: PublicUser = { id: 1, username: '小明', email: 'a@x.com' }
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

/** 一张最小但**合法**的 base64 图。用它，别用 'AAAA' —— 那样测的是"能解码"不是"存对了" */
const bytesOf = (n: number): string => b64Of(jpegBytes(n))

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
  it('★ 详情里的配方是**两栏**：调色一栏、AI 原话一栏，永远是分开的字段', async () => {
    // spec §10 点名了这条变异：把它们合成一个数组的话，用户会以为
    // "这一整套都能复用"—— 而「把后面那个人去掉」换一张照片就是另一回事（§3.5.1）。
    // ★ 2026-10-05：滤镜（`lut`）是**第三个并列字段**，同样不是合进 `edits` 里的一格 ——
    //   它套得走（和 params 一样），但"用哪句原话改的"套不走，两个问题的答案不一样。
    const { id } = await handleCreateWork({
      image: JPEG,
      recipe: { params: { exposure: 20, contrast: 5 }, edits: ['把后面那个人去掉', '天空换成傍晚的'] },
    }, USER, deps)

    const d = handleGetWork(id, USER, deps)
    expect(Object.keys(d.recipe).sort()).toEqual(['edits', 'lut', 'params'])   // ★ 三个并列字段
    expect(Array.isArray(d.recipe)).toBe(false)                                // ★ 不是合成的一个数组
    expect(d.recipe.params.exposure).toBe(20)
    expect(d.recipe.edits).toEqual(['把后面那个人去掉', '天空换成傍晚的'])
  })

  it('★ 配方里的滤镜存得进、取得出；形状不对当没有', async () => {
    // ★ 2026-10-05：作品配方里的滤镜**只存名字不存 id** —— 作品那张图是存的时候
    //   烤好的，id 没有渲染作用；详情页「套到别的图上」按名字去找还在不在。
    const r = await handleCreateWork({
      image: JPEG, recipe: { params: {}, edits: [], lut: { name: '黄昏', amount: 80 } },
    }, USER, deps)
    expect(handleGetWork(r.id, USER, deps).recipe.lut).toEqual({ name: '黄昏', amount: 80 })

    // ★ 替换（PUT）那条路也要过同一道闸 —— 两条路共用 `readRecipe`，所以这里也钉一遍：
    //   只测 POST 的话，"两条写入路径都过闸"就只是注释里的一句话
    await handleReplaceWork(r.id, {
      image: JPEG, recipe: { params: {}, edits: [], lut: { name: '黄昏', amount: 80 } },
    }, USER, deps)
    expect(handleGetWork(r.id, USER, deps).recipe.lut).toEqual({ name: '黄昏', amount: 80 })  // 换成带滤镜的
    await handleReplaceWork(r.id, {
      image: JPEG, recipe: { params: {}, edits: [], lut: { name: 'x'.repeat(99), amount: 1e9 } },
    }, USER, deps)
    expect(handleGetWork(r.id, USER, deps).recipe.lut).toBeNull()                             // 形状不对 → 当没有

    // 形状不对的一律当没有 —— 一个 99 字的名字**不可能**对应任何真滤镜
    //（库里那些名字最多 30 字），存下来只会在详情页上说一句匹配不上的假话
    for (const bad of [
      { name: 'x'.repeat(99), amount: 1e9 },
      { name: '', amount: 50 },
      { name: '   ', amount: 50 },
      { name: '黄昏', amount: '不是数' },
      '不是对象',
      [1, 2, 3],
    ]) {
      const w = await handleCreateWork({ image: JPEG, recipe: { params: {}, edits: [], lut: bad } }, USER, deps)
      expect(handleGetWork(w.id, USER, deps).recipe.lut).toBeNull()
    }

    // 老作品（存的时候根本没有 recipe / 没有这个键）读出来也是**显式 null** ——
    // 前端不必再判一次 undefined
    const plain = await handleCreateWork({ image: JPEG }, USER, deps)
    expect(handleGetWork(plain.id, USER, deps).recipe.lut).toBeNull()
    const noLut = await handleCreateWork({ image: JPEG, recipe: { params: {}, edits: [] } }, USER, deps)
    expect(handleGetWork(noLut.id, USER, deps).recipe.lut).toBeNull()
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

  it('★ 记录删不掉 → 请求真的失败，而且**文件一步都没走过**（顺序反过来在这儿就露馅了）', async () => {
    // ★ 这条才是真正能把两种顺序分开的那条 —— 上面那条分不开它们：`remove` 那一步是**吞错**的
    // （上面那条用例钉着它必须吞），所以只要 `remove` 成功，"文件先删还是后删"**从外面看不出来**
    // —— 记录都删了、请求都成功、日志都响、孤儿文件也是同一个。黑盒同形。
    //
    // 两者真正分岔的时刻是「**记录那一步失败**」：
    // - 对的顺序：记录先抛 → 文件那一步**根本没走到** → 文件还在、记录还在。用户重来一次还能删掉
    // - 错的顺序：文件已经先没了 → 记录再失败 → **图没了、记录还在**。那条记录永远打不开、
    //   也删不掉第二次（再删一次还是同样的顺序）
    //
    // 所以下面**两句缺一不可**，只有一句都分不开：光看"请求失败"，两种顺序一样；
    // 光看"文件在不在"，得先有那句失败才问得出意思。
    //
    // 假 Db 只拦 `DELETE` 那一句（`prepare` 拿到的就是这句 SQL），别的照常走 ——
    // 所以 loadOwned 查的那句 SELECT 还是真的。
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    const name = (db.raw.prepare('SELECT stored_name FROM works WHERE id = ?')
      .get(id) as { stored_name: string }).stored_name
    const broken = {
      ...deps,
      db: {
        ...deps.db,
        raw: {
          prepare: (sql: string) => {
            if (sql.startsWith('DELETE')) throw new Error('database is locked')
            return deps.db.raw.prepare(sql)
          },
        },
      } as unknown as Db,
    }

    // ① 指名道姓：这条守的是"记录删不掉"这件事本身，不是随便抛了什么 —— 更不许静默吞掉
    await expect(handleDeleteWork(id, USER, broken)).rejects.toThrow(/database is locked/)
    // ② ★ 文件**还在**。错的顺序到这儿文件已经没了（先删了）—— 那才是"图丢了"
    expect(readdirSync(root)).toEqual([name])
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

  it('★★ 替换真的把 updated_at **写进库**了 —— 那是图片 URL 的版本号', async () => {
    // 上一条断言的是**返回值** `meta.updatedAt`，而那个值来自 handleReplaceWork 最后一行
    // `toMeta({ ...row, updated_at: t })` —— **内存里拼的，不是从库读回来的**。
    // 所以把 UPDATE 里的 `updated_at = ?` 整个删掉（或者传到别的位置），上一条**照样绿**：
    // 库里还停在 100，而列表缩略图 / 详情大图 / 下载三条 URL 里的 `?v=` 永远不变 ——
    // `/api/works/:id/file` 和 `/thumb` 回的是 `immutable`，浏览器就**静默地**一直给旧图
    // （没有报错、没有 4xx、日志里一个字都没有，用户只会说一句「怎么没变」）。
    // 这一条读**库里的行**：它才是 `toMeta` → `?v=<updatedAt>` 真正吃进去的那一份。
    // 变异：删掉 UPDATE 里的 `updated_at = ?` → 这一条红，上一条不动。
    const { id } = await handleCreateWork({ image: JPEG }, USER, { ...deps, now: () => 100 })
    await handleReplaceWork(
      id, { image: `data:image/jpeg;base64,${bytesOf(999)}` }, USER, { ...deps, now: () => 500 })

    const row = db.raw.prepare('SELECT updated_at FROM works WHERE id = ?')
      .get(id) as { updated_at: number }
    expect(row.updated_at).toBe(500)        // ★ 落库了，不只是返回值好看
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

  it('★ 替换时不给新缩略图 → 旧缩略图必须没、thumb_name 置空', async () => {
    // ★ 图都换了，旧缩略图缩的是**上一版** —— 留着就是错的（前端按 hasThumb 退回原图）。
    // 这条钉的是 UPDATE 里 `thumb_name = ?` 那个问号：把新值传进去，
    // 不传（或者 COALESCE 保旧值）都会让这一条红。
    const { id } = await handleCreateWork({ image: JPEG, thumb: JPEG }, USER, deps)
    const old = db.raw.prepare('SELECT stored_name, thumb_name FROM works WHERE id = ?')
      .get(id) as { stored_name: string; thumb_name: string }
    expect(readdirSync(root).length).toBe(2)

    const meta = await handleReplaceWork(
      id, { image: `data:image/jpeg;base64,${bytesOf(999)}` }, USER, deps)

    expect(meta.hasThumb).toBe(false)                       // ★ 置空，不是"留着上一版的缩略图"
    const row = db.raw.prepare('SELECT stored_name, thumb_name FROM works WHERE id = ?')
      .get(id) as { stored_name: string; thumb_name: string | null }
    expect(row.thumb_name).toBe(null)
    expect(row.stored_name).not.toBe(old.stored_name)
    expect(readdirSync(root)).toEqual([row.stored_name])    // ★ 旧的图 + 旧的缩略图都没了
    expect(old.thumb_name).toBeTruthy()                     // （读一下，证明上面那两个文件真是图 + 缩略图）
  })

  it('★ 替换时缩略图**存不下去**（第二次 save 抛）→ 照样换图成功，只是这张没有缩略图', async () => {
    // 裁定 ② 在替换上的样子：缩略图是**附带**的，凭什么把它存不下去这件事
    // 变成"用户认真选的那张新图也丢了"。写法照抄 handleCreateWork 那条 ——
    // 解码和落盘在同一个 try 里，两种坏姿势走同一条路。
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    const oldName = (db.raw.prepare('SELECT stored_name FROM works WHERE id = ?')
      .get(id) as { stored_name: string }).stored_name
    let calls = 0
    const flaky: Storage = {
      ...storage,
      save: (bytes, ext) => {
        if (++calls === 2) return Promise.reject(new Error('ENOSPC: 盘满了'))
        return storage.save(bytes, ext)
      },
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const meta = await handleReplaceWork(
        id, { image: `data:image/jpeg;base64,${bytesOf(999)}`, thumb: JPEG }, USER, { ...deps, storage: flaky })

      expect(meta.hasThumb).toBe(false)
      const row = db.raw.prepare('SELECT stored_name, thumb_name FROM works WHERE id = ?')
        .get(id) as { stored_name: string; thumb_name: string | null }
      expect(row.thumb_name).toBe(null)
      expect(row.stored_name).not.toBe(oldName)
      // ★ 新图**没变成孤儿**：盘上正好只剩记录指向的那一个（旧图、旧缩略图都删了）。
      // 缩略图那次 save 抛出去没人接的话，新图的文件就一个人留在盘上，记录连提都没提它。
      expect(readdirSync(root)).toEqual([row.stored_name])
      expect(String(spy.mock.calls.flat().join(' '))).toContain('缩略图')
    } finally {
      spy.mockRestore()
    }
  })

  it('★ 替换时缩略图**解不开**（非空但形状坏）→ 也只丢缩略图，不丢整张图', async () => {
    // 和上一条是同一个承诺的另一个入口：形状不对时 decodeDataUrl 会抛。
    // 解码要是留在 try 外面，这一条会变成 400，整张新图跟着一起丢（裁定 ②）
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const meta = await handleReplaceWork(
        id, { image: `data:image/jpeg;base64,${bytesOf(999)}`, thumb: 'data:image/gif;base64,AAAA' },
        USER, deps)

      expect(meta.hasThumb).toBe(false)
      const row = db.raw.prepare('SELECT stored_name FROM works WHERE id = ?')
        .get(id) as { stored_name: string }
      expect(readdirSync(root)).toEqual([row.stored_name])
      expect(String(spy.mock.calls.flat().join(' '))).toContain('缩略图')
    } finally {
      spy.mockRestore()
    }
  })

  it('★ 改记录那一步抛 → 新写的**两个**文件都收回来，旧的**一动没动**', async () => {
    // ★ 这条钉的是 UPDATE 那个 catch 里的收尾：新图和新缩略图都是刚写上去的，
    // 记录没改成功 = 没有任何东西知道它们是谁 —— 不收回来就是两个查不到的孤儿。
    // 假 Db 只拦 `UPDATE` 那一句（`prepare` 拿到的就是这句 SQL），
    // 别的照常走 —— loadOwned 查的那句 SELECT 还是真的。
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    const before = db.raw.prepare('SELECT * FROM works WHERE id = ?').get(id)
    const oldName = (before as { stored_name: string }).stored_name
    const broken = {
      ...deps,
      db: {
        ...deps.db,
        raw: {
          prepare: (sql: string) => {
            if (sql.startsWith('UPDATE')) throw new Error('database is locked')
            return deps.db.raw.prepare(sql)
          },
        },
      } as unknown as Db,
    }

    // ① 指名道姓：这条守的是"记录改不掉"这件事本身，不是随便抛了什么
    await expect(handleReplaceWork(
      id, { image: `data:image/jpeg;base64,${bytesOf(999)}`, thumb: JPEG }, USER, broken,
    )).rejects.toThrow(/database is locked/)

    expect(db.raw.prepare('SELECT * FROM works WHERE id = ?').get(id)).toEqual(before)  // 记录一点没动
    expect(readdirSync(root)).toEqual([oldName])   // ★ 新图 + 新缩略图都收回去了，没多出第三个文件
  })

  it('旧缩略图删不掉 → 换图照样成功，但**响一声**（不静默）', async () => {
    // 和 handleDeleteWork 那条同一个规矩：吞掉不等于可以不说。
    // 旧缩略图删不掉在这里是**必然**会漏一个文件到盘上 —— 静默了，盘慢慢涨起来没人知道
    const { id } = await handleCreateWork({ image: JPEG, thumb: JPEG }, USER, deps)
    const oldThumb = (db.raw.prepare('SELECT thumb_name FROM works WHERE id = ?')
      .get(id) as { thumb_name: string }).thumb_name
    const flaky: Storage = {
      ...storage,
      remove: async (name) => {
        if (name === oldThumb) throw new Error('EACCES: 删不掉')
        return storage.remove(name)
      },
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 新图已经换好了，用户那边完全正常 —— 这一步失败不该让整条请求失败
      const meta = await handleReplaceWork(
        id, { image: `data:image/jpeg;base64,${bytesOf(999)}` }, USER, { ...deps, storage: flaky })

      expect(meta.hasThumb).toBe(false)
      expect(String(spy.mock.calls.flat().join(' '))).toContain('旧缩略图没删掉')
    } finally {
      spy.mockRestore()
    }
  })

  it('★ 批量删里 DELETE 抛（库忙）→ 整条请求失败，不许当 missing 吞掉', async () => {
    // ★ missing 的语义是「**目标已达成**」——前端照它把条目从界面上拿掉，
    // 用户不会再去管它。库忙 / 库损坏报成 missing，是拿一句"删掉了"盖住
    // "根本没删成"：下次刷新它又回来了，而用户早就不看这一条了。
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    const broken = {
      ...deps,
      db: {
        ...deps.db,
        raw: {
          prepare: (sql: string) => {
            if (sql.startsWith('DELETE')) throw new Error('database is locked')
            return deps.db.raw.prepare(sql)
          },
        },
      } as unknown as Db,
    }

    // ① 指名道姓：这条守的是"库真的错了"这件事本身，不是随便抛了什么
    await expect(handleDeleteWorks({ ids: [id] }, USER, broken)).rejects.toThrow(/database is locked/)
    // ② ★ 它不是 missing：记录和文件都还在，用户重来一次还能真的删掉
    expect(handleListWorks(USER, deps).works.map((w) => w.id)).toEqual([id])
    expect(readdirSync(root).length).toBe(1)
  })

  it('ids 里有不是正整数的 → 整个请求 400，不许悄悄丢掉（丢掉就是静默）', async () => {
    // ★ 悄悄滤掉的话，那个 id **两个桶里都不在** —— 请求里 12 个、回来说是"删了 10 个"，
    // 少的两个既没删掉也没报出来。这正是 §3.5 要治的那种静默。
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    // ⚠️ **指名道姓** —— 这条守的是"id 不合法"这件事本身
    await expect(handleDeleteWorks({ ids: [id, 'x'] }, USER, deps)).rejects.toThrow(/正整数/)
    await expect(handleDeleteWorks({ ids: [id, 0] }, USER, deps)).rejects.toThrow(/正整数/)
    await expect(handleDeleteWorks({ ids: [id, 1.5] }, USER, deps)).rejects.toThrow(/正整数/)
    // ★ **整个请求**都别动：合法的那个也不能删 —— 不然就成了"我说删两张、它说删了一张"
    expect(handleListWorks(USER, deps).works.map((w) => w.id)).toEqual([id])
  })

  it('同一个 id 来两次 → 只算删了一次（不许同时进两个桶）', async () => {
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)

    const r = await handleDeleteWorks({ ids: [id, id] }, USER, deps)

    expect(r.deleted).toEqual([id])
    // ★ 不去重的话第二次会当"它已经不在了"进 missing —— 同一个 id 同时出现在两个桶里，
    // 按 deleted.length 报"删了 N 张"的前端会多算一个
    expect(r.missing).toEqual([])
    expect(handleListWorks(USER, deps).works).toEqual([])
  })

  it('ids 不是数组 / 空的 / 超过 500 → 400，而且一张都没删', async () => {
    const { id } = await handleCreateWork({ image: JPEG }, USER, deps)
    // ① 不是数组（连 ids 都没有，走同一条）
    await expect(handleDeleteWorks({ ids: '不是数组' }, USER, deps)).rejects.toThrow(/没给要删哪些/)
    await expect(handleDeleteWorks({}, USER, deps)).rejects.toThrow(/没给要删哪些/)
    // ② 空的
    await expect(handleDeleteWorks({ ids: [] }, USER, deps)).rejects.toThrow(/没给要删哪些/)
    // ③ 上限（500 这个数是 brief 定死的，501 张）
    const many = Array.from({ length: 501 }, (_, i) => i + 1)
    await expect(handleDeleteWorks({ ids: many }, USER, deps)).rejects.toThrow(/一次最多删 500 张/)

    // ★ 三条都必须在**动任何东西之前**拒掉：先删后校验的话，多出来的那一个已经是"删了才报错"
    expect(handleListWorks(USER, deps).works.map((w) => w.id)).toEqual([id])
    expect(readdirSync(root).length).toBe(1)
  })
})

/**
 * ★ 2026-10-04（spec §6.6）：每人 5 GB。**不是防用户，是防止一个人把整台服务搞挂** ——
 * 数据库和图片在**同一块盘**上，盘满之后注册、登录、看作品集全部失败。
 *
 * ⚠️ 这里不去真存 5 GB：配额只读库里那一列，所以直接把一行的 `bytes` 写成上限。
 */
describe('★ 5 GB 配额（作品）', () => {
  const fillUp = (bytes: number) => {
    db.raw.prepare(
      `INSERT INTO works (user_id, stored_name, thumb_name, bytes, created_at, updated_at, alias, recipe)
       VALUES (?, 'filler.jpg', NULL, ?, 1, 1, NULL, '{"params":{},"edits":[]}')`,
    ).run(USER.id, bytes)
  }

  it('满了之后：新的一张存不进去 —— 而且那句话要给出路（先下载、再删几张）', async () => {
    fillUp(QUOTA_BYTES)
    await expect(handleCreateWork({ image: JPEG }, USER, deps))
      // ★ 2026-10-11（设计跟进 T4 fix）：正则**连名字一起钉** —— 原来写的是
      // `/空间满了.*下载.*删/`，「下载」和「下载到电脑」两个名字都过，名字漂了
      // 一声不吭。这句原文经 `saveFail.why` **原样显示**在那条横幅上，就挨着
      // 叫「下载」的那颗按钮（《文案规范》二.2：同一件东西只有一个名字）。
      .rejects.toThrow(/空间满了.*「下载」.*删/)
    // 盘上**一个字节都没写**（`filler.jpg` 只是库里那一行，本来就不在盘上）——
    // 先看配额、后落盘，拒掉的时候什么都没留下
    expect(readdirSync(root)).toEqual([])
  })

  it('★ 替换算"净增"要扣掉旧的：满仓时换一张更小的仍然可以', async () => {
    fillUp(QUOTA_BYTES)
    const { id } = db.raw.prepare('SELECT id FROM works WHERE stored_name = ?')
      .get('filler.jpg') as { id: number }
    // 旧的那份字节会被腾出来（freeing）—— 不扣的话，满仓的人连"换张小的"都做不了
    const meta = await handleReplaceWork(id, { image: `data:image/jpeg;base64,${bytesOf(10)}` }, USER, deps)
    expect(meta.bytes).toBe(10)
  })
})

/**
 * ★★ 2026-10-04（审计 F3）。和 `sessions.test.ts` 那条**同一个形状**：
 * `handleReplaceWork` 整段是「读那一行 → `await` 落盘 → 写回去」，中间那个 await
 * 让出了事件循环 —— 两个标签页同时保存会都读到旧行，后写的把先写的整个盖掉
 * （**两次都回 200**），先写者刚落盘的文件从此没人认领（永久孤儿）；
 * 一边 PUT 一边 DELETE 更糟 —— UPDATE 影响 0 行却照样回 200。
 * 修法照会话那份：`AND updated_at = ?` 乐观锁 + `changes === 0` 报 409。
 */
describe('★ 同一张作品被两条路同时改', () => {
  it('★★ 后到的那条要**报出来**（409），不许把先到的那次静默盖掉', async () => {
    const { id } = await handleCreateWork({ image: JPEG }, USER, { ...deps, now: () => 100 })
    const before = readdirSync(root)

    const results = await Promise.allSettled([
      handleReplaceWork(id, { image: `data:image/jpeg;base64,${bytesOf(999)}` }, USER, { ...deps, now: () => 500 }),
      handleReplaceWork(id, { image: `data:image/jpeg;base64,${bytesOf(888)}` }, USER, { ...deps, now: () => 600 }),
    ])

    // 判据写"**恰好一条成功**"：只钉"有一条成功"的话，两条都成功照样绿 —— 而那正是 bug 的形状
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as HttpError).status).toBe(409)
    // ★ 失败那一次刚落盘的文件**必须被收回去** —— 不收就是一个没人认领的孤儿
    expect(readdirSync(root)).toHaveLength(1)
    expect(readdirSync(root)[0]).not.toBe(before[0])
  })

  it('★ 把"另一条路已经改过"夹在读与写之间 → 409（确定性版：不赌两次 I/O 的先后）', async () => {
    // 用一层 storage 包装**精确注入**那个夹缝：这一次落盘之后、UPDATE 之前，
    // 让"另一条路"把版本号推走 —— 于是这次 UPDATE 拿着旧版本，影响 0 行。
    // 少了 `AND updated_at = ?` 的话它会照样回 200（旧内容被静默盖掉）。
    const { id } = await handleCreateWork({ image: JPEG }, USER, { ...deps, now: () => 100 })
    const racing: typeof deps = {
      ...deps,
      now: () => 500,
      storage: {
        ...storage,
        save: async (b: Uint8Array, e: string) => {
          const name = await storage.save(b, e)
          db.raw.prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(999, id)
          return name
        },
      },
    }
    await expect(handleReplaceWork(id, { image: JPEG }, USER, racing)).rejects.toThrow(/改过了/)
    // 新文件收回去了：库里和盘上都还是原来那版
    expect(readdirSync(root)).toHaveLength(1)
  })
})
