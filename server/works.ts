import type { Db } from './db.ts'
import type { Storage } from './storage.ts'
import type { PublicUser } from './account.ts'
import { randomBytes } from 'node:crypto'
import { nowMs } from './clock.ts'
import { HttpError, asObject, str } from './http.ts'
import { mimeOf, readImageDataUrl, saveOptionalThumb } from './imagedata.ts'
import { assertRoomFor } from './quota.ts'
import { ZERO, applyDeltas, type Adjustments } from '../shared/adjustments.ts'
import { MAX_LUT_NAME } from '../shared/lut.ts'
import {
  isWorkColor, type Recipe, type SharedWork, type WorkColor, type WorkDetail,
  type WorkFlag, type WorkMeta,
} from '../shared/works.ts'

export type WorksDeps = { db: Db; storage: Storage; now?: () => number }

/** 单张图的上限。前端导出的是 2048 长边的 JPEG，一般 1 MB 上下 —— 8 MB 是很宽的余量 */
const MAX_WORK_BYTES = 8 * 1024 * 1024
/** 配方里最多记几句、每句多长。防的是"有人存一万条" */
const MAX_EDITS = 100
const MAX_EDIT_LEN = 200

export type WorkRow = {
  id: number; user_id: number; stored_name: string; thumb_name: string | null
  bytes: number; created_at: number; updated_at: number; alias: string | null
  recipe: string; rating: number; flag: number; color: string | null
  share_token: string | null; source_name: string | null; captured_at: number | null
  camera_make: string | null; camera_model: string | null; lens_model: string | null
}

const MAX_SOURCE_NAME = 180
const MAX_EQUIPMENT_NAME = 120

function readSourceName(raw: unknown): string | null {
  const value = str(raw).trim()
  if (!value) return null
  const name = value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return name ? name.slice(0, MAX_SOURCE_NAME) : null
}

function readCapturedAt(raw: unknown): number | null {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 && value < 4_102_444_800_000
    ? Math.round(value)
    : null
}

function readEquipmentName(raw: unknown): string | null {
  const value = str(raw).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return value ? value.slice(0, MAX_EQUIPMENT_NAME) : null
}

/** 配方里的滤镜：只认 `{ name: 1–30 字, amount: 0–100 }`，别的形状当没有。 */
function readRecipeLut(raw: unknown): { name: string; amount: number } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const name = str(o.name).trim()
  const amount = Number(o.amount)
  // ⚠️ 名字超出 1–30 字**直接当没有**，不是截断：30 是库里那条 UNIQUE 名字约束
  //    的上限，一个超过 30 字的名字**不可能**对应任何真滤镜 —— 截断出来的那 30 个字
  //    既匹配不上任何滤镜，又是详情页上的一句假话（"当时用的是这玩意儿"）。
  if (!name || name.length > MAX_LUT_NAME || !Number.isFinite(amount)) return null
  return { name, amount: Math.max(0, Math.min(100, Math.round(amount))) }
}

/**
 * 读客户端送上来的配方。
 *
 * 客户端可以完全不传（那就当"什么都没改过"）—— 但**绝不能存成 null**：
 * 详情页的"这张图怎么来的"永远要有东西可显示（哪怕是一排 0）。
 *
 * ★ 2026-10-05：出口恒带 `lut`（值或显式 null）。它**只存名字不存 id** ——
 * 这张图是存的时候烤好的，id 没有渲染作用；「套到别的图上」按名字去找还在不在。
 */
function readRecipe(raw: unknown): Recipe {
  if (raw === undefined || raw === null) return { params: ZERO, edits: [], lut: null }
  const o = asObject(raw)
  const edits = (Array.isArray(o.edits) ? o.edits : [])
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.slice(0, MAX_EDIT_LEN))
    .slice(0, MAX_EDITS)
  return { params: applyDeltas(ZERO, asObject(o.params) as Partial<Adjustments>), edits, lut: readRecipeLut(o.lut) }
}

export async function handleCreateWork(
  body: unknown, user: PublicUser, deps: WorksDeps,
): Promise<{ id: number }> {
  const o = asObject(body)
  // 解码 + "空的 / 太大"那两个判断在 `imagedata.ts` 的 `readImageDataUrl` 里
  // （作品和会话四处共用一份，上限从这里给）。
  const image = readImageDataUrl(str(o.image), MAX_WORK_BYTES)

  // 缩略图是**可选**的：前端生成失败时，不该让整张图都存不进去（裁定 ②）。
  //
  // ⚠️ **解码和落盘必须在同一个 try 里**。缩略图坏的姿势有两种 —— 形状不对（解不出来）
  // 和存不下去（盘满 / 权限），而两种都只是"这张作品没有缩略图"，不该让用户丢掉整张照片。
  // 一开始只包了落盘那一步：形状坏的缩略图会从 decodeDataUrl 抛出去，把整个请求变成 400，
  // 整张图跟着一起丢 —— 那正是裁定 ② 要防的事，只是从另一条路绕回来了。
  const thumbRaw = str(o.thumb)
  const recipe = readRecipe(o.recipe)
  const sourceName = readSourceName(o.sourceName)
  const capturedAt = readCapturedAt(o.capturedAt)
  const cameraMake = readEquipmentName(o.cameraMake)
  const cameraModel = readEquipmentName(o.cameraModel)
  const lensModel = readEquipmentName(o.lensModel)

  // ★ 2026-10-04（§6.6，5 GB 配额）：**先看配额再落盘**。缩略图那点字节先按 0 算
  //   （≤1 MB，5 GB 量级上它是零头），和 sessions 那边同一个口径。
  assertRoomFor(deps.db, user.id, image.bytes.byteLength, 'work')
  const storedName = await deps.storage.save(image.bytes, image.ext)
  // 缩略图是**可选**的：前端生成失败时，不该让整张图都存不进去（裁定 ②）。
  // 解码、限额、落盘、吞错这一整套现在只有一份 —— `imagedata.ts` 的
  // `saveOptionalThumb`（它头上那两条 ⚠️ 就是这里原来的注释）。
  const thumbName = (await saveOptionalThumb(thumbRaw, deps.storage, '这张作品'))?.name ?? null

  const t = nowMs(deps)
  try {
    // 新行的 created_at / updated_at 都取同一个 t。这里把 updated_at 当版本号是安全的：
    // id 是刚生出来的，不存在"浏览器缓存里还留着上一版"这回事。真正承重的那一处是
    // handleReplaceWork —— 那里为什么必须 bump，说在它上面。
    const r = deps.db.raw.prepare(
      `INSERT INTO works (
         user_id, stored_name, thumb_name, bytes, created_at, updated_at,
         alias, recipe, source_name, captured_at, camera_make, camera_model, lens_model
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(
      user.id, storedName, thumbName, image.bytes.byteLength,
      t, t, JSON.stringify(recipe), sourceName, capturedAt,
      cameraMake, cameraModel, lensModel,
    )
    return { id: Number(r.lastInsertRowid) }
  } catch (e) {
    // ★ 插不进库就把刚写的文件收回来。不收的话它们永远留在盘上，
    // 而且**没有任何东西知道它们是什么** —— 一个查不到的 id 对应两个文件。
    await deps.storage.remove(storedName).catch(() => { /* 收不回来也不能盖掉原始错误 */ })
    if (thumbName) await deps.storage.remove(thumbName).catch(() => {})
    throw e
  }
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
    rating: row.rating ?? 0,
    flag: row.flag === -1 ? -1 : row.flag === 1 ? 1 : 0,
    color: isWorkColor(row.color) ? row.color : 'none',
    sourceName: row.source_name ?? null,
    capturedAt: row.captured_at ?? null,
    cameraMake: row.camera_make ?? null,
    cameraModel: row.camera_model ?? null,
    lensModel: row.lens_model ?? null,
  }
}

/**
 * 这个人的全部作品 —— **只有元数据，一张图都没有**。
 *
 * §3.5：先摆骨架（哪天、几张），再一张一张去取图。所以这个响应要小、要一次给完，
 * 客户端才好自己分组、搜索、按 60 张一摆地懒加载（裁定 ③）。
 */
export function handleListWorks(
  user: PublicUser, deps: WorksDeps, albumId?: number,
): { works: WorkMeta[] } {
  if (albumId !== undefined && (!Number.isInteger(albumId) || albumId <= 0)) {
    throw new HttpError('BAD_REQUEST', '相册 id 得是正整数', 400)
  }
  // ⚠️ 不带 `recipe`（2026-10-04）：列表只要元数据，而配方是整块 JSON ——
  //    每一行都白捞一次（详情页那条 handleGetWork 才要它）。
  const rows = albumId === undefined
    ? deps.db.raw.prepare(
      `SELECT id, user_id, stored_name, thumb_name, bytes, created_at, updated_at,
              alias, rating, flag, color, source_name, captured_at,
              camera_make, camera_model, lens_model
       FROM works WHERE user_id = ? ORDER BY updated_at DESC`,
    ).all(user.id) as unknown as WorkRow[]
    : deps.db.raw.prepare(
      `SELECT w.id, w.user_id, w.stored_name, w.thumb_name, w.bytes, w.created_at,
              w.updated_at, w.alias, w.rating, w.flag, w.color, w.source_name, w.captured_at,
              w.camera_make, w.camera_model, w.lens_model
       FROM works w
       JOIN work_albums wa ON wa.work_id = w.id
       JOIN albums a ON a.id = wa.album_id AND a.user_id = w.user_id
       WHERE w.user_id = ? AND wa.album_id = ?
       ORDER BY w.updated_at DESC`,
    ).all(user.id, albumId) as unknown as WorkRow[]
  return { works: rows.map(toMeta) }
}

/** 单张的详情 —— 比列表多一样：**配方**（§3.5.1 的"这张图怎么来的"） */
export function handleGetWork(id: number, user: PublicUser, deps: WorksDeps): WorkDetail {
  const row = loadOwned(id, user, deps)
  return {
    ...toMeta(row),
    recipe: JSON.parse(row.recipe) as Recipe,
    shareToken: row.share_token ?? null,
  }
}

/** 分享 token 的形状：24 字节 base64url，正好 32 个字符。 */
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/

function newShareToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * 开启（或取回）一张作品的公开分享 token。
 *
 * 幂等：已经有 token 就原样返回；用户点几次「分享链接」不会每次都换一条
 * —— 换掉的话，之前发出去的链接会**静默失效**。
 */
export function handleCreateWorkShare(
  id: number, user: PublicUser, deps: WorksDeps,
): { token: string } {
  const row = loadOwned(id, user, deps)
  if (row.share_token) return { token: row.share_token }
  // 唯一索引极低概率撞上；重试几次足够，别把随机数当绝对。
  for (let i = 0; i < 4; i++) {
    const token = newShareToken()
    try {
      const r = deps.db.raw.prepare(
        'UPDATE works SET share_token = ? WHERE id = ? AND user_id = ? AND share_token IS NULL',
      ).run(token, id, user.id)
      if (r.changes > 0) return { token }
      // 另一个请求刚好先开了分享：用它的 token，别把用户引到 500。
      const current = loadOwned(id, user, deps).share_token
      if (current) return { token: current }
    } catch (e) {
      // 唯一索引撞了：换一个 token 再试；别的写入错误原样抛出去。
      if (!String((e as Error)?.message ?? '').includes('UNIQUE constraint failed')) throw e
    }
  }
  throw new HttpError('INTERNAL', '分享链接没建成，再试一次', 500)
}

/** 停止分享：清掉 token，旧链接立刻 404。 */
export function handleRevokeWorkShare(
  id: number, user: PublicUser, deps: WorksDeps,
): { ok: true } {
  loadOwned(id, user, deps)
  deps.db.raw.prepare('UPDATE works SET share_token = NULL WHERE id = ? AND user_id = ?')
    .run(id, user.id)
  return { ok: true }
}

function sharedRow(token: string, deps: WorksDeps): WorkRow {
  if (!SHARE_TOKEN_RE.test(token)) throw new HttpError('BAD_REQUEST', '这个分享链接不在了', 404)
  const row = deps.db.raw.prepare('SELECT * FROM works WHERE share_token = ?')
    .get(token) as WorkRow | undefined
  if (!row) throw new HttpError('BAD_REQUEST', '这个分享链接不在了', 404)
  return row
}

/** 公开分享页的元数据：**只给图、名字和时间**，不带配方 / 用户 / 文件名。 */
export function handleGetSharedWork(token: string, deps: WorksDeps): SharedWork {
  const row = sharedRow(token, deps)
  return {
    token,
    alias: row.alias,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasThumb: row.thumb_name !== null,
  }
}

/** 公开分享的图片字节。没有缩略图时退回原图（和作品详情同一条兜底）。 */
export async function handleSharedWorkFile(
  token: string, deps: WorksDeps, wantThumb = false,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const row = sharedRow(token, deps)
  const name = wantThumb ? row.thumb_name ?? row.stored_name : row.stored_name
  return { bytes: await deps.storage.read(name), contentType: mimeOf(name) }
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
  // ⚠️ **只改 alias，不碰 updated_at**（见上面那段说明）。这里的"不 bump"是**对的**，
  // 下一个读的人别顺手"修"它 —— 两个理由一起成立：
  //   · `updated_at` 是图片 URL 的版本号（见 handleReplaceWork 上面那段）—— 而改名
  //     **不改字节**，文件还是那一个，URL 里的钥匙本来就不该动；
  //   · 没起名字时 `updated_at` 还是**显示名**，bump 一下等于用户改完名字，
  //     名字和列表里的分组日期一起变了。
  deps.db.raw.prepare('UPDATE works SET alias = ? WHERE id = ? AND user_id = ?')
    .run(alias, id, user.id)
  return toMeta({ ...row, alias })
}

function readRating(body: unknown): number {
  const rating = Number(asObject(body).rating)
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
    throw new HttpError('BAD_REQUEST', '星级只能是 0~5 的整数', 400)
  }
  return rating
}

function readFlag(body: unknown): WorkFlag {
  const flag = Number(asObject(body).flag)
  if (flag !== -1 && flag !== 0 && flag !== 1) {
    throw new HttpError('BAD_REQUEST', '标记只能是 -1、0 或 1', 400)
  }
  return flag
}

function readColor(body: unknown): WorkColor {
  const color = asObject(body).color
  if (!isWorkColor(color)) {
    throw new HttpError('BAD_REQUEST', '颜色标签只能是 none、red、yellow、green、blue 或 purple', 400)
  }
  return color
}

/** 给作品打分（0 = 清除评分，1~5 星）。不动 `updated_at`：不是图片字节变化。 */
export function handleRateWork(
  id: number, body: unknown, user: PublicUser, deps: WorksDeps,
): WorkMeta {
  const row = loadOwned(id, user, deps)
  const rating = readRating(body)
  deps.db.raw.prepare('UPDATE works SET rating = ? WHERE id = ? AND user_id = ?')
    .run(rating, id, user.id)
  return toMeta({ ...row, rating })
}

/** 选片标记（-1 排除 / 0 清除 / 1 保留）。和评分一样不动 `updated_at`。 */
export function handleFlagWork(
  id: number, body: unknown, user: PublicUser, deps: WorksDeps,
): WorkMeta {
  const row = loadOwned(id, user, deps)
  const flag = readFlag(body)
  deps.db.raw.prepare('UPDATE works SET flag = ? WHERE id = ? AND user_id = ?')
    .run(flag, id, user.id)
  return toMeta({ ...row, flag })
}

/** 批量选片标记：混合的保留 / 复查建议在一次往返里落库。 */
export function handleFlagWorks(
  body: unknown, user: PublicUser, deps: WorksDeps,
): { flagged: number[]; missing: number[] } {
  const o = asObject(body)
  if (!Array.isArray(o.items)) throw new HttpError('BAD_REQUEST', '没给要标记的作品', 400)
  if (o.items.length === 0) throw new HttpError('BAD_REQUEST', '没给要标记的作品', 400)
  if (o.items.length > 500) throw new HttpError('BAD_REQUEST', '一次最多标记 500 张', 400)

  const wanted = new Map<number, WorkFlag>()
  for (const raw of o.items) {
    const item = asObject(raw)
    const id = Number(item.id)
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError('BAD_REQUEST', '作品 id 得都是正整数', 400)
    }
    wanted.set(id, readFlag(item))
  }
  const ids = [...wanted.keys()]
  const placeholders = ids.map(() => '?').join(',')
  const owned = deps.db.raw.prepare(
    `SELECT id FROM works WHERE user_id = ? AND id IN (${placeholders})`,
  ).all(user.id, ...ids) as { id: number }[]
  const found = new Set(owned.map(row => row.id))
  const flagged = ids.filter(id => found.has(id))
  const missing = ids.filter(id => !found.has(id))

  for (const flag of [-1, 0, 1] as const) {
    const group = flagged.filter(id => wanted.get(id) === flag)
    if (group.length === 0) continue
    const marks = group.map(() => '?').join(',')
    deps.db.raw.prepare(
      `UPDATE works SET flag = ? WHERE user_id = ? AND id IN (${marks})`,
    ).run(flag, user.id, ...group)
  }
  return { flagged, missing }
}

/** 选片颜色标签；和评分 / 保留排除一样不动 `updated_at`。 */
export function handleColorWork(
  id: number, body: unknown, user: PublicUser, deps: WorksDeps,
): WorkMeta {
  const row = loadOwned(id, user, deps)
  const color = readColor(body)
  deps.db.raw.prepare('UPDATE works SET color = ? WHERE id = ? AND user_id = ?')
    .run(color, id, user.id)
  return toMeta({ ...row, color })
}

/**
 * 批量评分：一次只改评分，不改 `updated_at`。
 * 不在当前用户作品集里的 id 单独放进 `missing`，其余照常更新。
 */
export function handleRateWorks(
  body: unknown, user: PublicUser, deps: WorksDeps,
): { rated: number[]; missing: number[] } {
  const o = asObject(body)
  const raw = o.ids
  if (!Array.isArray(raw)) throw new HttpError('BAD_REQUEST', '没给要评分的作品', 400)
  const ids = raw.map(x => Number(x))
  if (ids.some(x => !Number.isInteger(x) || x <= 0)) {
    throw new HttpError('BAD_REQUEST', '作品 id 得都是正整数', 400)
  }
  if (ids.length === 0) throw new HttpError('BAD_REQUEST', '没给要评分的作品', 400)
  const unique = [...new Set(ids)]
  if (unique.length > 500) throw new HttpError('BAD_REQUEST', '一次最多给 500 张评分', 400)
  const rating = readRating(o)

  const placeholders = unique.map(() => '?').join(',')
  const owned = deps.db.raw.prepare(
    `SELECT id FROM works WHERE user_id = ? AND id IN (${placeholders})`,
  ).all(user.id, ...unique) as { id: number }[]
  const found = new Set(owned.map(row => row.id))
  const rated = unique.filter(id => found.has(id))
  const missing = unique.filter(id => !found.has(id))

  if (rated.length > 0) {
    const ratedMarks = rated.map(() => '?').join(',')
    deps.db.raw.prepare(
      `UPDATE works SET rating = ? WHERE user_id = ? AND id IN (${ratedMarks})`,
    ).run(rating, user.id, ...rated)
  }
  return { rated, missing }
}

/** 批量颜色标签：一次往返；不在当前用户作品集里的 id 单独放进 `missing`。 */
export function handleColorWorks(
  body: unknown, user: PublicUser, deps: WorksDeps,
): { colored: number[]; missing: number[] } {
  const o = asObject(body)
  if (!Array.isArray(o.ids)) throw new HttpError('BAD_REQUEST', '没给要标色的作品', 400)
  const ids = o.ids.map(x => Number(x))
  if (ids.some(x => !Number.isInteger(x) || x <= 0)) {
    throw new HttpError('BAD_REQUEST', '作品 id 得都是正整数', 400)
  }
  if (ids.length === 0) throw new HttpError('BAD_REQUEST', '没给要标色的作品', 400)
  const unique = [...new Set(ids)]
  if (unique.length > 500) throw new HttpError('BAD_REQUEST', '一次最多给 500 张标色', 400)
  const color = readColor(o)

  const placeholders = unique.map(() => '?').join(',')
  const owned = deps.db.raw.prepare(
    `SELECT id FROM works WHERE user_id = ? AND id IN (${placeholders})`,
  ).all(user.id, ...unique) as { id: number }[]
  const found = new Set(owned.map(row => row.id))
  const colored = unique.filter(id => found.has(id))
  const missing = unique.filter(id => !found.has(id))

  if (colored.length > 0) {
    const marks = colored.map(() => '?').join(',')
    deps.db.raw.prepare(
      `UPDATE works SET color = ? WHERE user_id = ? AND id IN (${marks})`,
    ).run(color, user.id, ...colored)
  }
  return { colored, missing }
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
  const image = readImageDataUrl(str(o.image), MAX_WORK_BYTES)
  const thumbRaw = str(o.thumb)

  // ★ 2026-10-04（§6.6，5 GB 配额）：替换也是**写一份新的**，要过配额 ——
  //   但旧文件随后会被删掉，所以把它那份字节**先扣掉**（freeing）：
  //   不扣的话，一个人在 99.9% 的时候连"换一张更小的"都做不了。
  assertRoomFor(deps.db, user.id, image.bytes.byteLength, 'work', row.bytes)

  const newName = await deps.storage.save(image.bytes, image.ext)
  // ⚠️ 缩略图那套（解码 + 限额 + 落盘 + 吞错）现在在 `saveOptionalThumb` 里 ——
  // 和 handleCreateWork 同一条裁定 ②，理由收在 `imagedata.ts` 那个函数头上。
  const newThumb = (await saveOptionalThumb(thumbRaw, deps.storage, '这张作品'))?.name ?? null
  const t = nowMs(deps)

  // ★★ `updated_at` 在这里**不只是"上次改的时间"，它是图片 URL 的版本号**。
  //
  // 前端三条图片 URL 全都把它拼进去当缓存钥匙：列表缩略图（`fileUrl`）、
  // 详情页大图（`.detail-image`）、「下载」（`fullUrl`）——
  // 而 `/api/works/:id/file` 和 `/thumb` 回的是 **`immutable`** 长缓存。
  //
  // ⚠️ 所以**任何改动这张作品的字节的写入，都必须 bump 这个值**。忘了 bump 不会报错、
  // 不会 4xx、日志里一个字都没有：用户只是**静默地**一直看到缓存里那张旧图
  // （反馈只有一句「怎么没变」）。验收记录 §3 的 P1/P2 量过 bump 之后三处都刷新
  // （大图 `?v=` 变了、平均亮度 118.73 → 77.54；列表那张同样）；反过来那条路没人量过，
  // 因为它**没有报错可以看**。将来加新的写接口（换图、换缩略图、批量改图…）时，
  // 这一句是唯一会提醒你的东西。
  try {
    // ★ 2026-10-04（审计 F3）：`AND updated_at = ?` 是**乐观锁**，和 `sessions.ts`
    //   那条同一个形状。这一段是「读那一行 → `await` 落盘 → 写回去」，中间那个
    //   await 让出了事件循环 —— 两个标签页同时保存会**都读到旧行**，后写的把先写
    //   的整个盖掉（两次都回 200），而先写者刚落盘的文件从此**没人认领**；
    //   一边 PUT 一边 DELETE 更糟 —— 记录已经没了，UPDATE 影响 0 行却照样回 200，
    //   新文件变成一个永远查不到主人的孤儿。
    //   `updated_at` 本来就在这一行上（见上面那段），直接拿来当版本号。
    const res = deps.db.raw.prepare(
      `UPDATE works SET stored_name = ?, thumb_name = ?, bytes = ?, updated_at = ?, recipe = ?
       WHERE id = ? AND user_id = ? AND updated_at = ?`,
    ).run(newName, newThumb, image.bytes.byteLength, t, JSON.stringify(readRecipe(o.recipe)),
      id, user.id, row.updated_at)
    if (res.changes === 0) {
      // 文案规范 5：哪不对 + 怎么办。不许说成"没登录"或者"图不对" —— 那是另一回事。
      throw new HttpError('CONFLICT',
        '这张图刚刚在别的地方改过了，这次没存进去（免得把那边的新内容盖掉）。刷新一下看看。', 409)
    }
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
