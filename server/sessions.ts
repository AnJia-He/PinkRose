import type { Db } from './db.ts'
import type { Storage } from './storage.ts'
import type { PublicUser } from './account.ts'
import { HttpError, asObject, str } from './http.ts'
import { decodeDataUrl, mimeOf, MAX_THUMB_BYTES } from './imagedata.ts'
import { assertRoomFor } from './quota.ts'
import { ZERO, applyDeltas, type Adjustments } from '../shared/adjustments.ts'
import type { SessionDetail, SessionMessage, SessionMeta, SessionStep } from '../shared/sessions.ts'

export type SessionsDeps = { db: Db; storage: Storage; now?: () => number }
const nowMs = (deps: SessionsDeps): number => (deps.now ?? Date.now)()

/** 单张图的上限，和作品那边同一个数（前端导出的都是 2048 长边、1 MB 上下） */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 一条会话最多收几句话（`readMessages` 里 `slice(-MAX_MESSAGES)`）。防的是"有人存一万条" */
const MAX_MESSAGES = 200
/**
 * 一次 PUT 最多收几步（`o.steps.slice(-MAX_STEPS)`，只留**最后** 100 条）。
 *
 * ⚠️ **它不是"这条会话最多几步"那个帽子**（2026-10-01 终审更正，别照着它推）：
 *   · 截的是**这一次送来的**那一串，超了就**静默丢掉最老的那几步** —— 库里那串
 *     跟着变短，而那几步引用的文件还在盘上（`files` 名单见下一条）；
 *   · 更要紧的是 `files` 名单**基本只增不减**（`handleUpdateSession` 里只有**被换掉的
 *     那个缩略图**会从名单里拿掉，别的一律留着），盘上的文件也只有**删整条会话**
 *     才会被回收：一个会话改十次底图就多十张全尺寸图，这个常量一个字节都拦不住。
 *   真正的"每条会话最多 N 步 / 每人 5 GB"是设计文档 §4.5/§10 里那张**还没做**的
 *   防滥用表，要做得在合并**之后**截，并把被截掉的那几步引用的文件一起收回来
 *   （还得确认没有别的步骤共用它们）—— 那是另一件事，别拿这个常量当它。
 */
const MAX_STEPS = 100
const MAX_TEXT_LEN = 2000
const MAX_PROMPT_LEN = 2000
/** 标题最长多少。60 和作品别名同一个数，列表上肩并肩看着才齐 */
const MAX_TITLE = 60
/** 原图名的上限。比 `MAX_TITLE` 松 —— 手机相册里的名字能挺长，别把人家截了 */
const MAX_ORIGINAL_NAME = 120

/** 库里那一行的原样。`files` 是 JSON 数组，别的地方只该通过 parseFiles 用它 */
export type SessionRow = {
  id: number; user_id: number; created_at: number; updated_at: number
  title: string | null; original: string; original_name: string | null
  base: string; thumb: string | null
  messages: string; steps: string; files: string
  /** ★ 2026-10-04：这条会话名下所有文件的字节数（§6.6 的 5 GB 配额靠它） */
  bytes: number
}

/** 服务端自己记的一步 —— 比出门给前端的那个多一样：**这一步用的是哪张图** */
type StoredStep = { id: number; label: string; params: Adjustments; prompt?: string; at: number; image: string }

/**
 * 取一条**属于这个人的**会话。
 *
 * ★ 和 `loadOwned` 同一条规矩：所有按 id 取会话的路径都必须经过它，
 * 不许有人自己写 `WHERE id = ?`。不是他的和不存在，回**同一句话**。
 */
export function loadOwnedSession(id: number, user: PublicUser, deps: SessionsDeps): SessionRow {
  const row = deps.db.raw.prepare(
    'SELECT * FROM sessions WHERE id = ? AND user_id = ?',
  ).get(id, user.id) as SessionRow | undefined
  if (!row) throw new HttpError('BAD_REQUEST', '没有这条会话', 404)
  return row
}

const parseFiles = (row: SessionRow): string[] => JSON.parse(row.files) as string[]

/**
 * 文件名必须**在这条会话自己产出的名单里**。
 *
 * ⚠️ 说清楚它的位置，免得下一个读的人当成死代码删掉：`handleUpdateSession` 里
 * 那次调用**今天到不了**（`mergeSteps` 只从 `{原图, 新文件, 库里那一步}` 里取值，
 * 三个来源都已经在名单里）。它真正的用处是另外两处，那两处都**到得了**：
 *   · `handleSessionStepFile` —— 名字是从库里那一列读出来的，而"库里只可能存
 *     合法的名字"是个**假设**，守卫不该建立在假设上；
 *   · 将来任何一条往 `steps` 里放**外部来源**名字的路径。
 * 一句话：这是**纵深防御**，不是装饰。注释写清楚，别让它被当成"没人调"删掉。
 */
function requireOwnFile(name: string, own: readonly string[]): string {
  if (!own.includes(name)) throw new HttpError('BAD_REQUEST', '这一步的图不属于这条会话', 400)
  return name
}

/** 库里的行 → 给前端的元数据。**只给该给的** */
function toMeta(row: SessionRow): SessionMeta {
  const steps = JSON.parse(row.steps) as StoredStep[]
  return {
    id: row.id,
    title: row.title,
    originalName: row.original_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasThumb: row.thumb !== null,
    stepCount: steps.length,
  }
}

export async function handleCreateSession(
  body: unknown, user: PublicUser, deps: SessionsDeps,
): Promise<{ id: number }> {
  const o = asObject(body)
  const image = decodeDataUrl(str(o.image))
  if (image.bytes.byteLength === 0) throw new HttpError('BAD_REQUEST', '图是空的', 400)
  if (image.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new HttpError('BAD_REQUEST', '这张图太大了，存不下', 413)
  }
  // 原图名可选（spec §6.3）。空串当没给 —— 存空串的话列表上会得到一句空标题，
  // 而不是"退回上一级"。
  const name = str(o.name).trim().slice(0, MAX_ORIGINAL_NAME) || null

  // 缩略图可选，坏姿势有两种（解不出来 / 存不下去），都只该让"这条没有缩略图"，
  // 不该让整条会话建不起来 —— 和 handleCreateWork 那条 catch 一字不差的理由。
  const thumbRaw = str(o.thumb)
  // ★ 2026-10-04（§6.6，5 GB 配额）：**先看配额再落盘** —— 写进来再删是白费。
  //   缩略图那点字节（≤1 MB）先按 0 算：它随后才解码，而 5 GB 量级上它是零头。
  assertRoomFor(deps.db, user.id, image.bytes.byteLength, 'session')
  const original = await deps.storage.save(image.bytes, image.ext)
  let thumb: string | null = null
  let thumbBytes = 0
  if (thumbRaw) {
    try {
      const t = decodeDataUrl(thumbRaw)
      // ★ 2026-10-02（安全审计）：缩略图也要**有自己的体积上限**。
      //   原来它只受总请求体 12 MB 管着 —— 一个请求能塞进来约 9 MB 的"缩略图"，
      //   而作品那张本身的上限是 8 MB，"每张最多 8 MB"那句话当场不成立。
      //   超了就走下面那条既有路径（当"这张没有缩略图"），**不拖垮整张图** ——
      //   和裁定 ② 同一个道理。
      if (t.bytes.byteLength > MAX_THUMB_BYTES) {
        throw new Error(`缩略图 ${t.bytes.byteLength} 字节，超过上限`)
      }
      thumb = await deps.storage.save(t.bytes, t.ext)
      thumbBytes = t.bytes.byteLength
    } catch (e) {
      console.error('会话缩略图用不了（解不开或者存不下）：', e)
    }
  }

  const t = nowMs(deps)
  try {
    const r = deps.db.raw.prepare(
      `INSERT INTO sessions (user_id, created_at, updated_at, title, original, original_name, base, thumb, messages, steps, files, bytes)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, '[]', '[]', ?, ?)`,
    ).run(user.id, t, t, original, name, original, thumb,
      // ⚠️ **缩略图也进名单**。它虽然在 `thumb` 那一列上，但它同样是**这条会话名下的
      //    文件** —— `files` 是"删的时候该删哪些"的唯一依据，漏一样就是每删一条会话
      //    在盘上留一个没人认领的文件，而且**永远没人会知道**。
      //    （2026-10-02 用户在盘上抓到的就是它：3 条删过的会话 = 3 个孤儿缩略图。）
      JSON.stringify(thumb ? [original, thumb] : [original]),
      image.bytes.byteLength + thumbBytes)
    return { id: Number(r.lastInsertRowid) }
  } catch (e) {
    // 插不进库就把刚写的文件收回来 —— 不收的话盘上留下两个**没人知道是什么**的文件。
    // ⚠️ 但**收不回来本身也不能静默**：盘满 / 权限出问题时，"文件为什么还在"
    //    必须有第二个地方会说话（见"不许无声吞异常"那条全局约束）。
    await deps.storage.remove(original).catch((e) => console.error('刚写的文件没收回：', e))
    if (thumb) await deps.storage.remove(thumb).catch((e) => console.error('刚写的文件没收回：', e))
    throw e
  }
}

export function handleListSessions(user: PublicUser, deps: SessionsDeps): { sessions: SessionMeta[] } {
  // ⚠️ 原来是 `SELECT *`（2026-10-04 收窄）：`messages` 每行最多 200 条 × 2000 字，
  //    而列表只用得上 toMeta 那几个字段 —— 每一行都白捞一遍整段对话。
  const rows = deps.db.raw.prepare(
    `SELECT id, title, original_name, created_at, updated_at, thumb, steps
     FROM sessions WHERE user_id = ? ORDER BY updated_at DESC`,
  ).all(user.id) as unknown as SessionRow[]
  return { sessions: rows.map(toMeta) }
}

/**
 * ★ 2026-10-04：把**迁移第 5 条之前**的老会话的 `bytes` 补上（那些行是 0）。
 *
 * 开机时跑一次（index.ts）。**不能放进迁移**：迁移串里只有 SQL，够不到磁盘上
 * 文件的大小。不补的话，§6.6 那个 5 GB 配额对老数据就是睁一只眼。
 *
 * 单个文件 stat 失败按 0 算 —— 保守**少算**：宁可账算少一点，
 * 也不要因为一个坏文件把整次补齐打断（配额是防线，不是账本审计）。
 * 返回值 = 补了几条（调用方打一行日志）。
 */
export async function backfillSessionBytes(db: Db, storage: Storage): Promise<number> {
  const rows = db.raw
    .prepare('SELECT id, files FROM sessions WHERE bytes = 0')
    .all() as { id: number; files: string }[]
  for (const r of rows) {
    let total = 0
    for (const name of JSON.parse(r.files) as string[]) {
      total += await storage.sizeOf(name).catch(() => 0)
    }
    db.raw.prepare('UPDATE sessions SET bytes = ? WHERE id = ?').run(total, r.id)
  }
  return rows.length
}

/** 每一步对外的样子：把 `image` 摘掉，换成一句 `reusesPrev` */
function toSteps(stored: readonly StoredStep[]): SessionStep[] {
  return stored.map((s, i) => ({
    id: s.id, label: s.label, params: s.params, prompt: s.prompt, at: s.at,
    reusesPrev: i > 0 && stored[i - 1]!.image === s.image,
  }))
}

export function handleGetSession(id: number, user: PublicUser, deps: SessionsDeps): SessionDetail {
  const row = loadOwnedSession(id, user, deps)
  return {
    ...toMeta(row),
    messages: JSON.parse(row.messages) as SessionMessage[],
    steps: toSteps(JSON.parse(row.steps) as StoredStep[]),
  }
}

export async function handleSessionFile(
  id: number, which: 'original' | 'base', user: PublicUser, deps: SessionsDeps,
) {
  const row = loadOwnedSession(id, user, deps)
  const name = which === 'original' ? row.original : row.base
  return { bytes: await deps.storage.read(name), contentType: mimeOf(name) }
}

/**
 * 列表上那张小图。
 *
 * ⚠️ 两个兜底和 `handleWorkThumb` 一字不差：没有缩略图就退回**原图**，
 * 而"缩略图读不出来"要 **console.error 一声再退回** —— 兜底不等于静默
 * （吞掉的可能是权限、是名字守卫、是将来 storage 层的 bug）。
 */
export async function handleSessionThumb(id: number, user: PublicUser, deps: SessionsDeps) {
  const row = loadOwnedSession(id, user, deps)
  const name = row.thumb ?? row.original
  try {
    return { bytes: await deps.storage.read(name), contentType: mimeOf(name) }
  } catch (e) {
    if (name === row.original) throw e
    console.error('会话缩略图读不出来，退回原图：', e)
    return { bytes: await deps.storage.read(row.original), contentType: mimeOf(row.original) }
  }
}

/**
 * 服务端**自己**给每一步分配图片文件。
 *
 * ⚠️ 为什么不让客户端送文件名：那是一条能引用别人图的洞（见 `requireOwnFile`）。
 * 规则三条，写清楚免得下一个读的人猜：
 *   ① **第一个步骤永远是原图**；
 *   ② 库里**已有**的那几步：整个对象一律沿用库里的（历史不许被客户端改写）；
 *   ③ 新步骤默认接着上一步那张图 —— **只有"最后一个新步骤"拿这次上传的新文件**
 *      （一次 PUT 最多带来一个新文件：客户端是"改一步就存一次"）。
 */
function mergeSteps(
  prev: readonly StoredStep[], incoming: readonly unknown[],
  newFile: string | null, original: string, at: number,
): StoredStep[] {
  const byId = new Map(prev.map((s) => [s.id, s]))
  const out: StoredStep[] = []
  for (const raw of incoming) {
    const o = asObject(raw)
    const id = Number(o.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError('BAD_REQUEST', '步骤 id 得是正整数', 400)
    const old = byId.get(id)
    if (old) { out.push(old); continue }
    out.push({
      id,
      label: str(o.label).trim().slice(0, MAX_TITLE) || '调色',
      params: applyDeltas(ZERO, asObject(o.params) as Partial<Adjustments>),
      prompt: str(o.prompt).slice(0, MAX_PROMPT_LEN) || undefined,
      at: Number(o.at) || at,
      image: '',                       // 下面两步统一补
    })
  }
  // ③：新步骤里**最后那一个**拿新文件
  if (newFile) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.image === '') { out[i]!.image = newFile; break }
    }
  }
  // ①③：空的接着上一步；第一个是原图
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.image) continue
    out[i]!.image = i === 0 ? original : out[i - 1]!.image
  }
  return out
}

function readMessages(raw: unknown): SessionMessage[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(-MAX_MESSAGES).flatMap((m) => {
    const o = asObject(m)
    const role = o.role === 'user' || o.role === 'assistant' ? o.role : null
    const text = str(o.text).slice(0, MAX_TEXT_LEN)
    if (!role || !text) return []
    const id = Number(o.id)
    // ⚠️ 这里原来还留着一个 `stepId`（"助手那条挂在哪一步上"）—— 客户端从没送过它，
    //    「回到这一步」真正靠的是**消息 id 就是步骤 id**（见 `shared/sessions.ts`
    //    `SessionMessage` 那段）。2026-10-01 终审删掉了它：一个永远收不到的字段
    //    会让下一个读的人以为服务端在保管它。
    return [{
      id: Number.isInteger(id) && id > 0 ? id : 0,
      role, text, at: Number(o.at) || 0,
    }]
  })
}

/**
 * ⚠️ `updated_at` 在这里**不只是"上次改的时间"，它同时是缩略图 URL 的版本号**
 * —— 和 `handleReplaceWork` 上面那段是同一条规矩。忘了 bump 不会报错、
 * 不会 4xx：用户只是**静默地**一直看到缓存里那张旧缩略图。
 */
export async function handleUpdateSession(
  id: number, body: unknown, user: PublicUser, deps: SessionsDeps,
): Promise<SessionMeta> {
  const row = loadOwnedSession(id, user, deps)
  const o = asObject(body)
  const own = parseFiles(row)
  const prevSteps = JSON.parse(row.steps) as StoredStep[]

  // ── 新图（可选）───────────────────────────────────────────────────
  let newFile: string | null = null
  // ★ 2026-10-04（§6.6）：这一趟**净增加**多少字节（配额和 bytes 列都用它）
  let addedBytes = 0
  const baseRaw = str(o.base)
  if (baseRaw) {
    const image = decodeDataUrl(baseRaw)
    if (image.bytes.byteLength === 0) throw new HttpError('BAD_REQUEST', '图是空的', 400)
    if (image.bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new HttpError('BAD_REQUEST', '这张图太大了，存不下', 413)
    }
    // ★ 2026-10-04：加一张全尺寸的底也要过配额 —— 旧的那些文件**不会**因此被删
    //   （`files` 只增不减，见 MAX_STEPS 那段），所以这里没有 `freeing`。
    assertRoomFor(deps.db, user.id, image.bytes.byteLength, 'session')
    addedBytes += image.bytes.byteLength
    newFile = await deps.storage.save(image.bytes, image.ext)
  }
  let newThumb: string | null = null
  const thumbRaw = str(o.thumb)
  if (thumbRaw) {
    try {
      const t = decodeDataUrl(thumbRaw)
      // ★ 2026-10-02（安全审计）：缩略图也要**有自己的体积上限**。
      //   原来它只受总请求体 12 MB 管着 —— 一个请求能塞进来约 9 MB 的"缩略图"，
      //   而作品那张本身的上限是 8 MB，"每张最多 8 MB"那句话当场不成立。
      //   超了就走下面那条既有路径（当"这张没有缩略图"），**不拖垮整张图** ——
      //   和裁定 ② 同一个道理。
      if (t.bytes.byteLength > MAX_THUMB_BYTES) {
        throw new Error(`缩略图 ${t.bytes.byteLength} 字节，超过上限`)
      }
      newThumb = await deps.storage.save(t.bytes, t.ext)
      addedBytes += t.bytes.byteLength
    } catch (e) {
      console.error('会话缩略图用不了（解不开或者存不下）：', e)
    }
  }

  const t = nowMs(deps)
  // ★ 2026-10-04：被换掉的那个旧缩略图会**从盘上删掉**（下面那两处 remove）——
  //   所以它的字节要**从账里减掉**，不然每换一次缩略图就多算一份（越攒越虚）。
  //   读不到就当 0（保守：宁可多算，也别把账算少）。
  if (newThumb && row.thumb) {
    addedBytes -= await deps.storage.sizeOf(row.thumb).catch(() => 0)
  }
  // ⚠️ 从这儿到 UPDATE 成功为止，**任何一步抛出去都必须把刚写的两个文件收回来** ——
  //    所以步骤合并（mergeSteps）、名单校验、消息清洗全在**同一个 try 里**，
  //    不只是那句 UPDATE。这里原本只包了 UPDATE，于是漏了两个口子：
  //    `mergeSteps` 撞上"缺 id"的步骤、`readMessages` 撞上非对象的消息，都在
  //    `storage.save` 之后抛 —— 刚落盘的文件留在盘上，**没有任何一行引用它**，
  //    删会话也收不到它（`files` 名单里根本没有），而每个这样的请求都漏一个，
  //    可以无限打。`works.ts` 的 `handleReplaceWork` 就是为此把 `readRecipe`
  //    也放进 try 的（裁定 ② 那段），这里照同一条形状。
  let steps: StoredStep[]
  let files: string[]
  let title: string | null
  let messages: string
  try {
    steps = Array.isArray(o.steps)
      ? mergeSteps(prevSteps, o.steps.slice(-MAX_STEPS), newFile, row.original, t)
      : prevSteps
    // 名单：原来的 + 这次新写的。每一步引用的文件都必须在名单里
    //
    // ⚠️ **缩略图也在名单里**（2026-10-02 修的）：它虽然在 `thumb` 那一列上，但
    //    同样是这条会话名下的文件 —— 而 `files` 是"删的时候该删哪些"的唯一依据。
    //    不进名单的后果是每删一条会话往盘上留一个孤儿，且**一声不吭**（本机实测：
    //    3 条删过的会话 = 3 个孤儿缩略图）。
    // ⚠️ 被换掉的那个旧缩略图要**同时从名单里拿掉**（下面 `catch` 之后那句会把它
    //    从盘上删掉）。留着的话名单里就有一个指向"已经不存在的文件"的名字，
    //    而 `files` 同时还当着 `requireOwnFile` 的许可名单 —— 一张注销不了的空头支票。
    files = [
      ...own.filter((f) => f !== (newThumb ? row.thumb : null)),
      ...(newFile ? [newFile] : []),
      ...(newThumb ? [newThumb] : []),
    ]
    for (const s of steps) requireOwnFile(s.image, files)

    // ★ 「现在这一版参数」落在**最后一步**上。`SessionPatch.params` 那段注释讲了为什么
    //   它必须单独走一个字段（客户端里 `params` 和 `history` 是两回事，拖滑块不动 history）。
    //
    //   两条刻意的窄：① **只动最后一步**，前面几步一个字节不碰 —— 客户端不能改写历史
    //   （`mergeSteps` 规则 ②）这条规矩不能因为参数就被撬开一个口子；
    //   ② **换一个对象，别原地改** —— `mergeSteps` 里 `out.push(old)` 推的是库里那条的
    //   **同一个引用**，原地改会顺手动到 `prevSteps`。今天 `prevSteps` 是当场
    //   `JSON.parse` 出来的、动它没事，但那是"今天没事"，不是"不会出事"。
    if (o.params !== undefined && steps.length > 0) {
      const last = steps[steps.length - 1]!
      steps[steps.length - 1] = {
        ...last,
        params: applyDeltas(ZERO, asObject(o.params) as Partial<Adjustments>),
      }
    }

    title = o.title === null || o.title === undefined
      ? row.title
      : (str(o.title).trim().slice(0, MAX_TITLE) || null)
    // ⚠️ 和上面 `steps` 同一条口径：**不是数组就是"这次没送"**，库里的对话原样保留。
    //    不这样写的话，一个把 messages 送成对象的客户端 bug 会把用户的整段对话
    //    **静默**清成 `[]` —— 正是"错了不会报错，只会静静地错"那一类。
    messages = Array.isArray(o.messages) ? JSON.stringify(readMessages(o.messages)) : row.messages

    // ★ 2026-10-02（安全审计）：**乐观锁**。
    //
    //   上面那段是「读那一行 → await 落盘 → 写回去」，而中间那个 await 让出了
    //   事件循环 —— 两条并发的 PUT 会**都读到旧的那一行**，后写的把先写的整个盖掉。
    //   实测（加这条之前）：两次都回 200，先写者那一步**静默消失**，
    //   而它落的文件不在名单里，删会话也收不走（永久孤儿）。
    //
    //   判据用 `updated_at`（那一行自带一个版本号，本来就在做缩略图的缓存钥匙）：
    //   读它的时候是多少，写的时候就要求还是多少。对不上 = 中间有人改过。
    //   `changes === 0` 就抛 —— 抛出去会走上面那个 `catch`，**刚写的文件一起收回**。
    const res = deps.db.raw.prepare(
      `UPDATE sessions SET updated_at = ?, title = ?, base = ?, thumb = COALESCE(?, thumb),
         messages = ?, steps = ?, files = ?, bytes = bytes + ?
       WHERE id = ? AND user_id = ? AND updated_at = ?`,
    ).run(t, title, newFile ?? row.base, newThumb, messages,
      JSON.stringify(steps), JSON.stringify(files), addedBytes, id, user.id, row.updated_at)
    if (res.changes === 0) {
      // 文案规范 5：哪不对 + 怎么办。**不许说成"没登录"或者"图不对"** ——
      // 那两句会把人指去改一个没错的东西。
      throw new HttpError('CONFLICT',
        '这条对话刚刚在别的地方改过了，这次没存进去（免得把那边的新内容盖掉）。刷新一下看看。', 409)
    }
  } catch (e) {
    // 记录没改成功（或者半程校验炸了）→ 把**新写的**收回来，旧的一动没动
    if (newFile) await deps.storage.remove(newFile).catch((e) => console.error('刚写的文件没收回：', e))
    if (newThumb) await deps.storage.remove(newThumb).catch((e) => console.error('刚写的文件没收回：', e))
    throw e
  }
  // 换了缩略图才删旧的（旧的 base **不能删** —— 它可能还被某一步引用着）
  if (newThumb && row.thumb) {
    await deps.storage.remove(row.thumb).catch((e) => console.error('旧缩略图没删掉：', e))
  }

  const next = { ...row, updated_at: t, title, base: newFile ?? row.base,
    thumb: newThumb ?? row.thumb, messages, steps: JSON.stringify(steps), files: JSON.stringify(files) }
  return toMeta(next)
}

/**
 * 删一条。
 * ★ 顺序同 `handleDeleteWork`：**先删记录，再删文件**。反过来的话会留下一条
 * 指向不存在文件的记录 —— 那条记录永远打不开、也删不掉第二次。
 * 文件删失败不让请求失败（对用户来说这件事**就是成功了**），但要记一笔日志。
 */
export async function handleDeleteSession(
  id: number, user: PublicUser, deps: SessionsDeps,
): Promise<{ ok: true }> {
  const row = loadOwnedSession(id, user, deps)
  deps.db.raw.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, user.id)
  for (const name of parseFiles(row)) {
    await deps.storage.remove(name).catch((e) => console.error('会话文件没删掉，成了孤儿：', e))
  }
  return { ok: true }
}

export async function handleSessionStepFile(
  id: number, stepId: number, user: PublicUser, deps: SessionsDeps,
) {
  const row = loadOwnedSession(id, user, deps)
  const s = (JSON.parse(row.steps) as StoredStep[]).find((x) => x.id === stepId)
  if (!s) throw new HttpError('BAD_REQUEST', '没有这一步', 404)
  // 走过的名字再过一遍守卫：库里那一列理论上只可能是名单里的，但**守卫不该依赖"理论上"**
  requireOwnFile(s.image, parseFiles(row))
  return { bytes: await deps.storage.read(s.image), contentType: mimeOf(s.image) }
}
