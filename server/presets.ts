import type { PublicUser } from './account.ts'
import { nowMs } from './clock.ts'
import type { Db } from './db.ts'
import { HttpError, asObject, str } from './http.ts'
import { PRESET_LIMIT_REACHED, UNEXPECTED_FAILURE } from '../shared/copy.ts'
import { clampAdjustments, type Adjustments } from '../shared/adjustments.ts'
import { MAX_PRESETS, MAX_PRESET_NAME, presetNameOk, type PresetMeta } from '../shared/preset.ts'

/**
 * ★ 2026-10-10：「我的预设」的服务端。骨架照 `server/luts.ts` 写，
 * **不搬**它那三样：文件 I/O、.cube 解析、清会话引用 —— 预设没有文件、
 * 不被任何东西引用（设计 §3：应用预设是"把参数赋值过去"，会话里存的是那份
 * 参数本身，删预设不影响老会话）。
 *
 * ⚠️ **没有 storage**：纯 JSON 不占共享盘，所以也不进 5 GB 配额（设计 §2.1），
 * 防滥用走的是条数上限（`MAX_PRESETS`）。
 */
export type PresetDeps = { db: Db; now?: () => number }

export type PresetRow = {
  id: number; user_id: number; name: string; params: string; created_at: number
}

/**
 * 库里的行 → 给前端的元数据。
 *
 * ⚠️ 那一列存的是 JSON 字符串，读回来看不懂只有一种原因：**库坏了**（写入路径
 * 只写 `JSON.stringify` 的结果）。这时**不许静默给全零** —— 那对用户就是
 * "我存的那套颜色全归零了"，而真正的原因一声不吭地没了。结局和 sessions 解
 * steps 失败那处对用户看到的一样：500 + 通用那句；详细只进服务端日志。
 */
const toMeta = (r: PresetRow): PresetMeta => {
  let params: Adjustments
  try {
    params = JSON.parse(r.params) as Adjustments
  } catch (e) {
    console.error('预设的参数读不出来（库里那一列坏了）：', e)
    throw new HttpError('INTERNAL', UNEXPECTED_FAILURE, 500)
  }
  return { id: r.id, name: r.name, params, createdAt: r.created_at }
}

/**
 * 取一条**属于这个人的**预设。和 luts/works/sessions 那条规矩一样：
 * 不是他的和不存在回**同一句话**（分开说就等于告诉别人哪些 id 是真的）。
 */
export function loadOwnedPreset(id: number, user: PublicUser, deps: PresetDeps): PresetRow {
  const row = deps.db.raw
    .prepare('SELECT * FROM presets WHERE id = ? AND user_id = ?')
    .get(id, user.id) as PresetRow | undefined
  if (!row) throw new HttpError('BAD_REQUEST', '没有这套预设', 404)
  return row
}

export function listPresets(user: PublicUser, deps: PresetDeps): { presets: PresetMeta[] } {
  const rows = deps.db.raw
    .prepare('SELECT * FROM presets WHERE user_id = ? ORDER BY created_at DESC, id DESC')
    .all(user.id) as PresetRow[]
  return { presets: rows.map(toMeta) }
}

/** 重名（忽略大小写）的统一判据 —— 存和改名共用一句话。 */
function assertNameFree(name: string, user: PublicUser, deps: PresetDeps, exceptId = 0): void {
  const hit = deps.db.raw
    .prepare('SELECT id FROM presets WHERE user_id = ? AND name = ? AND id != ?')
    .get(user.id, name, exceptId)
  if (hit) throw new HttpError('BAD_REQUEST', `已经有一套叫「${name}」的预设了，换个名字。`)
}

/**
 * 名字 → 合法的那份，不合法当场 400。
 *
 * ⚠️ 和 Lut 那两处不一样：**判长短，不 slice**。Lut 的名字可能是 .cube 里的
 * TITLE（外来的，截了就截了）；预设的名字是**用户手打的**——截断等于背着他
 * 把名字改掉（存进去的和他打的那串不一样，而且他不会知道）。判 400 他才知道要改。
 */
function readName(o: Record<string, unknown>): string {
  const name = str(o.name).trim()
  if (!presetNameOk(name)) throw new HttpError('BAD_REQUEST', `预设名字要 1–${MAX_PRESET_NAME} 个字。`)
  return name
}

export function createPreset(
  body: unknown, user: PublicUser, deps: PresetDeps,
): { preset: PresetMeta } {
  const o = asObject(body)
  const name = readName(o)
  // ⚠️ 客户端送来的参数是**可以伪造的输入**，一律过 `clampAdjustments`：
  //   它逐格走 `clampTo`，越界的收进 `PARAM_RANGE`、`undefined`（没送的键）
  //   不是有限数 → 0 —— 出来的一定是完整 15 格。别在这儿另写一份补零。
  const params = clampAdjustments((o.params ?? {}) as Adjustments)

  const count = (deps.db.raw
    .prepare('SELECT COUNT(*) AS n FROM presets WHERE user_id = ?')
    .get(user.id) as { n: number }).n
  if (count >= MAX_PRESETS) throw new HttpError('BAD_REQUEST', PRESET_LIMIT_REACHED(MAX_PRESETS))
  assertNameFree(name, user, deps)

  try {
    const r = deps.db.raw.prepare(
      'INSERT INTO presets (user_id, name, params, created_at) VALUES (?, ?, ?, ?)',
    ).run(user.id, name, JSON.stringify(params), nowMs(deps))
    const row = deps.db.raw.prepare('SELECT * FROM presets WHERE id = ?')
      .get(Number(r.lastInsertRowid)) as PresetRow
    return { preset: toMeta(row) }
  } catch (e) {
    // UNIQUE 兜底：两个请求同时存同一个名字时，上面那次检查会双双放行
    if (String((e as Error).message).includes('UNIQUE')) {
      throw new HttpError('BAD_REQUEST', `已经有一套叫「${name}」的预设了，换个名字。`)
    }
    throw e
  }
}

export function renamePreset(
  id: number, body: unknown, user: PublicUser, deps: PresetDeps,
): { preset: PresetMeta } {
  const row = loadOwnedPreset(id, user, deps)
  const name = readName(asObject(body))
  // 同名（一个字都没改）跳过查重 —— 那一下本来就查不到东西（自己排除在外），
  // 白查一次库；而且"什么都没改"是合法输入，不该逼用户先换个别的名字再换回来
  if (name !== row.name) assertNameFree(name, user, deps, id)
  deps.db.raw.prepare('UPDATE presets SET name = ? WHERE id = ?').run(name, id)
  return { preset: toMeta({ ...row, name }) }
}

/** 删一条：就是删行 + `{ ok: true }` —— 没有 luts 那半"清会话引用"（设计 §3）。 */
export function deletePreset(id: number, user: PublicUser, deps: PresetDeps): { ok: true } {
  loadOwnedPreset(id, user, deps)   // 不是他的 / 不存在 → 404（同一句话）
  deps.db.raw.prepare('DELETE FROM presets WHERE id = ?').run(id)
  return { ok: true }
}
