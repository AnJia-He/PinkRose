import type { Route, SuggestCard, SuggestRequest, SuggestResponse } from '../shared/protocol.ts'
import { HttpError } from './http.ts'
import { CARD_LABEL_MAX, SUGGEST_SYSTEM } from './prompt.ts'
import type { SerialQueue } from './queue.ts'
import { redactSecrets, type SenseNovaClient } from './sn.ts'
import { ROUTES, coerceToObject, inferRoute, normalizeDeltas } from './validate.ts'

export type SuggestDeps = { client: SenseNovaClient; queue: SerialQueue }

/** 最多几张卡片。spec §2.3 说的是 3 张。 */
export const MAX_CARDS = 3

export async function handleSuggest(raw: unknown, deps: SuggestDeps): Promise<SuggestResponse> {
  const req = parseRequest(raw)
  try {
    const content = await deps.queue.run(() => deps.client.chatJson([
      { role: 'system', content: SUGGEST_SYSTEM },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: req.imageDataUrl } }] },
    ]), 'suggest')
    const { cards, parsed } = parseCards(content)
    return { cards, degraded: !parsed }
  } catch (e) {
    // 卡片只是锦上添花。它挂了不能让用户连照片都上传不了——
    // 所以这里返回空数组 + degraded，前端照常进对话，只是没有卡片。
    // ⚠️ 消息过一遍 `redactSecrets`：这条路的错误来自**用户自己那把对话钥匙**
    // 那一侧的上游，401 正文里可能带着回显的凭据，而它是要进日志的（见 sn.ts 那段）。
    console.warn('[suggest] 卡片生成失败：', redactSecrets((e as Error).message))
    return { cards: [], degraded: true }
  }
}

function parseCards(content: string): { cards: SuggestCard[]; parsed: boolean } {
  const obj = coerceToObject(content)
  const list = obj?.cards
  // parsed 表达的是"模型有没有按我们要的形状答"，
  // 而不是"有没有卡片"——这两件事不一样，degraded 要的是前者。
  // 模型合法地回 {"cards":[]}（它认为这张照片没什么可改）是**有效回答**，
  // 让它亮成 degraded 等于在真正需要这个信号的时候给你一个假警报。
  if (!Array.isArray(list)) return { cards: [], parsed: false }

  const out: SuggestCard[] = []
  for (const item of list) {
    if (out.length >= MAX_CARDS) break
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>

    const label = typeof o.label === 'string' ? o.label.trim() : ''
    // 空的和明显抽风的（超过 CARD_LABEL_MAX）都丢掉。
    // 12 字是 prompt 里的软要求，代码只防"模型输出了一整段"。
    if (!label || label.length > CARD_LABEL_MAX) continue

    const paramDeltas = normalizeDeltas(o.param_deltas ?? o.paramDeltas)
    const editPrompt = typeof o.edit_prompt === 'string' ? o.edit_prompt.trim()
      : typeof o.editPrompt === 'string' ? o.editPrompt.trim() : ''
    const hasParams = Object.values(paramDeltas).some(v => v !== 0)
    const hasEdit = editPrompt.length > 0

    // 点了什么都不会发生的卡片不如不给
    if (!hasParams && !hasEdit) continue

    const rawRoute = o.route
    // 走和路由那边同一套枚举校验 —— 卡片也会吐 "ask" 这种枚举外的值
    const route: Route = typeof rawRoute === 'string' && (ROUTES as readonly string[]).includes(rawRoute)
      ? rawRoute as Route
      : inferRoute(hasParams, hasEdit)

    out.push({ label, route, paramDeltas, editPrompt })
  }
  return { cards: out, parsed: true }
}

function parseRequest(raw: unknown): SuggestRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new HttpError('BAD_REQUEST', '请求体必须是 JSON 对象', 400)
  }
  const imageDataUrl = (raw as Record<string, unknown>).imageDataUrl
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    throw new HttpError('BAD_REQUEST', 'imageDataUrl 必须是 data:image/... 开头的 data URL', 400)
  }
  return { imageDataUrl }
}
