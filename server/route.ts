import { ZERO, clampAdjustments, type Adjustments } from '../shared/adjustments.ts'
import type { RouteRequest, RouteResponse } from '../shared/protocol.ts'
import { HttpError } from './http.ts'
import { ROUTER_SYSTEM, buildRouterUser } from './prompt.ts'
import type { SerialQueue } from './queue.ts'
import type { SenseNovaClient } from './sn.ts'
import { fallbackDecision, parseDecision } from './validate.ts'

export type RouteDeps = { client: SenseNovaClient; queue: SerialQueue }

/** 用户输入的字符上限。超过就截断——prompt 长度也是钱。 */
export const MAX_USER_TEXT = 500

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
    console.warn('[route] 路由失败，走降级路径：', (e as Error).message)
    return { decision: fallbackDecision(req.text) }
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
