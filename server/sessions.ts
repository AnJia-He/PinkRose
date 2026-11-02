import type { Db } from './db.ts'
import type { Storage } from './storage.ts'
import type { PublicUser } from './account.ts'
import { nowMs } from './clock.ts'
import { HttpError, asObject, str } from './http.ts'
import { mimeOf, readImageDataUrl, saveOptionalThumb } from './imagedata.ts'
import { assertRoomFor } from './quota.ts'
// ★ 2026-10-05（滤镜）：写入时那道"不许悬空引用"的闸 —— `resolveLutRef` 查的是
//   "这个 id 存不存在、是不是他的"，认不出来回 null。**只有这一份**，别在这里
//   另写一个查 luts 表的 SELECT。
import { resolveLutRef } from './luts.ts'
import { invalidateSessionSummaryIfChanged } from './memory.ts'
import { ZERO, applyDeltas, type Adjustments } from '../shared/adjustments.ts'
import { normalizeLutRef, type LutRef } from '../shared/lut.ts'
import { normalizeEditLayers, type EditLayer } from '../shared/layers.ts'
import type { SessionDetail, SessionMessage, SessionMeta, SessionStep } from '../shared/sessions.ts'

export type SessionsDeps = { db: Db; storage: Storage; now?: () => number }

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
type StoredStep = {
  id: number; label: string; params: Adjustments; prompt?: string; at: number; image: string
  /** ★ 2026-10-05：这一步用的滤镜（`{ lutId, amount }`）。老步骤没有这个键 */
  lut?: LutRef | null
  /** ★ 2026-10-19：这一步的文字层。老步骤没有这个键 = 没有层。 */
  layers?: EditLayer[]
}

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
  // 解码 + "空的 / 太大"那两个判断在 `imagedata.ts` 的 `readImageDataUrl` 里
  // （作品和会话四处共用一份，上限从这里给）。
  const image = readImageDataUrl(str(o.image), MAX_IMAGE_BYTES)
  // 原图名可选（spec §6.3）。空串当没给 —— 存空串的话列表上会得到一句空标题，
  // 而不是"退回上一级"。
  const name = str(o.name).trim().slice(0, MAX_ORIGINAL_NAME) || null

  // 缩略图可选，坏姿势有两种（解不出来 / 存不下去），都只该让"这条没有缩略图"，
  // 不该让整条会话建不起来 —— 那两条 ⚠️ 和裁定 ② 收在 `saveOptionalThumb` 头上。
  const thumbRaw = str(o.thumb)
  // ★ 2026-10-04（§6.6，5 GB 配额）：**先看配额再落盘** —— 写进来再删是白费。
  //   缩略图那点字节（≤1 MB）先按 0 算：它随后才解码，而 5 GB 量级上它是零头。
  assertRoomFor(deps.db, user.id, image.bytes.byteLength, 'session')
  const original = await deps.storage.save(image.bytes, image.ext)
  const thumbRec = await saveOptionalThumb(thumbRaw, deps.storage, '这条会话')
  const thumb = thumbRec?.name ?? null
  const thumbBytes = thumbRec?.bytes ?? 0

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
    // ★ 2026-10-05：**显式落成 null**（别只写 `s.lut`）—— 2026-10-05 之前存的步骤
    //   没有这个键，读出来是 `undefined`，而**前端只看得到这一份**：不在这里归一，
    //   等于把"判一下 undefined"摊给每一个调用点。老步骤 = 没用滤镜。
    lut: s.lut ?? null,
    ...(s.layers?.length ? { layers: s.layers } : {}),
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
 * 规则四条，写清楚免得下一个读的人猜：
 *   ① **第一个步骤永远是原图**（⚠️ 例外：它被规则 ④ 指名替换时 —— 那一步的
 *      `image` 换成新图，`steps[0].image` 就不再是原图了，这是有意的）；
 *   ② 库里**已有**的那几步：整个对象一律沿用库里的（**历史**不许被客户端改写）；
 *   ③ 新步骤默认接着上一步那张图 —— **只有"最后一个新步骤"拿这次上传的新文件**
 *      （一次 PUT 最多带来一个新文件：客户端是"改一步就存一次"）。
 *      这是**没带 `stateStepId` 时**的旧行为（兼容路径，留着）；
 *   ④ ★ 2026-10-08（账本）：带了 `stateStepId` 时 ③ 让位 —— 新文件落在**它指名的
 *      那一步**的 `image` 上（**替换**：这一版的"现在"换了一张底图）。那一步必须
 *      存在（合并后），否则 400（新的信任边界）。
 *      （⚠️ "没送 `steps`"那一趟不经过这里 —— `handleUpdateSession` 里有一块单独认它，
 *      形状是 `{stateStepId, base}`，同样要换 image。）
 *      ⚠️ 被换下来的旧文件**不删、也不从 `files` 名单里拿掉** —— 它可能还被别的步骤引
 *      用着，而且就算没人用了，回收也只发生在"删整条会话"那一刻（`files` 只增
 *      不减，见 MAX_STEPS 那段）。
 */
function mergeSteps(
  prev: readonly StoredStep[], incoming: readonly unknown[],
  newFile: string | null, original: string, at: number, stateStepId: number | null,
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
      // ★ 2026-10-05（滤镜）：这里只做**形状**归一化（`normalizeLutRef`，
      //   和 `params` 过 `applyDeltas` 同一条规矩）；**存不存在、是不是他的**
      //   由调用方紧随其后的 `resolveLutRef` 那道闸判 —— 它要查库，这里够不到 db。
      lut: normalizeLutRef(o.lut),
      layers: normalizeEditLayers(o.layers),
    })
  }
  // ③：新步骤里**最后那一个**拿新文件 —— **只在没指名"状态挂在哪一步"时**（旧行为）
  if (newFile && stateStepId === null) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.image === '') { out[i]!.image = newFile; break }
    }
  }
  // ④：**带了新图又指名了步骤** → 新文件落在**那一步**上（替换它的 image）。
  //    ⚠️ 找不到当场抛，**不能静默跳过**：跳过的话新文件只是躺进下面的 `files` 名单里
  //    没人引用（`base` 那一列指着它，但这一步读回来还是旧图）—— 一个 400 该说的事
  //    会变成"用户改的东西一声不吭地没存下来"。
  //    ⚠️ **换一个对象，别原地改**（理由同 `handleUpdateSession` 里 params 那段的 ②）：
  //    `out.push(old)` 推的是库里那一条的**同一个引用**。
  if (newFile && stateStepId !== null) {
    const i = out.findIndex((s) => s.id === stateStepId)
    if (i < 0) throw new HttpError('BAD_REQUEST', 'stateStepId 指的步骤不存在', 400)
    out[i] = { ...out[i]!, image: newFile }
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

  // ★ 2026-10-08（账本）：`stateStepId` —— **这趟的 `params`/`lut`/`base` 说的是哪一步的
  //   "现在"**（`SessionPatch.stateStepId`，设计 §7.1）。它是新的信任边界，两条都判：
  //   ① **形状**（这里）：得是正整数 —— 1.5 / "1" / 0 混进来要**当场报**，
  //      不许落到下面变成"找不到那一步，然后什么都不做"（这个项目最恨的静默失败）。
  //      摆在最前面（任何文件落盘之前）—— 坏输入不该换来一次"写进去再删掉"。
  //   ② **存在**（下面 `steps` 算出来之后）：合并后必须真有这一步，否则 400。
  let stateStepId: number | null = null
  if (o.stateStepId !== undefined) {
    const v = o.stateStepId
    if (!Number.isInteger(v) || (v as number) <= 0) {
      throw new HttpError('BAD_REQUEST', 'stateStepId 得是正整数', 400)
    }
    stateStepId = v as number
  }

  // ── 新图（可选）───────────────────────────────────────────────────
  let newFile: string | null = null
  // ★ 2026-10-04（§6.6）：这一趟**净增加**多少字节（配额和 bytes 列都用它）
  let addedBytes = 0
  const baseRaw = str(o.base)
  if (baseRaw) {
    const image = readImageDataUrl(baseRaw, MAX_IMAGE_BYTES)
    // ★ 2026-10-04：加一张全尺寸的底也要过配额 —— 旧的那些文件**不会**因此被删
    //   （`files` 只增不减，见 MAX_STEPS 那段），所以这里没有 `freeing`。
    assertRoomFor(deps.db, user.id, image.bytes.byteLength, 'session')
    addedBytes += image.bytes.byteLength
    newFile = await deps.storage.save(image.bytes, image.ext)
  }
  const thumbRaw = str(o.thumb)
  const newThumbRec = await saveOptionalThumb(thumbRaw, deps.storage, '这条会话')
  const newThumb = newThumbRec?.name ?? null
  if (newThumbRec) addedBytes += newThumbRec.bytes

  // ★ 2026-10-05：**「只改名字」这一趟不动 `updated_at`**。
  //   列表按 `updated_at DESC` 排、按天分组 —— 那个日期说的是"**什么时候改的照片**"。
  //   改名是**整理**不是修图：让它跳到"今天"最前，用户会吓一跳（"我就改个名，
  //   这条怎么飞顶上去了"）。判据：这一趟 PUT **只有 `title` 这一个字段**（string）。
  //   ⚠️ 并发守卫（下面的 `AND updated_at = ?`）不受影响：没改它就没变，
  //      "读到的还是写时的那个"照样成立；缩略图的缓存钥匙同理（图本来也没变）。
  //   ⚠️ 客户端落盘（App 改照片）永远带 params —— 那条路照旧 bump，别把判据放宽。
  // ★ 2026-10-08（账本 Task 7 顺手件）：判据是"**只有 title 这一个字段**"，
  //   那 `stateStepId` / `lut` 也得点名列进来（少一个就是"哪天有人拿它补一趟
  //   只改名的话，这条会话会白白跳到今天"）。今天没有这种调用点
  //   （客户端的改名只送 `{title}`，落盘永远带 `params`）—— 这是给形状兜底。
  const titleOnly = typeof o.title === 'string'
    && o.base === undefined && o.thumb === undefined
    && o.messages === undefined && o.steps === undefined && o.params === undefined
    && o.lut === undefined && o.stateStepId === undefined
  const t = titleOnly ? row.updated_at : nowMs(deps)
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
    // ★ 2026-10-05（滤镜）：客户端**不能写进一个悬空的 lut id** —— 这一步是那道闸
    //   在"整条 steps"这条路（`o.steps`）上的落点：每一步的 `lut` 都过一遍
    //   `resolveLutRef`，不在他名下 / 已经不存在的 id 一律落成 null。
    //   放在 `mergeSteps` **之后**统一做，而不是它内部：那个函数只管图片文件那三件
    //   事、拿不到 db，而这里一次 map 就够（库里已有的那几步也顺带再验一遍 ——
    //   被删的滤镜不该因为"历史写过"就活下来）。
    steps = Array.isArray(o.steps)
      ? mergeSteps(prevSteps, o.steps.slice(-MAX_STEPS), newFile, row.original, t, stateStepId)
        .map((s) => ({ ...s, lut: resolveLutRef(deps.db, user.id, s.lut) }))
      : prevSteps
    // ★ 2026-10-08（账本）：`stateStepId` 那条信任边界的**第二道**（形状那一道在函数最前面）。
    //   判据是**合并后**的这串（spec §7.1）。为什么两条路都要有：
    //   · `mergeSteps` 里那一道只在"这趟还带了新图"时才跑（它要在那儿换 image）；
    //   · 这一道管剩下的所有形状 —— **没带新图**、甚至整串 `steps` 都没送（拖滑块
    //     那种 UPDATE 的常见形状，这时"合并后"就是库里那串）。
    //   少了它，一个指错的 id 会让 params/lut 被**一声不吭**地丢掉（下面是 `ti >= 0`
    //   的守卫，找不到就跳过）—— 正是这个项目最恨的"错了不报错，只会静静地错"。
    if (stateStepId !== null && !steps.some((s) => s.id === stateStepId)) {
      throw new HttpError('BAD_REQUEST', 'stateStepId 指的步骤不存在', 400)
    }
    // ★ 2026-10-08（终审 Important）：**不带 `steps` 也得认账**。
    //   上面那口子（`mergeSteps` 规则 ④）只在"送了 steps"时才跑，而
    //   `{stateStepId, base}`（拖滑块之外、只换底的那趟）是**合法的协议输入**：
    //   少这一块的话回 200、`base` 列和 `files` 都换了，**那一步的 `image` 一个字节
    //   没动** —— 而恢复是按步取 `sessionStepUrl` 的，刷新后那一版还是旧图，**不报错**。
    //   （这就是协议注释写的"`base` 说的是哪一步的现在"名不副实的那半截。）
    //   ⚠️ 那一步不存在的情况上面刚判过 400（同一口径、同一个 try，catch 会把刚落的
    //   文件收走）；⚠️ **换一个对象**，照下面 params 那段 ② 的规矩。
    if (newFile && stateStepId !== null && !Array.isArray(o.steps)) {
      const i = steps.findIndex((s) => s.id === stateStepId)
      steps[i] = { ...steps[i]!, image: newFile }
    }
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

    // ★ 「现在这一版参数」落在 **`stateStepId` 指名的那一步**上；没带 = 还是"最后一步"
    //   （旧行为，兼容路径）。`SessionPatch.params` 那段注释讲了为什么它必须单独走一个
    //   字段（客户端里 `params` 和 `history` 是两回事，拖滑块不动 history）。
    //
    // ★ 2026-10-08（账本）—— 窄口从"最后一步"挪到"指名的那一步"，这是这次协议改动的
    //   **立身之本**：把两件事分开说。
    //   · **历史**（`label`/`prompt`/`at`）="当时发生了什么"的记述，客户端**不许**改写
    //     （`mergeSteps` 规则 ② 挡着，这条规矩不因为这次改动松动）；
    //   · **状态**（`base`/`params`/`lut`）="这一版现在长什么样"，是客户端的、而且
    //     **必须**能被它更新 —— 用户站在旧版本上拖滑块，那些值就该落进**那一版**，
    //     而不是被硬塞给最后一步（那正是旧 `atTip` 规则在绕、又绕不干净的东西）。
    //
    //   两条刻意的窄（照旧）：① **只动指名的那一步**，别的步骤一个字节不碰；
    //   ② **换一个对象，别原地改** —— `mergeSteps` 里 `out.push(old)` 推的是库里那条的
    //   **同一个引用**，原地改会顺手动到 `prevSteps`。今天 `prevSteps` 是当场
    //   `JSON.parse` 出来的、动它没事，但那是"今天没事"，不是"不会出事"。
    //
    //   ⚠️ 旧行为那支的落点仍然按**最后一个槽位**算（`steps.length - 1`），不是
    //   "按 id 找第一次出现" —— 客户端把同一个 id 送两遍时（`[step(1), step(1)]`，
    //   见「更新 · 参数」里"别名"那条用例），"最后一步"指的是**数组尾巴那个槽**。
    //   两支都不可能是 -1 以外的坏值：指名那支上面刚验过存在，空数组则本来就没得写。
    const ti = stateStepId === null
      ? steps.length - 1
      : steps.findIndex((s) => s.id === stateStepId)
    if (o.params !== undefined && ti >= 0) {
      steps[ti] = {
        ...steps[ti]!,
        params: applyDeltas(ZERO, asObject(o.params) as Partial<Adjustments>),
      }
    }

    // ★ 2026-10-05（滤镜）：「现在这一版的滤镜」和 params 同一条路：落在
    //   **`stateStepId` 那一步**（没带还是最后一步）、**换一个对象**（两条窄的理由
    //   见上面 params 那段）。
    //   ⚠️ `resolveLutRef` 是那道"不许悬空"的闸：客户端拿一个已经不存在的 id 来存，
    //   落库的是 null（不存在的、别人的，都算认不出来）。
    if (o.lut !== undefined && ti >= 0) {
      steps[ti] = { ...steps[ti]!, lut: resolveLutRef(deps.db, user.id, o.lut) }
    }

    // ★ 2026-10-19：文字层和 params / lut 同一条状态路 —— 落在 stateStepId
    //   指名的那一步上，**换一个对象**，旧层可以被显式清空（送 []）。
    if (o.layers !== undefined && ti >= 0) {
      steps[ti] = { ...steps[ti]!, layers: normalizeEditLayers(o.layers) }
    }

    title = o.title === null || o.title === undefined
      ? row.title
      : (str(o.title).trim().slice(0, MAX_TITLE) || null)
    // ⚠️ 和上面 `steps` 同一条口径：**不是数组就是"这次没送"**，库里的对话原样保留。
    //    不这样写的话，一个把 messages 送成对象的客户端 bug 会把用户的整段对话
    //    **静默**清成 `[]` —— 正是"错了不会报错，只会静静地错"那一类。
    messages = Array.isArray(o.messages) ? JSON.stringify(readMessages(o.messages)) : row.messages
    // 内部摘要只对它覆盖到的那段历史负责。被覆盖的消息一旦被删或改写，
    // 旧摘要必须当场作废；单纯追加新消息不会清掉它。
    if (Array.isArray(o.messages)) {
      invalidateSessionSummaryIfChanged(deps.db, id, row.messages, messages)
    }

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
