/**
 * **兼容 Anthropic 协议的上游客户端**（2026-10-05，§7.4 的「提供商」下拉）。
 *
 * 存在的理由就一条：Claude 官方那套接口和 OpenAI 那套**请求形状不一样** ——
 * 用户想接这一种，之前接不了。形状差在哪儿（这就是全部）：
 *   · URL：`{baseUrl}/messages` —— `normalizeBaseUrl` 保证库里存的 baseUrl
 *     **总以 `/v1` 结尾**，所以拼出来就是 `/v1/messages`（用户填带不带 `/v1`
 *     都不怕：归一化在入库前就做完了）；
 *   · 请求头：`x-api-key`（不是 `Authorization: Bearer`）+ `anthropic-version`
 *     （少了它官方端点直接 400）；
 *   · `system` 是**顶层字段**，不在 messages 里；
 *   · 图片是 `{type:'image', source:{type:'base64', media_type, data}}` 块；
 *   · **相邻的 user 消息必须合并** —— roles must alternate，连着两条 user
 *     会被官方端点 400；
 *   · **没有 `response_format: json_object`** —— 靠 prompt 自己约束 +
 *     调用方既有的"模型吐垃圾"降级路径（`route.ts` / `suggest.ts` 都有）。
 *
 * ⚠️ 出站那一堆安全性质（不跟重定向、体积上限、超时/取消、错误分类、抹钥匙）
 *    和 OpenAI 形状**一个字都不差** —— 全在 `sn.ts` 的 `requestJson` 里共用。
 *    这里**不许**再写一份 fetch：形状转换是本文件唯一的活。
 */
import { OUTBOUND_LIMITS } from './http.ts'
import type { Size } from '../shared/size.ts'
import {
  CHAT_TIMEOUT_MS, MIN_CHAT_TOKENS, SnError, requestJson,
  type ChatContentPart, type ChatMessage, type ModelClient, type ModelConnection,
} from './sn.ts'

/** Anthropic 的版本头。各家"兼容 Anthropic"的实现也按这个收。
 *  ⚠️ 导出是因为「测一下」的探活也要它（`modeltest.ts`）——那份请求头
 *  和这里必须**同一个值**：一处改了另一处漏，症状是探活全 400。 */
export const ANTHROPIC_VERSION = '2023-06-01'

/** data URL 拆成 media_type + 纯 base64 —— 我们内部构造的图片永远是这种形状。 */
function splitDataUrl(u: string): { mediaType: string; data: string } {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(u)
  if (!m) {
    throw new SnError('BAD_REQUEST', '这张图不是 base64 data URL —— 这个协议形状只收这种', false)
  }
  return { mediaType: m[1]!, data: m[2]! }
}

/** 一块（我们内部的通用形状）→ Anthropic 的内容块。 */
function toBlock(p: ChatContentPart): unknown {
  if (p.type === 'text') return { type: 'text', text: p.text }
  const { mediaType, data } = splitDataUrl(p.image_url.url)
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
}

export class AnthropicClient implements ModelClient {
  private readonly cfg: ModelConnection
  private readonly fetchImpl: typeof fetch
  // 和 SenseNovaClient 同一个理由避开构造函数参数属性（见 http.ts 的说明）
  constructor(cfg: ModelConnection, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg
    this.fetchImpl = fetchImpl
  }

  // 两个访问器和 SenseNovaClient 一字不差 —— 调用方（和测试）取值不用先知道形状。
  get baseUrl(): string { return this.cfg.baseUrl }
  get apiKey(): string { return this.cfg.apiKey }
  get vlmModel(): string { return this.cfg.modelId }
  get imageModel(): string { return this.cfg.modelId }

  async chatJson(messages: ChatMessage[], maxTokens = MIN_CHAT_TOKENS): Promise<string> {
    // 转换：system 提升到顶层；其余按顺序排，**相邻的合并进同一条**。
    const systems: string[] = []
    const out: { role: 'user'; content: unknown[] }[] = []
    for (const m of messages) {
      if (m.role === 'system') {
        // system 一般是 string；真给了块数组就把 text 块拼起来（语义等价）
        systems.push(typeof m.content === 'string'
          ? m.content
          : m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))
        continue
      }
      const blocks = typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content.map(toBlock)
      const last = out[out.length - 1]
      if (last) last.content.push(...blocks)
      else out.push({ role: 'user', content: blocks })
    }

    const body: Record<string, unknown> = {
      model: this.cfg.modelId,
      // max_tokens 在这里是**必填**（OpenAI 那边可省，这里不行）
      max_tokens: Math.max(MIN_CHAT_TOKENS, maxTokens),
      messages: out,
    }
    if (systems.length > 0) body.system = systems.join('\n\n')

    const j = await requestJson({
      fetchImpl: this.fetchImpl,
      url: `${this.cfg.baseUrl}/messages`,
      headers: {
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body, timeoutMs: CHAT_TIMEOUT_MS, maxBytes: OUTBOUND_LIMITS.chat,
      secret: this.cfg.apiKey,
    })

    // 响应：content 是块数组，把 text 块拼起来（别的类型 —— 比如 thinking —— 跳过）。
    const content = (j as { content?: unknown })?.content
    const text = Array.isArray(content)
      ? content
        .filter((b): b is { type: string; text: string } =>
          typeof b === 'object' && b !== null &&
          (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
        .map((b) => b.text)
        .join('')
      : ''
    if (text.trim() === '') {
      // 和 SenseNova 那条同一个分类（token 被 reasoning 吃光 / 上游抽风，再打一次通常就有）
      throw new SnError('UPSTREAM_FAILED',
        `上游返回空正文（stop_reason=${(j as { stop_reason?: unknown })?.stop_reason ?? '?'}）`, true)
    }
    return text
  }

  async edit(_o: { imageDataUrl: string; prompt: string; size: Size },
             _signal?: AbortSignal): Promise<string> {
    // 正常路径到不了这里：`models.ts` 在建和改的时候就拒了"图片生成 × Anthropic"
    // 这个组合（一处在服务端拦，前端也不给这个选项）。真到了（历史数据），
    // 也宁可抛一句清楚的，不去猜对面能干什么。
    throw new SnError('BAD_REQUEST',
      'Anthropic 形状的服务没有图片生成 —— 这一栏要选「兼容 OpenAI」的', false)
  }
}
