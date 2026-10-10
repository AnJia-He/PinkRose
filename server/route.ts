import { ZERO, clampAdjustments, type Adjustments } from '../shared/adjustments.ts'
import { MAX_LUTS, MAX_LUT_NAME, normalizeLutRef, type LutRef } from '../shared/lut.ts'
import { MAX_PRESETS, MAX_PRESET_NAME } from '../shared/preset.ts'
import type { RouteRequest, RouteResponse } from '../shared/protocol.ts'
import { HttpError, asImageBody, CHECK_YOUR_KEY_TIP } from './http.ts'
import { ROUTER_SYSTEM, buildRouterUser } from './prompt.ts'
import type { SerialQueue } from './queue.ts'
import { SnError, redactSecrets, type ModelClient } from './sn.ts'
import { fallbackDecision, parseDecision } from './validate.ts'

// client 用**接口**类型（★ 2026-10-05）：对话这一路两种协议形状都合法（§7.4），
// 具体拿哪一类在 clientFor.ts 一处决定。原来这里钉着 SenseNovaClient ——
// 加了 Anthropic 形状之后 app.ts 传 ModelClient 进来就通不过类型检查了。
export type RouteDeps = { client: ModelClient; queue: SerialQueue }

/** 用户输入的字符上限。超过就截断——prompt 长度也是钱。 */
export const MAX_USER_TEXT = 500

/**
 * ★ 对话的钥匙被上游拒（401/403）时，降级回复换这一句真话。
 *
 * 为什么需要它：catch 把所有 SnError 都吞进 §4.7 的降级（那条规矩是对的 ——
 * 路由失败不能停在报错上）。但**钥匙不对**是这里唯一一种"用户自己能修、
 * 而且不修就一直花钱"的失败：用户说一句话 → 路由静默失败 →
 * 原文直接走一次**付费生成** → 他不知道钥匙是坏的，**每说一句白花一次**。
 *
 * ⚠️ **只给 UPSTREAM_AUTH 用**（下面的 if 就是范围）。超时 / 限流 / 格式烂
 * 仍然用 `fallbackDecision` 原来那句 —— 那些失败里上游根本没机会说
 * 「你这把钥匙不对」，而 §4.7 要求它们对用户保持"什么都没发生"的样子。
 *
 * ⚠️ 和 `http.ts` 的 `USER_MESSAGE.UPSTREAM_AUTH` 是**同一套措辞**，而且
 * **同样不区分归属**（不知道这把钥匙是用户自己填的还是我们自己的）：
 * 填过的人去右上角头像里的「模型」那一页查，没填过的人知道那是我们这边的问题。
 * 开头那句说的是"接下来会发生什么"（这里**还是照他说的改完了**，那边是"这次没做成"），
 * 所以两条各写；**"去哪查钥匙"那半句两边共用 `CHECK_YOUR_KEY_TIP`** —— 同一个毛病
 * 在屏幕上两种说法、或者指向两个不一样的地方，用户会以为是两件事。
 */
const AUTH_REPLY = '模型服务商不认这把钥匙，这次先直接按你说的改了。' + CHECK_YOUR_KEY_TIP + '。'

export async function handleRoute(raw: unknown, deps: RouteDeps): Promise<RouteResponse> {
  const req = parseRequest(raw)
  try {
    const content = await deps.queue.run(() => deps.client.chatJson([
      { role: 'system', content: ROUTER_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: req.imageDataUrl } },
          { type: 'text', text: buildRouterUser(req.text, req.params, req.luts, req.lut, req.presets) },
        ],
      },
    ]), 'route')
    // ★ 2026-10-05（滤镜）：名字清单也交给 `parseDecision` —— 模型写了清单**外**
    //   的名字时，它要能判出来（归 null + degraded），别把库里没有的东西放进决策。
    // ★ 2026-10-10（预设）：用户自己的预设名单同理（同一个理由，一字不差）。
    const decision = parseDecision(content, req.text, req.luts.map((l) => l.name), req.presets.map((p) => p.name))
    // `degraded` 的意思见 validate.ts 里那段注释：**这次的结果不是模型老实给的**。
    // 它必须打出来。2026-09-29 查"同一件事做两遍"那个 bug 时，`/api/route` 的响应里
    // 明明每条都带 degraded:true，但服务端一个字都不留、前端也不消费 ——
    // 于是这个信号等于不存在，那个 bug 一直没人发现。
    //
    // 连着**原始输出**一起打：只写"降级了"查不出模型到底吐了什么。
    // 有原文，"声明了 params 却又写一遍 edit_prompt"这个形状一眼就看得出来。
    if (decision.degraded) {
      console.warn('[route] degraded=true（模型没老实给） route=' +
        decision.route + ' 原始输出=' + content.slice(0, 700))
    }
    return { decision }
  } catch (e) {
    // spec §4.7：路由失败不能让用户看见报错，降级成"原文当 prompt 走生成"。
    // 重试已经由队列做过了，走到这儿就是真的不行了。
    // ⚠️ 消息过一遍 `redactSecrets`：这一条路的错误可能是**用户自己那把钥匙**
    // 被上游拒（401 正文里常带有回显的凭据），而它是要进日志的（见 sn.ts 那段）。
    console.warn('[route] 路由失败，走降级路径：', redactSecrets((e as Error).message))
    const decision = fallbackDecision(req.text)
    // ★ 唯一的例外，也是**范围的全部**：钥匙被上游拒时，回复说出真话。
    //   理由和边界都写在上面 AUTH_REPLY 那段里。
    //   判据是 `code === 'UPSTREAM_AUTH'`（不是 status、也不是 message）——
    //   错误码是 sn.ts 那张表给的，措辞换了它也不变。
    if (e instanceof SnError && e.code === 'UPSTREAM_AUTH') {
      decision.reply = AUTH_REPLY
    }
    return { decision }
  }
}

/**
 * `parseRequest` 的出口。比 `RouteRequest` 里那几个可选字段更紧：**到了这里
 * 就一定有值**（缺的/坏的都归一化成空清单和 null）—— 下游不必到处判 undefined。
 * （协议里的 `luts?`/`lut?`/`presets?` 是留给**发送方**的自由，两道不再是一个东西。）
 */
type ParsedRouteRequest = RouteRequest & {
  luts: { id: number; name: string }[]
  lut: LutRef | null
  presets: { name: string; params: Adjustments }[]
}

function parseRequest(raw: unknown): ParsedRouteRequest {
  // 请求体得是对象、`imageDataUrl` 得是 data URL —— 两条都在 `http.ts` 的
  // `asImageBody` 里（三个 AI 入口共用；"只收 data URL"那条 SSRF 理由也在那儿）。
  const { o, imageDataUrl } = asImageBody(raw)

  const textRaw = typeof o.text === 'string' ? o.text.trim() : ''
  if (!textRaw) throw new HttpError('BAD_REQUEST', 'text 不能为空', 400)
  const text = textRaw.slice(0, MAX_USER_TEXT)

  const params = normalizeParams(o.params)

  return {
    imageDataUrl, text, params,
    // ★ 2026-10-05（滤镜）：清单只给名字（模型靠它认名字），当前那个只当上下文。
    luts: normalizeLutList(o.luts),
    lut: normalizeLutRef(o.lut),
    // ★ 2026-10-10（预设）：这个给**名字 + 参数**（spec §8.1 —— 模型靠名字认它们，
    //   参数当上下文）。
    presets: normalizePresetList(o.presets),
  }
}

function normalizeParams(v: unknown): Adjustments {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ZERO
  return clampAdjustments({ ...ZERO, ...(v as Partial<Adjustments>) })
}

/**
 * 客户端送来的滤镜清单 → 给模型看的那一份（★ 2026-10-05）。
 *
 * 和别处的入口参数一样，**不信前端**：最多 `MAX_LUTS` 条、名字 trim 后截到
 * `MAX_LUT_NAME` 字、空名字和坏 id（不是正整数）直接丢。这些都是"静默失效点"——
 * 空名字会让提示词里多一个空档、超长名单白烧 token，而两件都不会报错。
 */
function normalizeLutList(v: unknown): { id: number; name: string }[] {
  if (!Array.isArray(v)) return []
  const out: { id: number; name: string }[] = []
  for (const item of v) {
    if (out.length >= MAX_LUTS) break
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const id = Number(o.id)
    if (!Number.isInteger(id) || id <= 0) continue
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, MAX_LUT_NAME) : ''
    if (!name) continue
    out.push({ id, name })
  }
  return out
}

/**
 * 客户端送来的预设清单 → 给模型看的那一份（★ 2026-10-10）。
 *
 * 照 `normalizeLutList` 同一套规矩，**不信前端**：最多 `MAX_PRESETS` 条
 * （多余的是**静默截断**，设计 §6.1 —— 请求可以伪造，不报错）、名字 trim 后截到
 * `MAX_PRESET_NAME` 字、空名字丢掉、`params` 过 `normalizeParams`（= `clampAdjustments`，
 * 客户端来的数字必须钳）。都是"静默失效点"：空名字会让提示词里多一个空档、
 * 超长名单白烧 token，而两件都不会报错。
 *
 * ⚠️ 这里对超长名是 **trim + 截断**；存储侧（`server/presets.ts` 的 `createPreset`）
 *   对超长名是**直接拒**（`presetNameOk`）。两个方向**故意不同**，别"统一"：
 *   那边是我们自己的写入闸（截了就等于替用户改了他起的名字），这边是请求侧防御
 *   （请求可以伪造，截断合理）。
 */
function normalizePresetList(v: unknown): { name: string; params: Adjustments }[] {
  if (!Array.isArray(v)) return []
  const out: { name: string; params: Adjustments }[] = []
  for (const item of v) {
    if (out.length >= MAX_PRESETS) break
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, MAX_PRESET_NAME) : ''
    if (!name) continue
    out.push({ name, params: normalizeParams(o.params) })
  }
  return out
}
