import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from './db.ts'
import { createStorage, type Storage } from './storage.ts'
import {
  handleCreateSession, handleGetSession, handleUpdateSession, handleDeleteSession,
  handleSessionStepFile, backfillSessionBytes,
} from './sessions.ts'
// ⚠️ `handleListSessions` / `handleSessionFile` 这两条这里**故意不 import**：
// 它们的入口是 HTTP 那几条路由（Task 2），在本文件的用例里一条都用不上 ——
// 按任务书原文 import 进来的话，`noUnusedLocals` 会把这两行直接判成 TS6133。
// （`handleSessionStepFile` 2026-10-08 起要用了 —— 「stateStepId」那一组问的是
//   "这一步盘上读回来的**是不是新图**"，而它读的就是这一步自己的 `image`。）
import { HttpError } from './http.ts'
// ⚠️ 「删了会话，作品还在」那一条要用到作品那一层 —— 它守的正是**两层互不牵连**
import { handleCreateWork, handleGetWork, handleWorkFile } from './works.ts'
import { ZERO } from '../shared/adjustments.ts'
import { DEFAULT_TEXT } from '../shared/text.ts'
import { DEFAULT_SHAPE } from '../shared/shape.ts'
import { DEFAULT_STICKER } from '../shared/sticker.ts'
import { QUOTA_BYTES } from './quota.ts'
import { createLut } from './luts.ts'
import { saveSessionSummary } from './memory.ts'
import { b64Of, jpegBytes, jpegUrl } from './testImages.ts'

let dir: string; let db: Db; let storage: Storage
/** 图片目录。几条"盘上留没留下东西"的断言直接看它 */
let photos: string
const user = { id: 1, username: '小明', email: 'a@b.c' }
const other = { id: 2, username: '小红', email: 'd@e.f' }
// ⚠️ 文件头必须是真的：imagedata.ts 从 2026-10-02 起验魔数（安全审计）。
const JPEG = jpegUrl(4)

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
    // ⚠️ 也必须是真文件头 —— 不然它会先撞上魔数校验，测的就不是太大那一条了。
    const big = `data:image/jpeg;base64,${b64Of(jpegBytes(9 * 1024 * 1024))}`
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
    // ⚠️ 这一句在**这一条用例里**成立（没送 thumb，名单尾巴就是刚写的那张 base）。
    //    别把它当成"名单最后一条永远是 base"：送了缩略图的话，缩略图跟在 base 后面
    //    （缩略图也在名单里 —— 见下面「删完之后 photos 目录里一个文件都不剩」那条）。
    expect(row.base).toBe(files[files.length - 1])   // base 是这次新写的那个文件
  })

  it('★ 缩略图也进 `files` 名单 —— 它同样是这条会话名下的文件', async () => {
    // ⚠️ 这一条守的是**删除那条路唯一的依据**。缩略图住在自己那一列上，很容易
    //    被当成"不是文件"漏掉名单 —— 而漏掉的后果**一声不吭**：每删一条会话，
    //    盘上就多一个没人认领的缩略图，永久留着。
    //    （2026-10-02 在真机上数出来的：3 条删过的会话 = 3 个孤儿，大小都落在缩略图那一档。）
    const { id } = await handleCreateSession({ image: JPEG, thumb: JPEG }, user, deps())
    let row = db.raw.prepare('SELECT * FROM sessions WHERE id=?').get(id) as any
    expect(JSON.parse(row.files)).toContain(row.thumb)
    // 换一个缩略图：新的进去、**旧的从名单里拿掉**（旧文件这时已经被删了，
    // 名字再留着就是一张注销不掉的空头支票 —— `files` 同时还是许可名单）
    const oldThumb = row.thumb
    await handleUpdateSession(id, { thumb: JPEG }, user, deps())
    row = db.raw.prepare('SELECT * FROM sessions WHERE id=?').get(id) as any
    const files = JSON.parse(row.files)
    expect(files).toContain(row.thumb)
    expect(row.thumb).not.toBe(oldThumb)
    expect(files).not.toContain(oldThumb)
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

  it('★ 只追加新消息时保留内部摘要；改写被摘要覆盖的旧消息时摘要立即作废', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    const first = [{ id: 1, role: 'user' as const, text: '把人物提亮', at: 0 }]
    await handleUpdateSession(id, { messages: first }, user, deps())
    expect(saveSessionSummary(db, user.id, id, '已确认只提亮人物', 1)).toBe(true)

    await handleUpdateSession(id, {
      messages: [
        ...first,
        { id: 2, role: 'assistant' as const, text: '人物提亮了，背景没动。', at: 0 },
      ],
    }, user, deps())
    expect(db.raw.prepare('SELECT summary FROM session_memory WHERE session_id = ?').get(id))
      .toMatchObject({ summary: '已确认只提亮人物' })
    expect(handleGetSession(id, user, deps())).not.toHaveProperty('summary')

    await handleUpdateSession(id, {
      messages: [{ id: 1, role: 'user', text: '改成保留人物、提亮背景', at: 0 }],
    }, user, deps())
    expect(db.raw.prepare('SELECT * FROM session_memory WHERE session_id = ?').get(id))
      .toBeUndefined()
  })

  // ★ 2026-10-05：列表按 `updated_at DESC` 排、按天分组 —— 那个日期说的是
  //   "什么时候改的照片"。**改名是整理不是修图**：不把这一条挡住的话，用户给
  //   一条上周的会话改个名字，它会**当场跳到"今天"最前**（这个项目的规矩里，
  //   "静默的位置变化"和"静默丢东西"一样吓人）。判据：这一趟 PUT 只有 title。
  it('★ 只改名字 → 名字存进去、updated_at 一点不动', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, { db, storage, now: () => 1000 })
    await handleUpdateSession(id, { steps: [step(1)] }, user, { db, storage, now: () => 2000 })
    const at = () => (db.raw.prepare('SELECT updated_at FROM sessions WHERE id = ?').get(id) as any).updated_at
    expect(at()).toBe(2000)

    const meta = await handleUpdateSession(id, { title: '换个名字' }, user, { db, storage, now: () => 3000 })

    expect(at()).toBe(2000)              // 没被 3000 顶掉
    expect(meta.updatedAt).toBe(2000)    // 返回的 meta 也得是旧时间戳（前端拿它替换那一行）
    expect(meta.title).toBe('换个名字')   // 名字本身要真的存进去（别把整趟都吞了）
  })

  it('★ 名字和别的字段一起送 → updated_at 照动（判据只认"只有 title"那一趟）', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, { db, storage, now: () => 1000 })
    // 客户端落盘（App 改照片）永远带 params 一起上来 —— 那条路不许被这条例外误伤
    await handleUpdateSession(
      id, { title: '换个名字', params: { ...ZERO, exposure: 20 } }, user,
      { db, storage, now: () => 3000 })

    const row = db.raw.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any
    expect(row.updated_at).toBe(3000)
    expect(row.title).toBe('换个名字')
  })

  it('★ 名字跟着 `stateStepId` / `lut` 走也一样照动（判据里每一个字段都点名了）', async () => {
    // ★ 2026-10-08（账本 Task 7 顺手件）：`titleOnly` 那句话是"**只有 title 这一个
    //   字段**"，所以协议里**每一个**新字段都要在判据里点一次名 —— 漏一个就是
    //   "哪天有人拿它补一趟只改名的话，这条会话白白跳到今天最前"。
    //   变异：把 `o.stateStepId === undefined` / `o.lut === undefined` 任一条删掉
    //   → 下面两句红（`updated_at` 没被 3000 顶掉）。
    const { id } = await handleCreateSession({ image: JPEG }, user, { db, storage, now: () => 1000 })
    await handleUpdateSession(id, { steps: [step(1)] }, user, { db, storage, now: () => 2000 })
    const at = () => (db.raw.prepare('SELECT updated_at FROM sessions WHERE id = ?').get(id) as any).updated_at

    await handleUpdateSession(id, { title: '带状态步号', stateStepId: 1 }, user,
      { db, storage, now: () => 3000 })
    expect(at()).toBe(3000)

    await handleUpdateSession(id, { title: '带滤镜', lut: null }, user,
      { db, storage, now: () => 4000 })
    expect(at()).toBe(4000)
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

/**
 * ★ 2026-10-05（滤镜）。会话每一步可以带一个 `LutRef`（用哪个滤镜、强度多少）——
 * 和 `params` 是**并列的两件事**（见 `shared/lut.ts` 的 `LutRef` 那段）。
 *
 * 这一组守的是"不许悬空引用"那道闸的**第一道（写入时）**：客户端送来的 id 必须
 * 真的存在、而且是他自己的，认不出来一律落成 null。第二道（删除滤镜时回头清引用）
 * 在 `server/luts.test.ts`。
 */
describe('★ 滤镜引用（会话）', () => {
  /** 一个 2×2×2 恒等 cube（和 luts.test.ts 里那个同一份文本） */
  const CUBE2 = ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n')
  const rawSteps = (id: number): string =>
    (db.raw.prepare('SELECT steps FROM sessions WHERE id=?').get(id) as any).steps
  const stepsOf = (id: number): any[] => JSON.parse(rawSteps(id)) as any[]

  it('★ 步骤里的滤镜存得进、取得出；认不出来的被清成 null', async () => {
    const { lut } = await createLut({ name: 'x', cube: CUBE2 }, user, deps())
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, {
      steps: [{ id: 1, label: '原图', params: ZERO, at: 0, lut: { lutId: lut.id, amount: 70 } }],
    }, user, deps())

    expect(handleGetSession(id, user, deps()).steps[0]!.lut).toEqual({ lutId: lut.id, amount: 70 })

    // 一个**不存在**的 id 再存一次 —— 必须被清成 null。
    // 判据要读**库里那一列**：只看出口的话，一个"原样存、出口再挡一下"的实现照样绿，
    // 而那个悬空 id 会一直躺在库里（等别人来读，或者等"删除清引用"去清它）。
    await handleUpdateSession(id, {
      steps: [
        { id: 1, label: '原图', params: ZERO, at: 0 },
        { id: 2, label: '调色', params: ZERO, at: 1, lut: { lutId: 999999, amount: 100 } },
      ],
    }, user, deps())

    expect(stepsOf(id)[1].lut).toBeNull()
    expect(rawSteps(id)).not.toContain('999999')   // 不是"原样进库、出口才挡"
  })

  it('★ 别人的滤镜 id 也落成 null —— 闸查的是"他的"', async () => {
    const theirs = await createLut({ name: 'x', cube: CUBE2 }, other, deps())
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())

    await handleUpdateSession(id, {
      steps: [{ id: 1, label: '原图', params: ZERO, at: 0, lut: { lutId: theirs.lut.id, amount: 50 } }],
    }, user, deps())

    // 存在、但不是他的 —— 一样落成 null（`resolveLutRef` 查的是 id + user_id 一对）
    expect(stepsOf(id)[0].lut).toBeNull()
  })

  it('★「现在这一版」的滤镜写在最后一步上，前面几步一个字节不动', async () => {
    const { lut } = await createLut({ name: 'x', cube: CUBE2 }, user, deps())
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { steps: [step(1), step(2)] }, user, deps())
    const before = stepsOf(id)

    await handleUpdateSession(id, { lut: { lutId: lut.id, amount: 66 } }, user, deps())

    const after = stepsOf(id)
    expect(after).toHaveLength(2)
    expect(after[1].lut).toEqual({ lutId: lut.id, amount: 66 })  // 最后一步 = 现在屏幕上那一版
    expect(after[0].lut ?? null).toBeNull()                       // 历史那一步没被顺手补上
    // 前面几步**逐字节**相同 —— 和 params 那条同一个理由（客户端不能改写历史）
    expect(JSON.stringify(after.slice(0, 1))).toBe(JSON.stringify(before.slice(0, 1)))
  })

  it('★ 客户端拿一个不存在的 id 来改「现在这一版」→ 库里落的是 null', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { steps: [step(1)] }, user, deps())

    // 过期的 id（滤镜在别处被删了）：闸要让它落成 null，不是原样进库
    await handleUpdateSession(id, { lut: { lutId: 999999, amount: 100 } }, user, deps())

    expect(stepsOf(id)[0].lut).toBeNull()
    expect(rawSteps(id)).not.toContain('999999')
  })

  it('★ 老步骤（库里没这个键）读出来是**显式 null**，不是 undefined', async () => {
    // 2026-10-05 之前存的步骤没有 `lut` 这个键。出口（toSteps）必须把它落成显式
    // `null` —— 前端只看得到这一份，别再让每个调用点都自己判一次 undefined。
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    // 直接塞一条"老形状"的步骤（没有 lut 键）—— 不走 handleUpdateSession，
    // 因为写入这条路现在会把键补上
    db.raw.prepare('UPDATE sessions SET steps = ? WHERE id = ?')
      .run(JSON.stringify([{ id: 1, label: '调色', params: ZERO, at: 0, image: 'a.jpg' }]), id)

    expect(handleGetSession(id, user, deps()).steps[0]!.lut).toBeNull()
  })
})

/**
 * ★★ 2026-10-08（账本，设计 §7.1）：`stateStepId` —— "这趟的 `params`/`lut`/`base`
 * 说的是**哪一步**的现在"。
 *
 * 为什么需要它：调色区里改的是**当前那一版**，而用户可能站在任何一版上。旧的落盘
 * 协议把状态一律写在**最后一步**上（客户端拿 `atTip` 打补丁绕开误伤），于是"站在
 * 旧版本上拖滑块"存下去会**污染最新那一版**。新的窄口：指名哪一步，状态就落哪一步。
 *
 * 这一组钉四件事：**落点**对 / 新图**替换**那一步的 image / 校验（400）/ 不带它时
 * 旧行为照旧。
 */
describe('stateStepId：状态挂在指定的那一步上', () => {
  const rawSteps = (id: number): string =>
    (db.raw.prepare('SELECT steps FROM sessions WHERE id=?').get(id) as any).steps
  const stepsOf = (id: number): any[] => JSON.parse(rawSteps(id)) as any[]
  const filesOf = (id: number): string[] =>
    JSON.parse((db.raw.prepare('SELECT files FROM sessions WHERE id=?').get(id) as any).files) as string[]
  /**
   * 5 字节的 JPEG。和上面那个 `JPEG`（4 字节）**不同字节** —— "这一步盘上读回来的
   * 是不是新图"按**字节数**判：`handleSessionStepFile` 读的就是这一步自己的 `image`，
   * 名字层面的断言骗得过"名字换了、盘上还是旧图"，字节数骗不过去。
   */
  const JPEG2 = jpegUrl(5)

  it('★ params 写进 stateStepId 指的那一步（不是最后一步）', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { steps: [step(1), step(2)] }, user, deps())
    const before = stepsOf(id)

    await handleUpdateSession(id, {
      stateStepId: 1, params: { ...ZERO, exposure: 30 }, steps: [step(1), step(2)],
    }, user, deps())

    const after = stepsOf(id)
    expect(after[0].params.exposure).toBe(30)   // 指名的那一步：改了
    expect(after[1].params.exposure).toBe(0)    // 最后一步：一个字节不动
    // 判据是**逐字节相同**（和「更新 · 参数」那组同一条）：没被指名的步骤谁都不许碰
    expect(JSON.stringify(after[1])).toBe(JSON.stringify(before[1]))
  })

  it('★「现在这一版」的滤镜也落在 stateStepId 那一步上（和 params 同一条路）', async () => {
    // 一个 2×2×2 恒等 cube（和「滤镜引用（会话）」那一组同一份文本）
    const CUBE2 = ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n')
    const { lut } = await createLut({ name: 'x', cube: CUBE2 }, user, deps())
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { steps: [step(1), step(2)] }, user, deps())

    // ⚠️ 这一趟**不送 steps**（拖滑块 / 套滤镜的真实形状：history 没变）——
    //    落点全看 stateStepId
    await handleUpdateSession(id, { stateStepId: 1, lut: { lutId: lut.id, amount: 55 } }, user, deps())

    const steps = handleGetSession(id, user, deps()).steps
    expect(steps[0]!.lut).toEqual({ lutId: lut.id, amount: 55 })
    expect(steps[1]!.lut).toBeNull()   // 最后一步没被顺手补上
  })

  it('★ 文字 / 形状 / 贴纸层落在 stateStepId 那一步上；显式空数组能清掉，别的步骤不动', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { steps: [step(1), step(2)] }, user, deps())
    const layers = [{
      kind: 'text',
      id: 'text-1',
      options: { ...DEFAULT_TEXT, text: '你好', x: 0.2, y: 0.3, fontPx: 88 },
    }, {
      kind: 'shape',
      id: 'shape-1',
      options: { ...DEFAULT_SHAPE, kind: 'line', opacity: 70 },
    }, {
      kind: 'sticker',
      id: 'sticker-1',
      options: { ...DEFAULT_STICKER, shape: 'heart' },
      image: null,
    }]

    await handleUpdateSession(id, { stateStepId: 1, layers }, user, deps())
    const detail = handleGetSession(id, user, deps())
    expect(detail.steps[0]!.layers).toEqual(layers)
    expect(detail.steps[1]!.layers).toBeUndefined()

    await handleUpdateSession(id, { stateStepId: 1, layers: [] }, user, deps())
    expect(handleGetSession(id, user, deps()).steps[0]!.layers).toBeUndefined()
  })

  it('★★ 新文件落在 stateStepId 那一步的 image 上（替换掉旧图），不是"最后一个新步骤"', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { base: JPEG, steps: [step(1)] }, user, deps())
    const first = stepsOf(id)[0].image           // 这一步原来用的那张

    await handleUpdateSession(id, { base: JPEG2, stateStepId: 1, steps: [step(1)] }, user, deps())

    const after = stepsOf(id)
    const row = db.raw.prepare('SELECT * FROM sessions WHERE id=?').get(id) as any
    expect(after).toHaveLength(1)                // 没凭空多出一步
    expect(after[0].image).not.toBe(first)       // 换上了新文件
    expect(after[0].image).toBe(row.base)        // 换上的**就是**这趟新写的那份
    // 最强判据：按步读回来的**字节数**（4 → 5）
    expect((await handleSessionStepFile(id, 1, user, deps())).bytes.byteLength).toBe(5)
    // ⚠️ 旧文件**不删**（`files` 只增不减）：还在名单里 —— 删会话时收得走
    expect(filesOf(id)).toContain(first)
    expect(readdirSync(photos)).toContain(first)
  })

  // ★★ 2026-10-08（终审 Important）：规则 ④ 那口子长在 `mergeSteps` 里，而它只在
  //   **送了 `steps`** 时才跑 —— 于是 `{stateStepId, base}` 这种**不带 steps**的形状
  //   （拖滑块 / 只换底的那趟，协议里完全合法）会静默落空：回 200、`base` 列与 `files`
  //   都更新了，但**那一步的 `image` 一个字节没动**。而恢复是按步取 `sessionStepUrl`
  //   的 → 刷新后这一版还是旧图、**不报错**。这条就是那个形状。
  it('★★ `base` + stateStepId、**不带 steps**：那一步的 image 也要真的换掉（不是只换 `base` 列）', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { base: JPEG, steps: [step(1)] }, user, deps())
    const first = stepsOf(id)[0].image

    // ⚠️ 不带 steps（history 没变的那趟）；落点全看 stateStepId
    await handleUpdateSession(id, { base: JPEG2, stateStepId: 1 }, user, deps())

    const after = stepsOf(id)
    const row = db.raw.prepare('SELECT * FROM sessions WHERE id=?').get(id) as any
    expect(after).toHaveLength(1)                 // 没凭空多出一步
    expect(after[0].image).not.toBe(first)        // 换了，不是"只换了 base 列"
    expect(after[0].image).toBe(row.base)         // 换上的**就是**这趟新写的那份
    // 判据口径同上面那条：按步读回来的**字节数**（4 → 5）
    expect((await handleSessionStepFile(id, 1, user, deps())).bytes.byteLength).toBe(5)
    // 旧文件不删、仍在名单里
    expect(filesOf(id)).toContain(first)
  })

  it('★ stateStepId 指的步骤不存在 → 400（新信任边界），库一个字节不改', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { steps: [step(1)] }, user, deps())
    const before = rawSteps(id)

    // ⚠️ 这一趟**没送 base**：校验不许只在"要换 image"那条支路上跑 —— 少了这一道，
    //    params 会被**一声不吭**地丢掉（`findIndex` 找不到、那个 `if` 直接跳过），
    //    正是这个项目最恨的"错了不报错，只会静静地错"。
    await expect(
      handleUpdateSession(id, { stateStepId: 999, params: ZERO, steps: [step(1)] }, user, deps()),
    ).rejects.toMatchObject({ status: 400 })

    // 同一条边界的**另一种形状**：不带 `steps` 也一样（那时"合并后" = 库里那串）。
    // ⚠️ 这一趟带了 base：新文件已经落了盘，400 之后必须被 catch 收走
    //    （判据是目录前后一模一样，和「更新」那组两条同一个口径）。
    const photosBefore = readdirSync(photos).sort()
    await expect(handleUpdateSession(id, { stateStepId: 999, base: JPEG2 }, user, deps()))
      .rejects.toMatchObject({ status: 400 })
    expect(readdirSync(photos).sort()).toEqual(photosBefore)
    expect(rawSteps(id)).toBe(before)
  })

  it('★ stateStepId 得是正整数（0 / 1.5 / "1" 一律 400，不是静默当没带）', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { steps: [step(1)] }, user, deps())

    for (const bad of [0, -1, 1.5, '1', true]) {
      await expect(handleUpdateSession(id, { stateStepId: bad as any, params: ZERO }, user, deps()))
        .rejects.toMatchObject({ status: 400 })
    }
    expect(stepsOf(id)[0].params.exposure).toBe(0)   // 一次都没落进去
  })

  it('★ 不带 stateStepId = 旧行为照旧（params 落最后一步、新文件落最后一个新步骤）', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    await handleUpdateSession(id, { steps: [step(1)] }, user, deps())

    await handleUpdateSession(id, {
      base: JPEG2, steps: [step(1), step(2)], params: { ...ZERO, exposure: 12 },
    }, user, deps())

    const after = stepsOf(id)
    expect(after[0].params.exposure).toBe(0)             // 历史那一步没被碰
    expect(after[1].params.exposure).toBe(12)            // 最后一步 = 现在屏幕上那一版
    expect(after[1].image).not.toBe(after[0].image)      // 新文件落在最后一个**新**步骤上
    expect((await handleSessionStepFile(id, 2, user, deps())).bytes.byteLength).toBe(5)
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

  it('★★ 删完之后 photos 目录里**一个文件都不剩** —— 名单之外也不许留', async () => {
    // ⚠️ 上面那一条是**照着 `files` 那份名单去查**的 —— 名单里少一个文件，它就
    //    跟着少查一个，**永远不会红**。而名单确实一直少一个：**缩略图从来没进过
    //    `files`**（它住在自己那一列上），而删除这条路上只看名单。
    //
    //    真凭实据（2026-10-02 本机数出来的）：盘上 1554 个文件，只有 **3** 个
    //    不被任何一行引用 —— 而那 3 个正好就是删过的 3 条会话（id 90/92/102），
    //    一条一个，大小都落在缩略图那一档。**不是竞态，是每删必漏。**
    //    其中最新那个（`2ce2b111….jpg`，16115 字节）就是用户那天自己传的那张的
    //    缩略图：会话行没了（`sqlite_sequence` 到 102，`max(id)` 只剩 101），
    //    文件还在盘上躺着。
    //
    //    所以判据只能看**目录本身** —— 它不依赖任何人的名单写得对不对。
    const { id } = await handleCreateSession({ image: JPEG, thumb: JPEG }, user, deps())
    // 再换一次底图 + 缩略图（被换掉的那个缩略图当场就该删，见 handleUpdateSession）
    await handleUpdateSession(id, { base: JPEG, thumb: JPEG, steps: [step(1)] }, user, deps())
    await handleDeleteSession(id, user, deps())
    expect(existsSync(photos) ? readdirSync(photos) : []).toEqual([])
  })
})

/**
 * ★★ 2026-10-02（安全审计，已复现）。这一条守的是**并发**那条路。
 *
 * `handleUpdateSession` 整段是：**读那一行 → `await` 落盘 → 写回去**。
 * 中间那个 await 让出了事件循环 —— 于是两条并发的 PUT 会**都读到旧的那一行**，
 * 后写的把先写的整个盖掉：**两次都回 200**，先写者那一步就静默消失了。
 * 而它落盘的那个文件不在 `files` 名单里，删会话也收不走（永久孤儿）。
 * 窗口很宽：`storage.save` 写一张 8 MB 的图本身就是一次 await。
 *
 * 判据写的是"**恰好一条成功**"而不是"某一条成功"：只钉后者的话，
 * "两条都成功"照样绿 —— 而那正是这个 bug 的形状。
 */
describe('★ 同一条会话被两条路同时改', () => {
  it('★★ 后到的那条要**报出来**，不许把先到的那一步静默吃掉', async () => {
    const d = deps()
    const { id } = await handleCreateSession({ image: JPEG }, user, d)
    const before = readdirSync(photos).sort()

    const results = await Promise.allSettled([
      handleUpdateSession(id, { base: JPEG, steps: [step(1), step(2)] }, user, d),
      handleUpdateSession(id, { base: JPEG, steps: [step(1), step(3)] }, user, d),
    ])

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    // 不能是"没登录""图不对"这类误导人的说法 —— 是**版本打架**
    expect((rejected.reason as HttpError).status).toBe(409)

    // 库里留下的那几步，每一张图都要在名单里（不然删会话收不走 = 永久孤儿）
    const row = db.raw.prepare('SELECT steps, files FROM sessions WHERE id = ?').get(id) as
      { steps: string; files: string }
    for (const s of JSON.parse(row.steps) as { image?: string }[]) {
      if (s.image) expect(JSON.parse(row.files)).toContain(s.image)
    }
    // 盘上只该多出**成功那条**写的那个文件（失败那条的已经收回）
    expect(readdirSync(photos).length).toBe(before.length + 1)
  })
})

/**
 * ★ 2026-10-04（spec §6.6）：每人 5 GB —— 作品**和会话**一起算。
 * 会话才是真正会长的地方（每上传一张照片都要存原图 + 每一步的底），
 * 只卡作品等于把审计那条"可无限写"原样留着。
 * ⚠️ 不去真存 5 GB：配额只读库里那一列，把它的 `bytes` 写成上限就行。
 */
describe('★ 5 GB 配额（会话）', () => {
  const fillUp = (bytes: number) => {
    db.raw.prepare(
      `INSERT INTO sessions (user_id, created_at, updated_at, title, original, original_name,
         base, thumb, messages, steps, files, bytes)
       VALUES (?, 1, 1, NULL, 'filler.jpg', NULL, 'filler.jpg', NULL, '[]', '[]', '["filler.jpg"]', ?)`,
    ).run(user.id, bytes)
  }

  it('满了之后：新的会话建不起来 —— 而且先看配额、后落盘', async () => {
    fillUp(QUOTA_BYTES)
    await expect(handleCreateSession({ image: JPEG }, user, deps()))
      .rejects.toThrow(/空间满了/)
    expect(readdirSync(photos)).toEqual([])   // 盘上一个字节都没写
  })

  it('★ 加一张新的底也是净增（旧文件不会因此被删）—— 满了就加不进去', async () => {
    const { id } = await handleCreateSession({ image: JPEG }, user, deps())
    fillUp(QUOTA_BYTES)   // 现在总数已经越线
    await expect(handleUpdateSession(id, { base: jpegUrl(600) }, user, deps()))
      .rejects.toThrow(/空间满了/)
  })

  it('★ backfill：老行（bytes = 0）按名单里那些文件补出来', async () => {
    // 迁移第 5 条之前建的会话这一列是 0 —— 由开机时那一次补齐（够不到磁盘的
    // 迁移串做不到这件事）。不补的话 5 GB 配额对老数据就是睁一只眼。
    const { id } = await handleCreateSession({ image: jpegUrl(100) }, user, deps())
    db.raw.prepare('UPDATE sessions SET bytes = 0 WHERE id = ?').run(id)   // 装成老行
    expect(await backfillSessionBytes(db, storage)).toBe(1)
    const row = db.raw.prepare('SELECT bytes FROM sessions WHERE id = ?').get(id) as { bytes: number }
    expect(row.bytes).toBe(100)
    // 幂等：再跑一次没有可补的（返回 0），也不会把值改坏
    expect(await backfillSessionBytes(db, storage)).toBe(0)
    expect((db.raw.prepare('SELECT bytes FROM sessions WHERE id = ?').get(id) as { bytes: number }).bytes)
      .toBe(100)
  })
})
