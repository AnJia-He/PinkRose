import type { PublicUser } from './account.ts'
import { nowMs } from './clock.ts'
import type { Db } from './db.ts'
import { HttpError, asObject, str } from './http.ts'
import { assertRoomFor } from './quota.ts'
import type { Storage } from './storage.ts'
import { LUT_FILE_TOO_BIG, LUT_LIMIT_REACHED } from '../shared/copy.ts'
import {
  MAX_LUTS, MAX_LUT_FILE_BYTES, LutParseError, lutNameOk, normalizeLutRef, parseCube,
  type Cube, type LutMeta, type LutRef,
} from '../shared/lut.ts'

export type LutDeps = { db: Db; storage: Storage; now?: () => number }

export type LutRow = {
  id: number; user_id: number; name: string; stored_name: string
  size: number; bytes: number; created_at: number
}

const toMeta = (r: LutRow): LutMeta =>
  ({ id: r.id, name: r.name, size: r.size, bytes: r.bytes, createdAt: r.created_at })

/**
 * 取一条**属于这个人的**滤镜。和 works/sessions 那条规矩一样：
 * 不是他的和不存在回**同一句话**（分开说就等于告诉别人哪些 id 是真的）。
 */
export function loadOwnedLut(id: number, user: PublicUser, deps: LutDeps): LutRow {
  const row = deps.db.raw
    .prepare('SELECT * FROM luts WHERE id = ? AND user_id = ?')
    .get(id, user.id) as LutRow | undefined
  if (!row) throw new HttpError('BAD_REQUEST', '没有这个 Lut', 404)
  return row
}

export function listLuts(user: PublicUser, deps: LutDeps): { luts: LutMeta[] } {
  const rows = deps.db.raw
    .prepare('SELECT * FROM luts WHERE user_id = ? ORDER BY created_at DESC, id DESC')
    .all(user.id) as LutRow[]
  return { luts: rows.map(toMeta) }
}

/** 重名（忽略大小写）的统一判据 —— 导入和改名共用一句话。 */
function assertNameFree(name: string, user: PublicUser, deps: LutDeps, exceptId = 0): void {
  const hit = deps.db.raw
    .prepare('SELECT id FROM luts WHERE user_id = ? AND name = ? AND id != ?')
    .get(user.id, name, exceptId)
  if (hit) throw new HttpError('BAD_REQUEST', `已经有一个叫「${name}」的 Lut 了，换个名字。`)
}

export async function createLut(
  body: unknown, user: PublicUser, deps: LutDeps,
): Promise<{ lut: LutMeta }> {
  const o = asObject(body)
  const text = str(o.cube)
  if (!text) throw new HttpError('BAD_REQUEST', '没有收到文件内容')
  // ★ 落盘、上限和账本用的是**同一份 UTF-8 字节**（和 works/sessions 那边一个口径，
  //   那边每一处都是 `.byteLength`）。原来这里用的是 `text.length`（UTF-16 码元数）——
  //   `.cube` 正常是纯 ASCII、两者相等，但这不该是"闸和账本成立"的前提：
  //   Task 4 起 `bytes` 要进 5 GB 配额账本，非 ASCII 的输入（比如中文 TITLE）
  //   按码元数算会**偏小**，账本跟着偏。
  const encoded = new TextEncoder().encode(text)
  // 这句话在**界面那一侧**也拦一道（`LutSettings.tsx` 里选了文件当场就说）——
  // 两处用的是 `shared/copy.ts` 里同一个常量，别在这儿另写一句。
  if (encoded.byteLength > MAX_LUT_FILE_BYTES) {
    throw new HttpError('BAD_REQUEST', LUT_FILE_TOO_BIG(MAX_LUT_FILE_BYTES))
  }

  let cube: Cube
  try {
    cube = parseCube(text)
  } catch (e) {
    if (e instanceof LutParseError) throw new HttpError('BAD_REQUEST', e.message)
    throw e
  }

  // 名字：客户端给的 → .cube 里的 TITLE → 兜底
  const raw = str(o.name).trim() || cube.title?.trim() || '未命名'
  const name = raw.slice(0, 30)
  if (!lutNameOk(name)) throw new HttpError('BAD_REQUEST', 'Lut 名字要 1–30 个字。')

  const count = (deps.db.raw
    .prepare('SELECT COUNT(*) AS n FROM luts WHERE user_id = ?')
    .get(user.id) as { n: number }).n
  if (count >= MAX_LUTS) throw new HttpError('BAD_REQUEST', LUT_LIMIT_REACHED(MAX_LUTS))
  assertNameFree(name, user, deps)

  // 配额和落盘都走既有的那一套（Task 4 会把 luts 计入 storedBytes）
  assertRoomFor(deps.db, user.id, encoded.byteLength, 'lut')
  const storedName = await deps.storage.save(encoded, '.cube')
  try {
    const r = deps.db.raw.prepare(
      `INSERT INTO luts (user_id, name, stored_name, size, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(user.id, name, storedName, cube.size, encoded.byteLength, nowMs(deps))
    const row = deps.db.raw.prepare('SELECT * FROM luts WHERE id = ?').get(Number(r.lastInsertRowid)) as LutRow
    return { lut: toMeta(row) }
  } catch (e) {
    // 插不进库就把刚写的文件收回来（和 handleCreateWork 同一条）
    await deps.storage.remove(storedName).catch(() => {})
    // UNIQUE 兜底：两个请求同时导入同一个名字时，上面那次检查会双双放行
    if (String((e as Error).message).includes('UNIQUE')) {
      throw new HttpError('BAD_REQUEST', `已经有一个叫「${name}」的 Lut 了，换个名字。`)
    }
    throw e
  }
}

export async function handleLutFile(
  id: number, user: PublicUser, deps: LutDeps,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const row = loadOwnedLut(id, user, deps)
  return { bytes: await deps.storage.read(row.stored_name), contentType: 'text/plain; charset=utf-8' }
}

export function renameLut(
  id: number, body: unknown, user: PublicUser, deps: LutDeps,
): { lut: LutMeta } {
  const row = loadOwnedLut(id, user, deps)
  const name = str(asObject(body).name).trim().slice(0, 30)
  if (!lutNameOk(name)) throw new HttpError('BAD_REQUEST', 'Lut 名字要 1–30 个字。')
  if (name !== row.name) assertNameFree(name, user, deps, id)
  deps.db.raw.prepare('UPDATE luts SET name = ? WHERE id = ?').run(name, id)
  return { lut: toMeta({ ...row, name }) }
}

/** 有几条会话的某一步正用着它（**逐条解析 steps 数出来**，不是 SQL 模糊匹配）。 */
export function lutUsage(id: number, user: PublicUser, deps: LutDeps): { sessions: number } {
  const rows = deps.db.raw
    .prepare('SELECT steps FROM sessions WHERE user_id = ?')
    .all(user.id) as { steps: string }[]
  let n = 0
  for (const r of rows) {
    let steps: unknown
    try { steps = JSON.parse(r.steps) } catch { continue }   // 坏 JSON 不该拖垮删除
    if (Array.isArray(steps) && steps.some((s) => (s as { lut?: LutRef | null }).lut?.lutId === id)) n++
  }
  return { sessions: n }
}

/**
 * 会话步骤在库里那一列的形状 —— 这一层只关心 `lut` 那一格。
 * ⚠️ 别 import `sessions.ts` 的 `StoredStep`：那是它私有的（`image` 那半截是
 * 服务端内部的事），这里要的恰好只是"能安全地读 lut、其余原样带过"。
 */
type StoredStepLike = { lut?: LutRef | null } & Record<string, unknown>

/**
 * 删一条滤镜：**真删**（用户拍板）—— 行、文件，以及所有指向它的引用。
 *
 * ⚠️ 顺序：先删行 → 清会话引用（不留悬空）→ 删文件。文件删失败不让请求失败
 * （对用户来说这件事就是成功了），但要记一笔日志，不然盘满时没人知道。
 */
export async function deleteLut(id: number, user: PublicUser, deps: LutDeps): Promise<{ ok: true }> {
  const row = loadOwnedLut(id, user, deps)
  deps.db.raw.prepare('DELETE FROM luts WHERE id = ?').run(id)
  // ★ 把这个人所有会话步骤里指向它的引用**清成 null**（用户拍板的删除语义：
  //   删了就是真删，老会话再打开会变回没有滤镜的样子 —— 但不许留下悬空 id）。
  //   逐条读改写：会话条数是"一个人"的量级，够用；而且 JSON 里的 id 不能用
  //   SQL 的 LIKE 找（`"lutId":3` 会撞上 params 里的数字）。
  const rows = deps.db.raw
    .prepare('SELECT id, steps FROM sessions WHERE user_id = ?')
    .all(user.id) as { id: number; steps: string }[]
  for (const r of rows) {
    let steps: StoredStepLike[]
    try { steps = JSON.parse(r.steps) as StoredStepLike[] } catch { continue }  // 坏 JSON 不该拖垮删除
    if (!Array.isArray(steps)) continue
    let hit = false
    const next = steps.map((s) => {
      if (s?.lut?.lutId !== id) return s
      hit = true
      return { ...s, lut: null }
    })
    if (hit) deps.db.raw.prepare('UPDATE sessions SET steps = ? WHERE id = ?').run(JSON.stringify(next), r.id)
  }
  await deps.storage.remove(row.stored_name).catch((e) => {
    console.error('删滤镜：文件没删掉（记录已清，成了孤儿）：', e)
  })
  return { ok: true }
}

/**
 * 把客户端/库里来的一个 `LutRef` 解析成可信的：**id 必须是这个人的、存在的**。
 * 认不出来回 null（= 没有滤镜）—— 这是"不许悬空引用"那道闸的落点（Task 4 用它）。
 */
export function resolveLutRef(db: Db, userId: number, raw: unknown): LutRef | null {
  const ref = normalizeLutRef(raw)
  if (!ref) return null
  const hit = db.raw.prepare('SELECT id FROM luts WHERE id = ? AND user_id = ?').get(ref.lutId, userId)
  return hit ? ref : null
}
