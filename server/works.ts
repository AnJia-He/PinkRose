import type { Db } from './db.ts'
import type { Storage } from './storage.ts'
import type { PublicUser } from './account.ts'
import { HttpError, asObject, str } from './http.ts'
import { ZERO, applyDeltas, type Adjustments } from '../shared/adjustments.ts'
import type { Recipe } from '../shared/works.ts'

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
