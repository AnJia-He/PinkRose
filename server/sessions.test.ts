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

  // ★ 建那条路早有一条"盘上不留东西"的判据（describe '建会话' 里），更新这条路当时没有 ——
  //   于是漏了一个：`mergeSteps`（还有清洗 messages 的 `readMessages`）**在 storage.save
  //   之后、清收 try 之外**跑，它一抛，刚落盘那个 ≤8 MB 的文件就留在盘上：
  //   没有任何一行记录引用它，删会话也收不到它 —— 而每个这样的请求都漏一个，可以无限打。
  //   判据和建那条一样，是"目录前后一模一样"，不是"rejects 了就算"。
  it('★ 校验在半程炸掉（步骤缺 id）→ 刚写的新文件也不许留在盘上', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    const before = readdirSync(photos).sort()
    // base 是合法的先落了盘，`steps` 里那一条没有 id → mergeSteps 当场抛
    await expect(handleUpdateSession(id, { base: JPEG, steps: [{ label: 'x' }] }, user, deps()))
      .rejects.toThrow(/正整数/)
    expect(readdirSync(photos).sort()).toEqual(before)
  })

  // ★ 和上面那条同一个形状，换 `messages` 里的坏货：`readMessages` 里的 `asObject` 会抛，
  //   同样在 save 之后。两条一起守"后半程抛了也要把刚写的收回来"。
  it('★ 校验在半程炸掉（消息不是对象）→ 刚写的新文件也不许留在盘上', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    const before = readdirSync(photos).sort()
    await expect(handleUpdateSession(id, { thumb: JPEG, messages: ['不是对象'] }, user, deps()))
      .rejects.toThrow()
    expect(readdirSync(photos).sort()).toEqual(before)
  })

  // ⚠️ `steps` 那边早有 `Array.isArray` 守卫（送坏了就保留历史），`messages` 原来没有 ——
  //   一个把 messages 送成对象的客户端 bug 会把用户的整段对话**静默**清成 `[]`，
  //   正是"错了不会报错，只会静静地错"那一类。这条断言的就是"和 steps 同一条口径"。
  it('★ messages 送成非数组 → 库里的对话原样保留（不许静默清空）', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(
      id, { messages: [{ id: 1, role: 'user', text: '把路人去掉', at: 5 }] }, user, deps())
    const before = (db.raw.prepare('SELECT messages FROM sessions WHERE id=?').get(id) as any).messages

    await handleUpdateSession(id, { messages: { not: 'an array' } as any }, user, deps())

    const after = (db.raw.prepare('SELECT messages FROM sessions WHERE id=?').get(id) as any).messages
    expect(after).toBe(before)
    expect(JSON.parse(after).length).toBe(1)
  })
})

/**
 * ★ 这一组守的是验收线第 1 条里那三个字：**参数全在**。
 *
 * 为什么参数必须**单独走一个字段**、而不是跟着 `steps` 走：客户端里 `params` 和
 * `history` 是两回事 —— `App.tsx` 有一句既有裁定「**改 params 从来不 push 快照
 * （裁定 ⑤）**」，拖滑块 / 套预设 / 按重置都只 `setParams`，`history` 一动不动。
 * 而落盘那条路是挂在 `history` 上的 —— 参数不带自己的一条路，
 * 用户拖完滑块刷新一下就回到拖之前的样子（见 `SessionPatch.params` 那段注释）。
 */
describe('更新 · 参数', () => {
  /** 库里 `steps` 那一列的**原样字符串**。好几条断言的判据是"逐字节"，不是"解析后相等" */
  const rawSteps = (id: number): string =>
    (db.raw.prepare('SELECT steps FROM sessions WHERE id=?').get(id) as any).steps
  const stepsOf = (id: number): any[] => JSON.parse(rawSteps(id)) as any[]

  it('★ 送一版 params → 落在**最后一步**上（拖滑块那种更新的落点）', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { steps: [step(1), step(2)] }, user, deps())

    // 客户端拖完滑块只送这一样：没有 base、没有新步骤（裁定 ⑤：history 根本没变）
    await handleUpdateSession(id, { params: { ...ZERO, exposure: 20 } }, user, deps())

    const steps = stepsOf(id)
    expect(steps).toHaveLength(2)              // 没凭空多出一步、也没少掉一步
    expect(steps[1].params.exposure).toBe(20)  // 最后一步 = 现在屏幕上那一版
    expect(steps[0].params.exposure).toBe(0)   // 历史那一步没被顺手改掉
  })

  it('★ 三步：params 只动最后一步，前面几步**一个字节不碰**', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { steps: [step(1), step(2), step(3)] }, user, deps())
    const before = stepsOf(id)

    await handleUpdateSession(id, { params: { ...ZERO, exposure: 20 } }, user, deps())

    const after = stepsOf(id)
    expect(after).toHaveLength(3)
    // 判据是"逐字节相同" —— "客户端不能改写历史"（`mergeSteps` 规则 ②）这条规矩
    // 不能因为参数就被撬开一个口子
    expect(JSON.stringify(after.slice(0, 2))).toBe(JSON.stringify(before.slice(0, 2)))
    expect(after[2].params.exposure).toBe(20)
  })

  it('★ 不送 params → 步骤那一列逐字节原样（不是"不送就写成全零"）', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(
      id, { steps: [step(1), step(2, { ...ZERO, exposure: 20 })] }, user, deps())
    const before = rawSteps(id)

    // 这次只换标题。一个"不送就当全零"的实现会把最后一步的参数**静默抹掉** ——
    // 正是"错了不会报错，只会静静地错"那一类
    await handleUpdateSession(id, { title: '换个名字' }, user, deps())

    expect(rawSteps(id)).toBe(before)
  })

  // ★ 这一条守的是实现里那句「**换一个对象，别原地改**」。为什么会有人原地改：
  //   `mergeSteps` 对库里已有的一步走的是 `out.push(old)` —— 推的是**库里那一条的
  //   同一个引用**。只要最后一步是"沿用的旧步"，`steps[last].params = …` 那种写法
  //   就会顺手改到 `prevSteps` 里那个对象上。
  //   ⚠️ 光有上面"三步"那个场景**抓不住**：那里每一步是各自独立的对象，原地改伤不到
  //   别人。要让别名真的显形，得让**同一个对象在数组里出现两次** —— 客户端把同一个 id
  //   送两遍就是这样（`byId.get(id)` 两次拿到同一个 `old`，`out` 里两个槽位是它）。
  //   这一条就是那个形状：原地改会让**前面那一步**跟着变，断言当场变红。
  it('★ 别名：最后一步和前面一步是同一个对象时，原地改会连前面那一步一起改掉', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { steps: [step(1)] }, user, deps())
    const first = stepsOf(id)[0]

    await handleUpdateSession(
      id, { steps: [step(1), step(1)], params: { ...ZERO, exposure: 20 } }, user, deps())

    const steps = stepsOf(id)
    expect(steps).toHaveLength(2)
    expect(steps[1].params.exposure).toBe(20)                    // 新的一版落在最后一步
    expect(steps[0].params.exposure).toBe(0)                     // 前面那一步没被牵连
    expect(JSON.stringify(steps[0])).toBe(JSON.stringify(first)) // 逐字节相同
  })

  it('★ params 送成字符串 → 当场拒掉，连刚落盘的 base 也要收回来（不是静默写成全零）', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { steps: [step(1)] }, user, deps())
    const beforeSteps = rawSteps(id)
    const beforeFiles = readdirSync(photos).sort()

    // `asObject` 的口径：不是普通对象就抛 `HttpError('BAD_REQUEST')`。
    // ⚠️ 这一句顺带守着这段代码**在不在清理 try 里面**：块要是被摆到 try 外面，
    //    `base` 已经落了盘、这一抛就把它漏在盘上了（目录前后比对会红）。
    await expect(handleUpdateSession(id, { base: JPEG, params: '不是对象' }, user, deps()))
      .rejects.toThrow(/请求体不对/)

    expect(rawSteps(id)).toBe(beforeSteps)     // 拒掉 = 库那一列一个字节没改
    expect(readdirSync(photos).sort()).toEqual(beforeFiles)
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
