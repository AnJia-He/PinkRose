import {
  ALIAS_REQUIRED, BASE_URL_REQUIRED, KEY_REQUIRED, MODEL_ID_REQUIRED, NEED_KEY, UNREADABLE_KEY_HINT,
} from '../shared/copy.ts'
import type { PublicUser } from './account.ts'
import type { Db } from './db.ts'
import { HttpError, asObject, str } from './http.ts'
import { assertModelHostAllowed } from './hostGuard.ts'
import type { Vault } from './keyvault.ts'

export type ModelKind = 'chat' | 'image'
/**
 * 协议形状。`sensenova` / `custom` 都是历史值（都按 OpenAI 兼容处理）——
 * ★ 2026-10-05 加了 `anthropic-compatible`（Claude 官方那种 /v1/messages 形状，
 * 用户原来接不了）；**只有 chat 类别有它**（见 `assertProviderFitsKind`）。
 */
export type Provider = 'sensenova' | 'openai-compatible' | 'anthropic-compatible' | 'custom'

const KINDS: readonly ModelKind[] = ['chat', 'image']
const PROVIDERS: readonly Provider[] = ['sensenova', 'openai-compatible', 'anthropic-compatible', 'custom']

/** 别名长度上限。界面上到处显示的是它，太长会撑坏布局。 */
const MAX_ALIAS = 20
/** 模型名上限。够长了 —— 最长的也到不了 100。 */
const MAX_MODEL_ID = 100

export type ModelConfigDeps = { db: Db; vault: Vault; now?: () => number }
const now = (d: ModelConfigDeps): number => (d.now ? d.now() : Date.now())

/** 完整钥匙**永不出去**的形状。回给前端的只有 keyHint。 */
export type PublicConfig = {
  id: number
  kind: ModelKind
  provider: Provider
  baseUrl: string
  modelId: string
  alias: string
  keyHint: string
  active: boolean
}

/** 只有 `resolveSecret` 那一族能拿到它 —— 去处只有两个：造一个客户端、和「测一下」的那一次探活。 */
export type SecretConfig = {
  provider: Provider
  baseUrl: string
  apiKey: string
  modelId: string
}

type Row = {
  id: number; kind: string; provider: string; base_url: string | null
  api_key_enc: string; model_id: string; alias: string
}

/**
 * 只给头尾。太短的钥匙干脆一个字符都不露 ——
 * 露前 3 后 4 在 `sk-12345` 上等于把整把钥匙打出来了。
 *
 * 这也是 §10 那条测试钉的东西：「响应里不许含完整 key」。
 */
export function maskKey(key: string): string {
  if (key.length < 12) return '•'.repeat(Math.min(key.length, 5))
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

/**
 * 接口地址归一化 —— 替用户擦屁股。
 *
 * ★ 这条是从 Chatbox 抄的（`normalizeOpenAIApiHostAndPath`）。它不是洁癖：
 * 我们的用户是旅游打卡党，不是程序员。"https://api.deepseek.com" 少了 `/v1`、
 * 或者顺手把文档里整条 `https://api.deepseek.com/v1/chat/completions` 粘进来，
 * 都是**一定会发生**的事。让他们照着报错自己悟，比这两行代码贵得多。
 *
 * ⚠️ 但**只修"少"和"多"，不修"脏"**：带查询串 / 片段 / 内嵌凭据一律拒绝。
 * 那三样是 SSRF 的常见载体，也是"粘错东西了"的信号 —— 猜他想要什么，
 * 不如直接让他重填。
 */
export function normalizeBaseUrl(input: string): string {
  const raw = str(input).trim()
  if (!raw) throw new HttpError('BAD_REQUEST', BASE_URL_REQUIRED)

  // 没有协议就补 https://（用户很常只写域名）
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`

  let u: URL
  try {
    u = new URL(withProto)
  } catch {
    throw new HttpError('BAD_REQUEST', '接口地址看起来不是一个网址')
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new HttpError('BAD_REQUEST', '接口地址只能是 http 或 https 开头的')
  }
  if (u.username || u.password) {
    throw new HttpError('BAD_REQUEST', '接口地址里不要带用户名和密码')
  }
  if (u.search || u.hash) {
    throw new HttpError('BAD_REQUEST', '接口地址里不要带 ? 后面的东西')
  }
  // ★ 2026-10-02（安全审计 S1）：**内网地址在这里就拦掉**。
  //   放在"必须带点"那条**前面**是有意的：`127.0.0.1` 是带点的（旧检查放它过），
  //   而 `[::1]` 不带点（旧检查会说它"看起来不是一个网址"）—— 那是一句**不准的话**，
  //   用户照着那句话会去改一个本来没问题的写法。
  //   实测（加这条之前）：127.0.0.1 / 169.254.169.254 / 10.x / 192.168.x 全部放行。
  assertModelHostAllowed(`${u.protocol}//${u.host}`)
  if (!u.hostname.includes('.')) {
    throw new HttpError('BAD_REQUEST', '接口地址看起来不是一个网址')
  }

  // 路径：去掉结尾斜杠 → 剥掉误粘的完整端点 → 没有 /v1 就在末尾补一个
  let path = u.pathname.replace(/\/+$/, '')
  for (const tail of ['/chat/completions', '/images/edits', '/images/generations', '/responses']) {
    if (path.endsWith(tail)) path = path.slice(0, -tail.length)
  }
  if (!/\/v\d+$/.test(path)) path = `${path}/v1`

  return `${u.protocol}//${u.host}${path}`
}

function readKind(v: unknown): ModelKind {
  const k = str(v) as ModelKind
  if (!KINDS.includes(k)) throw new HttpError('BAD_REQUEST', 'kind 只能是 chat 或 image')
  return k
}

function readProvider(v: unknown): Provider {
  const p = str(v) as Provider
  if (!PROVIDERS.includes(p)) throw new HttpError('BAD_REQUEST', '不认识这个服务商')
  return p
}

/**
 * ★ 2026-10-05：「图片生成」没有 Anthropic 形状的服务 —— 建和改都要拦。
 *
 * 界面上那一栏干脆不给这个选项（那是第一道防线）；这句是第二道，文案给出路
 * （《文案规范》）。⚠️ **一处定义**：`create` 和 `update` 都调这一个 ——
 * 两个 if 分开写，总有一天只改了其中一边（这个仓库的老毛病清单里有它）。
 */
function assertProviderFitsKind(kind: ModelKind, provider: Provider): void {
  if (kind === 'image' && provider === 'anthropic-compatible') {
    throw new HttpError('BAD_REQUEST', '图片生成没有这种形状的服务 —— 这一栏选「兼容 OpenAI」')
  }
}

function readAlias(v: unknown): string {
  const a = str(v).trim()
  if (!a) throw new HttpError('BAD_REQUEST', ALIAS_REQUIRED)
  if (a.length > MAX_ALIAS) throw new HttpError('BAD_REQUEST', `名字最多 ${MAX_ALIAS} 个字`)
  return a
}

function readModelId(v: unknown): string {
  const m = str(v).trim()
  if (!m) throw new HttpError('BAD_REQUEST', MODEL_ID_REQUIRED)
  if (m.length > MAX_MODEL_ID) throw new HttpError('BAD_REQUEST', `模型名太长（最多 ${MAX_MODEL_ID} 个字）`)
  return m
}

/**
 * 取某一行，**并且必须是这个人的** —— 查不到和不属于你，回同一个 404。
 *
 * `need` 传 null = **不限 kind**。只有 `updateConfig` 走这条：id 是全表唯一的，
 * 库里那一行自己就说得出 kind，不用客户端每次 PATCH 都重申一遍
 * （重申一遍 = 多一个能填错、能指到别处去的字段）。
 */
function ownRow(id: number, user: PublicUser, deps: ModelConfigDeps, need: ModelKind | null):
  Row & { kind: ModelKind } {
  const cols = 'id, kind, provider, base_url, api_key_enc, model_id, alias'
  const row = (need === null
    ? deps.db.raw.prepare(`SELECT ${cols} FROM model_configs WHERE id = ? AND user_id = ?`)
      .get(id, user.id)
    : deps.db.raw.prepare(`SELECT ${cols} FROM model_configs WHERE id = ? AND user_id = ? AND kind = ?`)
      .get(id, user.id, need)) as Row | undefined
  // ⚠️ 「没这套」和「不是你的」**必须是同一个结局**：分开处理等于给了
  // 攻击者一个信号 —— 哪几个 id 是真的、只是不归你。和 §6.1 那条同源。
  if (!row) throw new HttpError('BAD_REQUEST', '没有这一套设置', 404)
  return { ...row, kind: row.kind as ModelKind }
}

function activeIdOf(kind: ModelKind, user: PublicUser, deps: ModelConfigDeps): number | null {
  const col = kind === 'chat' ? 'active_chat_config_id' : 'active_image_config_id'
  const r = deps.db.raw.prepare(`SELECT ${col} AS id FROM users WHERE id = ?`)
    .get(user.id) as { id: number | null } | undefined
  return r?.id ?? null
}

function toPublic(row: Row, activeId: number | null, vault: Vault): PublicConfig {
  // keyHint 要解一次密文才拿得到。**解不开时给一个中性的占位**，
  // 而不是把整个列表打挂 —— 列表是用户来"修"的地方，它自己不能先坏。
  const opened = vault.open(row.api_key_enc)
  return {
    id: row.id,
    kind: row.kind as ModelKind,
    provider: row.provider as Provider,
    baseUrl: row.base_url ?? '',
    modelId: row.model_id,
    alias: row.alias,
    keyHint: opened.authentic ? maskKey(opened.plaintext) : UNREADABLE_KEY_HINT,
    active: activeId === row.id,
  }
}

export function listConfigs(user: PublicUser, deps: ModelConfigDeps): { configs: PublicConfig[] } {
  const rows = deps.db.raw
    .prepare('SELECT id, kind, provider, base_url, api_key_enc, model_id, alias FROM model_configs WHERE user_id = ? ORDER BY id')
    .all(user.id) as Row[]
  const chatId = activeIdOf('chat', user, deps)
  const imageId = activeIdOf('image', user, deps)
  return { configs: rows.map(r => toPublic(r, r.kind === 'chat' ? chatId : imageId, deps.vault)) }
}

export function createConfig(body: unknown, user: PublicUser, deps: ModelConfigDeps): PublicConfig {
  const o = asObject(body)
  const kind = readKind(o.kind)
  const provider = readProvider(o.provider)
  assertProviderFitsKind(kind, provider)
  const alias = readAlias(o.alias)
  const modelId = readModelId(o.modelId)
  const baseUrl = normalizeBaseUrl(str(o.baseUrl))
  const apiKey = str(o.apiKey).trim()
  if (!apiKey) throw new HttpError('BAD_REQUEST', KEY_REQUIRED)

  const r = deps.db.raw
    .prepare(`INSERT INTO model_configs (user_id, kind, provider, base_url, api_key_enc, model_id, alias, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, kind, provider, baseUrl, deps.vault.seal(apiKey), modelId, alias, now(deps))

  const row = deps.db.raw
    .prepare('SELECT id, kind, provider, base_url, api_key_enc, model_id, alias FROM model_configs WHERE id = ?')
    .get(Number(r.lastInsertRowid)) as Row
  // 新建的**默认不激活** —— 用户可能只是想先存着，或者还想先"测一下"。
  // 自动切成在用的话，一条填错的配置会立刻把他的修图弄坏。
  return toPublic(row, activeIdOf(kind, user, deps), deps.vault)
}

export function updateConfig(id: number, body: unknown, user: PublicUser, deps: ModelConfigDeps): PublicConfig {
  const o = asObject(body)
  // ⚠️ kind **不向客户端要** —— 见 ownRow 的注释。客户端要是还是带了一个来，
  //    就拿它当查询条件：对不上 = 指错地方了，和"不是你的"给同一个 404。
  const row = ownRow(id, user, deps, o.kind === undefined ? null : readKind(o.kind))
  const kind = row.kind

  const alias = o.alias === undefined ? row.alias : readAlias(o.alias)
  const modelId = o.modelId === undefined ? row.model_id : readModelId(o.modelId)
  // ★ 2026-10-05：协议形状也能改（它和地址、钥匙是一件事的三面）。改完立刻验
  //   "这个形状配这个类别" —— 历史值 `custom` 按 OpenAI 兼容处理（`clientFor`
  //   只看 `anthropic-compatible` 那一个值），所以这里不用动它。
  const provider = o.provider === undefined ? (row.provider as Provider) : readProvider(o.provider)
  assertProviderFitsKind(kind, provider)

  // ★ 接口地址和钥匙**要么都不动，要么一起给**。
  //
  //   理由是一条真实的攻击：偷到登录票的人，把 base_url 改成自己的服务器，
  //   再触发一次生成 —— 我们服务端就会**把用户的明文钥匙发到他那台机器上**。
  //   钥匙存了密文、界面永不回显，唯一能把它弄出去的路就是这一条。
  //   要求"改地址必须重填钥匙"之后，光有票也拿不到钥匙（因为他没有钥匙）。
  //
  //   对用户零负担：换服务商的时候本来就要换一把新钥匙。
  const wantsNewUrl = o.baseUrl !== undefined
  const newKey = o.apiKey === undefined ? null : str(o.apiKey).trim()
  if (newKey !== null && newKey === '') throw new HttpError('BAD_REQUEST', '钥匙不能是空的（想清掉就删掉这一套）')
  if (wantsNewUrl && newKey === null) {
    throw new HttpError('BAD_REQUEST', NEED_KEY)
  }

  const baseUrl = wantsNewUrl ? normalizeBaseUrl(str(o.baseUrl)) : (row.base_url ?? '')
  const apiKeyEnc = newKey === null ? row.api_key_enc : deps.vault.seal(newKey)

  deps.db.raw
    .prepare('UPDATE model_configs SET provider = ?, base_url = ?, api_key_enc = ?, model_id = ?, alias = ? WHERE id = ? AND user_id = ?')
    .run(provider, baseUrl, apiKeyEnc, modelId, alias, id, user.id)

  const after = deps.db.raw
    .prepare('SELECT id, kind, provider, base_url, api_key_enc, model_id, alias FROM model_configs WHERE id = ?')
    .get(id) as Row
  return toPublic(after, activeIdOf(kind, user, deps), deps.vault)
}

/**
 * 删一套。回的 `wasActive` 是**界面必须用上**的东西：
 * 删掉的正是"在用的那一套"时，要弹那条鲜明的提示 + 一个「换成其他的」入口（§7.4）。
 *
 * ★ 回默认**不是这里写的 if**：`users` 上的指针有 `ON DELETE SET NULL`，
 *   行没了指针自己就空了。这里只是**如实回报**"刚才那次是删了在用的"。
 */
export function deleteConfig(id: number, user: PublicUser, deps: ModelConfigDeps): { wasActive: boolean } {
  const row = deps.db.raw
    .prepare('SELECT id, kind FROM model_configs WHERE id = ? AND user_id = ?')
    .get(id, user.id) as { id: number; kind: string } | undefined
  if (!row) throw new HttpError('BAD_REQUEST', '没有这一套设置', 404)

  const wasActive = activeIdOf(row.kind as ModelKind, user, deps) === id
  deps.db.raw.prepare('DELETE FROM model_configs WHERE id = ? AND user_id = ?').run(id, user.id)
  return { wasActive }
}

/** 切到哪一套。`id: null` = 切回默认（§9：「不然想回默认只能删掉配置」）。 */
export function activateConfig(body: unknown, user: PublicUser, deps: ModelConfigDeps): { ok: true } {
  const o = asObject(body)
  const kind = readKind(o.kind)
  const raw = o.id

  const col = kind === 'chat' ? 'active_chat_config_id' : 'active_image_config_id'
  if (raw === null || raw === undefined) {
    deps.db.raw.prepare(`UPDATE users SET ${col} = NULL WHERE id = ?`).run(user.id)
    return { ok: true }
  }

  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError('BAD_REQUEST', 'id 不对')
  // 指之前先确认这一套**是这个人的、而且是这个 kind 的** ——
  // 不然一次 PATCH 就能把自己的 chat 指针指到别人的图上。
  ownRow(id, user, deps, kind)
  deps.db.raw.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(id, user.id)
  return { ok: true }
}

/**
 * 取出真正要用的那把钥匙 —— **只有造客户端的那一处会调它**。
 *
 * 三种 null 是同一件事的三种成因：没配 / 没激活 / 密文读不出来。
 * 对调用方来说处置完全一样（走默认），所以不细分。
 *
 * ⚠️ 密文读不出来时**不抛**：那是"SESSION_SECRET 被换过"或者库被改过，
 * 正确答案是安静地回默认，而不是让用户的每一次修图都 500。
 */
export function resolveSecret(kind: ModelKind, user: PublicUser, deps: ModelConfigDeps): SecretConfig | null {
  const id = activeIdOf(kind, user, deps)
  if (id === null) return null
  const row = deps.db.raw
    .prepare('SELECT provider, base_url, api_key_enc, model_id FROM model_configs WHERE id = ? AND user_id = ? AND kind = ?')
    .get(id, user.id, kind) as
    { provider: string; base_url: string | null; api_key_enc: string; model_id: string } | undefined
  if (!row) return null

  const opened = deps.vault.open(row.api_key_enc)
  if (!opened.authentic) return null

  return {
    provider: row.provider as Provider,
    baseUrl: row.base_url ?? '',
    apiKey: opened.plaintext,
    modelId: row.model_id,
  }
}

/**
 * 取出**指定的**那一套的钥匙 —— 「测一下」那一路上用的。
 *
 * 和 `resolveSecret` 是同一个问题的两种问法：那个问"现在在用的是哪一套"，
 * 这个问"我点的那一套是哪一套"。差别的分量在这里：用户会去测一套**还没激活**
 * 的配置（刚存下来、或者存了还没换上去的那套）—— 那种配置 resolveSecret 看不见。
 *
 * 三种 null 和 `resolveSecret` 一个字不差（没有 / 不是我的 / 密文读不出来），
 * 处置也一样：**不抛**，由调用方回"没有这一套设置"。分开处理既是信息泄漏
 * （告诉你哪些 id 是真的），也会把"我们读不出来"说成"你填错了"。
 */
export function resolveSecretById(
  id: number, kind: ModelKind, user: PublicUser, deps: ModelConfigDeps,
): SecretConfig | null {
  const row = deps.db.raw
    .prepare('SELECT provider, base_url, api_key_enc, model_id FROM model_configs WHERE id = ? AND user_id = ? AND kind = ?')
    .get(id, user.id, kind) as
    { provider: string; base_url: string | null; api_key_enc: string; model_id: string } | undefined
  if (!row) return null

  const opened = deps.vault.open(row.api_key_enc)
  if (!opened.authentic) return null

  return {
    provider: row.provider as Provider,
    baseUrl: row.base_url ?? '',
    apiKey: opened.plaintext,
    modelId: row.model_id,
  }
}
