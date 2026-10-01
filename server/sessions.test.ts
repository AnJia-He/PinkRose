import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from './db.ts'
import { createStorage, type Storage } from './storage.ts'
import {
  handleCreateSession, handleGetSession, handleUpdateSession, handleDeleteSession,
} from './sessions.ts'
// ⚠️ `handleListSessions` / `handleSessionFile` / `handleSessionStepFile` 这三条这里**故意不 import**：
// 它们的入口是 HTTP 那几条路由（Task 2），在本文件的用例里一条都用不上 ——
// 按任务书原文 import 进来的话，`noUnusedLocals` 会把这三行直接判成 TS6133。
import { HttpError } from './http.ts'
// ⚠️ 「删了会话，作品还在」那一条要用到作品那一层 —— 它守的正是**两层互不牵连**
import { handleCreateWork, handleGetWork, handleWorkFile } from './works.ts'
import { ZERO } from '../shared/adjustments.ts'

let dir: string; let db: Db; let storage: Storage
/** 图片目录。几条"盘上留没留下东西"的断言直接看它 */
let photos: string
const user = { id: 1, username: '小明', email: 'a@b.c' }
const other = { id: 2, username: '小红', email: 'd@e.f' }
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([1, 2, 3, 4]).toString('base64')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ruixing-sessions-'))
  photos = join(dir, 'photos')
  db = openDb(join(dir, 'test.db'))
  db.raw.prepare('INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?,?,?,?,?)')
    .run(1, '小明', 'a@b.c', 'x', 0)
  db.raw.prepare('INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?,?,?,?,?)')
    .run(2, '小红', 'd@e.f', 'x', 0)
  storage = createStorage(photos)
})
afterEach(() => {
  // ⚠️ 先关库再删目录：这个夹具用的是**真文件**库（不是 ':memory:'），
  // 句柄还开着的时候 Windows 的 rmSync 会 EPERM —— 每条用例都在 afterEach 里炸一次，
  // 而那个错和被测行为毫无关系（和 `works.test.ts` 的 afterEach 同一个理由）。
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const deps = () => ({ db, storage })

describe('建会话', () => {
  it('传一张原图 → 有 id 了，原图和 base 指同一个文件', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    const row = db.raw.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any
    expect(row.original).toBe(row.base)
    expect(JSON.parse(row.files)).toEqual([row.original])
    expect(row.title).toBeNull()          // 还没说话，标题是空的 —— 不是空串
    expect(row.original_name).toBeNull()  // 没给名字就是 null，不是空串
  })

  it('★ 传了原图名 → 存下来（spec §6.3 的列表标题靠它）', async () => {
    const { id } = await handleCreateSession({ image: JPEG, name: '古镇.jpg' }, user, deps())
    const row = db.raw.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any
    expect(row.original_name).toBe('古镇.jpg')
  })

  it('★ 图太大 → 413，而且**盘上不留东西**', async () => {
    const big = 'data:image/jpeg;base64,' + Buffer.alloc(9 * 1024 * 1024).toString('base64')
    // ★ 判据是"前后一模一样"，不是"rejects 了就算" —— 只断言 rejects 的话，
    //   一个"先落盘再校验"的实现照样绿，而那时盘上已经躺着一个没人认领的文件了。
    //   （`photos` 目录可能还没被建出来，所以先兜一下。）
    const before = existsSync(photos) ? readdirSync(photos) : []
    await expect(handleCreateSession({ image: big }, user, deps())).rejects.toThrow(/太大/)
    expect(existsSync(photos) ? readdirSync(photos) : []).toEqual(before)
  })
})

describe('取一条', () => {
  // ⚠️ 这里**不能**写 `handleGetSession(...).catch(...)`：`handleGetSession` 是**同步**的
  // （见任务书的 Interfaces），同步抛出的错**挂不上 `.catch`** —— 它会在 `.catch` 被求值
  // 之前就把整行炸掉，测试红在"抛了个错"上，而不是红在断言上。
  // 包一层才拿得到那个错本身（顺带还能断言状态码，光比消息看不出它是不是 404）。
  const errOf = async (f: () => unknown): Promise<HttpError> => {
    try {
      await f()
    } catch (e) {
      return e as HttpError
    }
    throw new Error('这一句本该抛，却没有')
  }

  it('★ 别人的会话 → 404，而且和"不存在"说的是**同一句话**', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    const a = await errOf(() => handleGetSession(id, other, deps()))
    const b = await errOf(() => handleGetSession(99999, other, deps()))
    expect(a.status).toBe(404)
    expect(a.message).toBe(b.message)
  })
})

const step = (id: number, params = ZERO) => ({ id, label: '调色', params, at: id })

describe('更新', () => {
  it('★ 传一步新图 → 存成新文件，名单多一个，base 指过去', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    const before = JSON.parse((db.raw.prepare('SELECT files FROM sessions WHERE id=?').get(id) as any).files)
    await handleUpdateSession(id, {
      base: JPEG, steps: [step(1), step(2)], title: '去掉路人',
    }, user, deps())
    const row = db.raw.prepare('SELECT * FROM sessions WHERE id=?').get(id) as any
    const files = JSON.parse(row.files)
    expect(files.length).toBe(before.length + 1)
    expect(row.base).not.toBe(row.original)
    expect(row.title).toBe('去掉路人')
    expect(row.base).toBe(files[files.length - 1])   // base 永远是名单最后一个新文件
  })

  it('★ 拖滑块那种更新：不传 base → **一个新文件都不该多**', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    const n0 = JSON.parse((db.raw.prepare('SELECT files FROM sessions WHERE id=?').get(id) as any).files).length
    await handleUpdateSession(id, { steps: [step(1), step(2, { ...ZERO, exposure: 20 })] }, user, deps())
    const n1 = JSON.parse((db.raw.prepare('SELECT files FROM sessions WHERE id=?').get(id) as any).files).length
    expect(n1).toBe(n0)
  })

  // ★ 这条守的是计划开头那句"**服务端自己给每一步分配图片文件**"。
  //   ⚠️ 这里原本写的是"送一个别人的文件名 → 整个请求拒掉"，**那条永远绿不了**：
  //   `mergeSteps` 压根不读客户端送来的 `image`，所以 `requireOwnFile` 从来不会
  //   因为它抛。真正要守的性质是**忽略**（不是拒绝）—— 断言"忽略"才是那条
  //   真会变红的测试。
  it('★ 客户端在步骤里塞 image 字段 → 服务端把它当不存在', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    const victim = await handleCreateSession({ image: JPEG }, user, deps())
    const stolen = (db.raw.prepare('SELECT original FROM sessions WHERE id=?')
      .get(victim.id) as any).original

    await handleUpdateSession(id, { steps: [{ ...step(1), image: stolen } as any] }, user, deps())

    const row = db.raw.prepare('SELECT * FROM sessions WHERE id=?').get(id) as any
    const stored = JSON.parse(row.steps)[0]
    expect(stored.image).not.toBe(stolen)                   // 没引用别人的
    expect(JSON.parse(row.files)).toContain(stored.image)   // 用的是自己名下的
  })
})

describe('删', () => {
  it('★ 删了会话，它名下的文件一个不剩', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { base: JPEG, steps: [step(1), step(2)] }, user, deps())
    const files = JSON.parse((db.raw.prepare('SELECT files FROM sessions WHERE id=?').get(id) as any).files)
    await handleDeleteSession(id, user, deps())
    for (const f of files) {
      await expect(storage.read(f)).rejects.toThrow()
    }
  })

  // ★★ 这一条是设计文档 §9 点名的三处之一。**错了不会报错，只会静静地错**：
  //    用户保存走的那张图，不该因为他回头删了会话就消失 —— 作品是**独立的一份拷贝**。
  it('★★ 删了会话，它存过的作品**还在**', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { base: JPEG, steps: [step(1), step(2)] }, user, deps())
    // 用户按了「保存」：作品是**另存的一份**，指向它自己的文件
    // （⚠️ handleCreateWork 回的是 `{ id }`，要解出来 —— 直接把整个对象当 id 用，
    //   node:sqlite 会把它当成"具名参数"去绑，报 Unknown named parameter 'id'）
    const { id: workId } = await handleCreateWork({ image: JPEG }, user, deps())

    await handleDeleteSession(id, user, deps())

    const work = handleGetWork(workId, user, deps())
    expect(work.id).toBe(workId)
    // 文件也真的还在（不是只剩一条打不开的记录）
    await expect(handleWorkFile(workId, user, deps())).resolves.toBeTruthy()
  })
})
