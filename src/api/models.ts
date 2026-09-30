import { del, get, patch, post } from './client'

/**
 * 模型设置的接口（§7）。**这一份里没有一条路能把明文钥匙拿回来** ——
 * 服务端回的只有 `keyHint`（`sk-…4f2`），界面永不回显（§7.7）。
 */

/** 两个类别，各自独立（§7.4）：`chat` 管看照片、听懂话；`image` 管真的把照片改掉。 */
export type ModelKind = 'chat' | 'image'

/**
 * 服务端回的**公共**形状（`server/models.ts` 的 `PublicConfig`）。
 *
 * ⚠️ 里面**没有 `apiKey`**，而且不该有 —— 这一个是"给界面看的那一面"，
 *    完整钥匙只活在服务端的内存里（造客户端、和"测一下"那两次）。
 */
export type PublicConfig = {
  id: number
  kind: ModelKind
  provider: string
  baseUrl: string
  modelId: string
  alias: string
  keyHint: string
  active: boolean
}

/** 「测一下」的四种失败（服务端 `modeltest.ts` 的 `ProbeFail`，一字不差）。 */
export type ProbeFail = 'unauthorized' | 'unreachable' | 'no_endpoint' | 'bad_response'

/**
 * 「测一下」的结果。
 *
 * ⚠️ **探不通也是 200** —— 那是"这次探活的结果"，不是"这次请求失败了"。
 *    `message` 是**给用户看的那句话**（上游原文被服务端挡在外面），原样显示。
 */
export type ProbeResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: ProbeFail; message: string }

/**
 * 密文读不出来时服务端给的占位（`server/models.ts` 的 `toPublic`，一字不差）。
 *
 * ⚠️ **这个字符串在服务端也写了一遍，两边必须一样** —— 界面靠它认出
 *    "这把钥匙已经读不出来了，得重填"，认不出来时那一行就不会显眼。
 *    它有意的写死（而不是从服务端 import —— `server/` 不 import `src/`）：
 *    它属于**协议面**，和 `ProbeFail` 那四个词是同一种东西。
 */
export const UNREADABLE_KEY_HINT = '（读不出来，请重填）'

/** 列全部。两栏（对话 / 图片）都从这一条来 —— 别按 kind 分两次请求。 */
export const listModels = () => get<{ configs: PublicConfig[] }>('/api/models')

/**
 * 新建一套。服务端要的字段：`kind` / `provider` / `alias` / `modelId` /
 * `baseUrl` / `apiKey`（缺哪个都回一句中文的 400）。
 *
 * ⚠️ 接口地址**由服务端归一化**（`normalizeBaseUrl`：补协议、补 `/v1`、
 *    剥掉误粘的整条端点、带查询串/内嵌凭据的一律拒绝）。界面上那个
 *    「填域名也行，我们会补上 /v1」说的就是这件事 —— **前端别自己再补一遍**，
 *    两处各修各的，规则迟早走岔。
 */
export const createModel = (b: unknown) => post<PublicConfig>('/api/models', b)

/**
 * 改一套。`id` 是全表唯一的，**`kind` 不用带** —— 服务端从那一行自己读
 * （带上了也不会报错：它只当查询条件用，对不上就是同一个 404）。
 *
 * ⚠️ ★ **改了 `baseUrl` 就必须在同一个请求里带上 `apiKey`**，否则 400
 *    （服务端的原话：「换了接口地址就要把钥匙重填一遍」）。这是**故意**的安全
 *    性质：偷到会话的人想把存着的钥匙引到自己的服务器上去，就得先有那把钥匙。
 *    所以调用方**别去碰没动过的 `baseUrl`** —— 带了就等于要求用户重填钥匙，
 *    哪怕那个值和库里一模一样。
 */
export const updateModel = (id: number, b: unknown) => patch<PublicConfig>(`/api/models/${id}`, b)

/**
 * 删一套。回的 `wasActive` 是**界面必须用上**的东西：删掉的正是"在用的那一套"
 * 时要弹那条鲜明的提示 + 一个换一套的入口（§7.4）。
 */
export const deleteModel = (id: number) => del<{ wasActive: boolean }>(`/api/models/${id}`)

/** 切到哪一套。`id: null` = 切回默认（§9：「不然想回默认只能删掉配置」）。 */
export const activateModel = (kind: ModelKind, id: number | null) =>
  post<{ ok: true }>('/api/models/activate', { kind, id })

/**
 * 「测一下」打的那两个目标。
 *
 * · **表单里现在这份**（`baseUrl` + `apiKey`）—— 用户点这个按钮的时候，十有八九
 *   还没保存，所以默认走这条：测的就是他眼睛看到的那一份。
 *   （LobeChat 是反过来：点检查先偷偷把表单存一次。我们不这么干 ——
 *    那会写进去一套他可能还不想要的配置。）
 * · **库里存着的那一套**（`kind` + `id`，服务端自己解出钥匙）—— 编辑一套已经
 *   存好的、地址又没动过时走这条：那会儿表单里没有明文钥匙（永不回显），
 *   而"表单里的地址"和"库里的地址"是同一个，测得的是同一件事。
 *   ⚠️ 地址被改过而没重填钥匙时**不许**走这条：那会测成库里那份，
 *      而用户眼睛盯着的是表单里那份 —— 测出来的"通了"是一句假话。
 */
export type ProbeTarget =
  | { baseUrl: string; apiKey: string }
  | { kind: ModelKind; id: number }

/** 免费的那一下：打 `GET {baseUrl}/models`，只验地址通不通、钥匙认不认。 */
export const testModel = (b: ProbeTarget) => post<ProbeResult>('/api/models/test', b)
