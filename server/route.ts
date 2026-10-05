import { ZERO, clampAdjustments, type Adjustments } from '../shared/adjustments.ts'
import type { RouteRequest, RouteResponse } from '../shared/protocol.ts'
import { HttpError, CHECK_YOUR_KEY_TIP } from './http.ts'
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
          { type: 'text', text: buildRouterUser(req.text, req.params) },
        ],
      },
    ]), 'route')
    const decision = parseDecision(content, req.text)
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

function parseRequest(raw: unknown): RouteRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new HttpError('BAD_REQUEST', '请求体必须是 JSON 对象', 400)
  }
  const o = raw as Record<string, unknown>

  const imageDataUrl = o.imageDataUrl
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    // 只收 data URL。允许任意 URL 等于让前端把服务器当代理去打任意地址。
    throw new HttpError('BAD_REQUEST', 'imageDataUrl 必须是 data:image/... 开头的 data URL', 400)
  }

  const textRaw = typeof o.text === 'string' ? o.text.trim() : ''
  if (!textRaw) throw new HttpError('BAD_REQUEST', 'text 不能为空', 400)
  const text = textRaw.slice(0, MAX_USER_TEXT)

  const params = normalizeParams(o.params)

  return { imageDataUrl, text, params }
}

function normalizeParams(v: unknown): Adjustments {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ZERO
  return clampAdjustments({ ...ZERO, ...(v as Partial<Adjustments>) })
}
