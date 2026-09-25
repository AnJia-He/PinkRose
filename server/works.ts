import type { Db } from './db.ts'
import type { Storage } from './storage.ts'
import type { PublicUser } from './account.ts'
import { HttpError, asObject, str } from './http.ts'
import { ZERO, applyDeltas, type Adjustments } from '../shared/adjustments.ts'
import type { Recipe, WorkDetail, WorkMeta } from '../shared/works.ts'

export type WorksDeps = { db: Db; storage: Storage; now?: () => number }

/** 单张图的上限。前端导出的是 2048 长边的 JPEG，一般 1 MB 上下 —— 8 MB 是很宽的余量 */
const MAX_WORK_BYTES = 8 * 1024 * 1024
/** 配方里最多记几句、每句多长。防的是"有人存一万条" */
const MAX_EDITS = 100
const MAX_EDIT_LEN = 200

const nowMs = (deps: WorksDeps): number => (deps.now ?? Date.now)()

export type WorkRow = {
  id: number; user_id: number; stored_name: string; thumb_name: string | null
  bytes: number; created_at: number; updated_at: number; alias: string | null; recipe: string
}

/**
 * 把 `data:image/jpeg;base64,…` 解成字节 + 扩展名。
 *
 * ⚠️ 这个仓库里**第一次**有人真的去解一个 data URL —— 三个 AI 接口只校验前缀就把整串
 * 转给上游了。所以这里的每一个边界都得自己守：只收 jpeg / png（导出就这两种），
 * 正则直接把"带别的东西的串"挡在外面，`Buffer.from(…, 'base64')` 对垃圾输入**不抛**
 * （`server/password.ts:66` 记过这一条），所以**不能靠 try/catch 兜底**，
 * 只能靠前面的正则先把形状卡死。
 */
function decodeDataUrl(s: string): { bytes: Uint8Array; ext: string } {
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(s)
  if (!m) throw new HttpError('BAD_REQUEST', '图得是 data:image/jpeg 或 data:image/png 的 base64', 400)
  return {
    bytes: new Uint8Array(Buffer.from(m[2]!, 'base64')),
    ext: m[1] === 'png' ? '.png' : '.jpg',
  }
}

/**
 * 读客户端送上来的配方。
 *
 * 客户端可以完全不传（那就当"什么都没改过"）—— 但**绝不能存成 null**：
 * 详情页的"这张图怎么来的"永远要有东西可显示（哪怕是一排 0）。
 */
function readRecipe(raw: unknown): Recipe {
  if (raw === undefined || raw === null) return { params: ZERO, edits: [] }
  const o = asObject(raw)
  const edits = (Array.isArray(o.edits) ? o.edits : [])
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.slice(0, MAX_EDIT_LEN))
    .slice(0, MAX_EDITS)
  return { params: applyDeltas(ZERO, asObject(o.params) as Partial<Adjustments>), edits }
}

export async function handleCreateWork(
  body: unknown, user: PublicUser, deps: WorksDeps,
): Promise<{ id: number }> {
  const o = asObject(body)
  const image = decodeDataUrl(str(o.image))
  if (image.bytes.byteLength === 0) throw new HttpError('BAD_REQUEST', '图是空的', 400)
  if (image.bytes.byteLength > MAX_WORK_BYTES) {
    throw new HttpError('BAD_REQUEST', '这张图太大了，存不下', 413)
  }

  // 缩略图是**可选**的：前端生成失败时，不该让整张图都存不进去（裁定 ②）。
  //
  // ⚠️ **解码和落盘必须在同一个 try 里**。缩略图坏的姿势有两种 —— 形状不对（解不出来）
  // 和存不下去（盘满 / 权限），而两种都只是"这张作品没有缩略图"，不该让用户丢掉整张照片。
  // 一开始只包了落盘那一步：形状坏的缩略图会从 decodeDataUrl 抛出去，把整个请求变成 400，
  // 整张图跟着一起丢 —— 那正是裁定 ② 要防的事，只是从另一条路绕回来了。
  const thumbRaw = str(o.thumb)
  const recipe = readRecipe(o.recipe)

  const storedName = await deps.storage.save(image.bytes, image.ext)
  let thumbName: string | null = null
  if (thumbRaw) {
    try {
      const thumb = decodeDataUrl(thumbRaw)
      thumbName = await deps.storage.save(thumb.bytes, thumb.ext)
    } catch (e) {
      // 两种失败都不该拖垮整张图 —— 但也不能静默：不然盘满、或者前端一直在送坏缩略图，
      // 服务端没有第二个地方会说话
      console.error('缩略图用不了（解不开或者存不下），这张作品没有缩略图：', e)
    }
  }

  const t = nowMs(deps)
  try {
    const r = deps.db.raw.prepare(
      `INSERT INTO works (user_id, stored_name, thumb_name, bytes, created_at, updated_at, alias, recipe)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(user.id, storedName, thumbName, image.bytes.byteLength, t, t, JSON.stringify(recipe))
    return { id: Number(r.lastInsertRowid) }
  } catch (e) {
    // ★ 插不进库就把刚写的文件收回来。不收的话它们永远留在盘上，
    // 而且**没有任何东西知道它们是什么** —— 一个查不到的 id 对应两个文件。
    await deps.storage.remove(storedName).catch(() => { /* 收不回来也不能盖掉原始错误 */ })
    if (thumbName) await deps.storage.remove(thumbName).catch(() => {})
    throw e
  }
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png' }

/** 从文件名尾巴推 MIME。认不出来就按 jpeg —— 存进去的只可能是这两种 */
function mimeOf(name: string): string {
  return MIME[name.slice(name.lastIndexOf('.'))] ?? 'image/jpeg'
}

/**
 * 取一张**属于这个人的**作品。
 *
 * ★ 这个函数是 §6.1「每条查询都带 user_id」的落点 —— 所有按 id 取作品的路径
 * 都必须经过它，不许有人自己写一条 `WHERE id = ?` 就完事。
 *
 * 不是他的、和不存在，回**同一句话**：分开说就等于告诉别人哪些 id 是真的。
 */
export function loadOwned(id: number, user: PublicUser, deps: WorksDeps): WorkRow {
  const row = deps.db.raw.prepare(
    'SELECT * FROM works WHERE id = ? AND user_id = ?',
  ).get(id, user.id) as WorkRow | undefined
  if (!row) throw new HttpError('BAD_REQUEST', '没有这张作品', 404)
  return row
}

export async function handleWorkFile(id: number, user: PublicUser, deps: WorksDeps) {
  const row = loadOwned(id, user, deps)
  return { bytes: await deps.storage.read(row.stored_name), contentType: mimeOf(row.stored_name) }
}

export async function handleWorkThumb(id: number, user: PublicUser, deps: WorksDeps) {
  const row = loadOwned(id, user, deps)
  // 没缩略图就退回原图。缩略图是**前端生成的**，可能失败；
  // 前端按 hasThumb 选 URL，这儿只是兜底 —— 万一两处对不上（比如文件被手工删了），
  // 让用户看到一张大图，也比看到一块白屏强。
  const name = row.thumb_name ?? row.stored_name
  try {
    return { bytes: await deps.storage.read(name), contentType: mimeOf(name) }
  } catch (e) {
    // 原图自己都不在 —— 那就真的是没了，照实抛
    if (name === row.stored_name) throw e
    // ⚠️ **兜底不等于静默**：这里吞掉的可能是权限、是名字守卫、是将来 storage 层的 bug ——
    // 不记一声的话，缩略图整个坏掉我们都不会知道。
    // （和 handleCreateWork 里那条 catch 同一条规矩：不能静默。）
    console.error('缩略图读不出来，退回原图：', e)
    return { bytes: await deps.storage.read(row.stored_name), contentType: mimeOf(row.stored_name) }
  }
}

/** 库里的行 → 给前端的形状。**只给该给的**：`stored_name` 是硬盘上的路径，永远不许出门 */
export function toMeta(row: WorkRow): WorkMeta {
  return {
    id: row.id,
    alias: row.alias,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bytes: row.bytes,
    hasThumb: row.thumb_name !== null,
  }
}

/**
 * 这个人的全部作品 —— **只有元数据，一张图都没有**。
 *
 * §3.5：先摆骨架（哪天、几张），再一张一张去取图。所以这个响应要小、要一次给完，
 * 客户端才好自己分组、搜索、按 60 张一摆地懒加载（裁定 ③）。
 */
export function handleListWorks(user: PublicUser, deps: WorksDeps): { works: WorkMeta[] } {
  const rows = deps.db.raw.prepare(
    `SELECT id, user_id, stored_name, thumb_name, bytes, created_at, updated_at, alias, recipe
     FROM works WHERE user_id = ? ORDER BY updated_at DESC`,
  ).all(user.id) as unknown as WorkRow[]
  return { works: rows.map(toMeta) }
}

/** 单张的详情 —— 比列表多一样：**配方**（§3.5.1 的"这张图怎么来的"） */
export function handleGetWork(id: number, user: PublicUser, deps: WorksDeps): WorkDetail {
  const row = loadOwned(id, user, deps)
  return { ...toMeta(row), recipe: JSON.parse(row.recipe) as Recipe }
}

/** 别名最长多少。60 个字够放下一句描述，又不至于把列表撑变形 */
const MAX_ALIAS = 60

/**
 * 改名。
 *
 * ⚠️ 下面那句注释里的"上面那段说明"，说的就是这一段 —— 这条很容易写错，写清楚在这儿：
 *
 * - §4.1 对 `updated_at` 的说明只有一句：「**替换过就更新**」—— 没提改名
 * - 更要紧的是：**没起名字的时候，`updated_at` 就是显示名**（§3.5）。
 *   改一个名顺手把日期也改了，等于**用户改完名字，那张图的名字和分组位置一起变了**
 */
export function handleRenameWork(
  id: number, body: unknown, user: PublicUser, deps: WorksDeps,
): WorkMeta {
  const row = loadOwned(id, user, deps)
  const raw = asObject(body).alias
  // `null` / 空串 / 全空白，都是"把名字清掉、改回用时间当名字"——
  // 那是个**有意义的状态**（§3.5），不是缺数据，所以存 null 而不是空串
  //
  // ⚠️ **没有 `alias` 这个键**（送的是 `{}`）也走同一条路 = **清名字**。这是个**选定的语义**，
  // 不是漏判：这个 PATCH 只改一样东西，所以 `{}` 和 `{ alias: null }` 等价是说得通的
  // ——"没给名字"就是"没有名字"。写在这儿，下一个读的人不用自己猜。
  // 同理，`alias` 不是字符串时（数字、布尔）也会被 `str` 当成空串，一样是清名字。
  const alias = raw === null || raw === undefined ? null : (str(raw).trim().slice(0, MAX_ALIAS) || null)
  // ⚠️ **只改 alias，不碰 updated_at**（见上面那段说明）
  deps.db.raw.prepare('UPDATE works SET alias = ? WHERE id = ? AND user_id = ?')
    .run(alias, id, user.id)
  return toMeta({ ...row, alias })
}

/**
 * 删一张。
 *
 * ★ **先删记录，再删文件。** 反过来的话（文件先没了、记录删失败），
 * 会留下一条指向不存在文件的记录 —— 那条记录**永远打不开、也删不掉第二次**
 * （因为它还在列表里，而再删一次还是同样的顺序）。反过来失败最多留个孤儿文件：
 * 浪费一点盘，**用户那边完全正常**。
 *
 * 文件删失败不让请求失败：记录已经没了，对用户来说这件事**就是成功了**
 * （§3.5 那条"目标已达成"）。但要记一笔日志，不然盘满的时候没人知道。
 */
export async function handleDeleteWork(id: number, user: PublicUser, deps: WorksDeps): Promise<{ ok: true }> {
  const row = loadOwned(id, user, deps)
  deps.db.raw.prepare('DELETE FROM works WHERE id = ? AND user_id = ?').run(id, user.id)
  await deps.storage.remove(row.stored_name).catch((e) => console.error('作品文件没删掉，成了孤儿：', e))
  if (row.thumb_name) {
    await deps.storage.remove(row.thumb_name).catch((e) => console.error('缩略图没删掉：', e))
  }
  return { ok: true }
}

/**
 * 批量删。
 *
 * §3.5：「不追求全有全无」「如实回报」「不能静默」——
 * 所以**逐个删**（一个出问题不影响别的），并把"本来就不在"的那些**报出来**。
 */
export async function handleDeleteWorks(
  body: unknown, user: PublicUser, deps: WorksDeps,
): Promise<{ deleted: number[]; missing: number[] }> {
  const raw = asObject(body).ids
  if (!Array.isArray(raw)) throw new HttpError('BAD_REQUEST', '没给要删哪些', 400)
  // ★ 非法 id **整个请求拒掉**，不许悄悄 filter 掉：滤掉的话它两个桶里都不在 ——
  // 请求里 12 个、回来说"删了 10 个"，少的那两个既没删掉也没报出来，正是 §3.5 要治的静默。
  const ids = raw.map((x) => Number(x))
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) {
    throw new HttpError('BAD_REQUEST', '要删的 id 得都是正整数', 400)
  }
  if (ids.length === 0) throw new HttpError('BAD_REQUEST', '没给要删哪些', 400)
  // ★ 去重：同一个 id 来两次的话，第二次会当"它已经不在了"进 missing ——
  // 同一个 id **同时**出现在两个桶里，按 `deleted.length` 报"删了 N 张"的前端会多算。
  // 放在上限**之前**：上限管的是"要跑几次"，去重之后才算得准。
  const unique = [...new Set(ids)]
  // 上限：一次别删太多，免得一个请求跑几分钟（前端一次最多选中一屏）
  if (unique.length > 500) throw new HttpError('BAD_REQUEST', '一次最多删 500 张', 400)

  const deleted: number[] = []
  const missing: number[] = []
  for (const id of unique) {
    try {
      await handleDeleteWork(id, user, deps)
      deleted.push(id)
    } catch (e) {
      // ★ 只有「这张不在他的作品集里」才算 missing（**目标已达成**）。
      //   别的（库忙、写盘失败、库损坏）是**真的错了** —— 报成 missing 等于告诉前端"删掉了"，
      //   用户下次刷新会看到它又回来。宁可整条请求失败，让他重新拉一次列表看到真相。
      if (e instanceof HttpError && e.status === 404) missing.push(id)
      else throw e
    }
  }
  return { deleted, missing }
}

/**
 * 替换一张（换图 + 换配方）。
 *
 * ★ 顺序是 §4.4 定死的：**写新文件 → 改记录 → 再删旧文件**。
 * 先删旧的话，新文件还没写成功就把旧的删了 —— 那一下失败就是**图没了**。
 */
export async function handleReplaceWork(
  id: number, body: unknown, user: PublicUser, deps: WorksDeps,
): Promise<WorkMeta> {
  const row = loadOwned(id, user, deps)
  const o = asObject(body)
  const image = decodeDataUrl(str(o.image))
  if (image.bytes.byteLength === 0) throw new HttpError('BAD_REQUEST', '图是空的', 400)
  if (image.bytes.byteLength > MAX_WORK_BYTES) {
    throw new HttpError('BAD_REQUEST', '这张图太大了，存不下', 413)
  }
  const thumbRaw = str(o.thumb)

  const newName = await deps.storage.save(image.bytes, image.ext)
  // ⚠️ **解码和落盘在同一个 try 里**，和 handleCreateWork 一字不差的理由（裁定 ②）：
  // 缩略图坏的姿势有两种 —— 形状不对（解不出来）和存不下去（盘满 / 权限）——
  // 两种都只是"这张作品没有缩略图"。落盘那一步放在 try 外面的话，它一抛，
  // **刚写好的新图**就一个人留在盘上没人认领（记录连提都没提它）。
  let newThumb: string | null = null
  if (thumbRaw) {
    try {
      const thumb = decodeDataUrl(thumbRaw)
      newThumb = await deps.storage.save(thumb.bytes, thumb.ext)
    } catch (e) {
      // 不能静默：不然盘满、或者前端一直在送坏缩略图，服务端没有第二个地方会说话
      console.error('缩略图用不了（解不开或者存不下），这张作品没有缩略图：', e)
    }
  }
  const t = nowMs(deps)

  try {
    deps.db.raw.prepare(
      `UPDATE works SET stored_name = ?, thumb_name = ?, bytes = ?, updated_at = ?, recipe = ?
       WHERE id = ? AND user_id = ?`,
    ).run(newName, newThumb, image.bytes.byteLength, t, JSON.stringify(readRecipe(o.recipe)), id, user.id)
  } catch (e) {
    // 记录没改成功 → 把**新写的**收回来，旧的一动没动：库里和盘上都还是原来那张
    await deps.storage.remove(newName).catch(() => {})
    if (newThumb) await deps.storage.remove(newThumb).catch(() => {})
    throw e
  }

  // ★ 到这儿记录已经指向新文件了，才能删旧的
  await deps.storage.remove(row.stored_name).catch((e) => console.error('旧文件没删掉，成了孤儿：', e))
  if (row.thumb_name) {
    await deps.storage.remove(row.thumb_name).catch((e) => console.error('旧缩略图没删掉：', e))
  }

  return toMeta({ ...row, stored_name: newName, thumb_name: newThumb, bytes: image.bytes.byteLength, updated_at: t })
}
