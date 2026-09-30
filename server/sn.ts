import type { Config } from './config.ts'
import type { AppErrorCode } from '../shared/protocol.ts'
import type { Size } from '../shared/size.ts'

// 同样避开构造函数参数属性（见 http.ts 里的说明）：
// Node 24 默认剥离模式不支持，vitest 的 esbuild 却支持——那种差异
// 会让测试绿着、服务跑不起来。
export class SnError extends Error {
  readonly code: AppErrorCode
  readonly retryable: boolean
  constructor(code: AppErrorCode, message: string, retryable: boolean) {
    super(message)
    this.name = 'SnError'
    this.code = code
    this.retryable = retryable
  }
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ChatMessage = { role: 'system' | 'user'; content: string | ChatContentPart[] }

/**
 * chat 的 max_tokens 下限。
 *
 * 实测：glm-5.2 / deepseek-v4-flash 会把 800 个 token **全花在 reasoning 上**，
 * 正文被截断成空，而且这时 message.content 是 null（不是空串）。
 * 1200 是实测能稳定出正文的下限。
 */
const MIN_CHAT_TOKENS = 1200

/** 单次请求超时。实测 token.sensenova.cn 不稳定，生成要 9~11 秒，给足余量。 */
const CHAT_TIMEOUT_MS = 60_000
const EDIT_TIMEOUT_MS = 180_000

export class SenseNovaClient {
  private readonly cfg: Config
  private readonly fetchImpl: typeof fetch
  // 不用构造函数参数属性——Node 24 剥离模式不支持（见 http.ts 的说明）
  constructor(cfg: Config, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg
    this.fetchImpl = fetchImpl
  }

  async chatJson(messages: ChatMessage[], maxTokens = MIN_CHAT_TOKENS): Promise<string> {
    const body = {
      model: this.cfg.vlmModel,
      messages,
      max_tokens: Math.max(MIN_CHAT_TOKENS, maxTokens),
      response_format: { type: 'json_object' },
      // 故意不传 temperature：kimi-k3 只接受 temperature=1，传 0 会被 400 拒
      // （"field Temperature invalid, only 1 is allowed for this model"）。
      // 各家默认值不同，让服务端自己定——路由不靠 temperature 保持稳定。
    }
    const j = await this.postJson('/chat/completions', body, CHAT_TIMEOUT_MS)

    const choice = (j as any)?.choices?.[0]
    if (!choice) {
      throw new SnError('UPSTREAM_FAILED', '上游没有返回 choices', true)
    }
    const content = choice?.message?.content
    if (typeof content !== 'string' || content.trim() === '') {
      // 典型成因：token 预算被 reasoning 吃光（finish_reason=length）。
      // 归为可重试——再打一次通常就出来了。
      throw new SnError('UPSTREAM_FAILED',
        `上游返回空正文（finish_reason=${choice?.finish_reason ?? '?'}）`, true)
    }
    return content
  }

  /**
   * 生成式编辑。返回**纯 base64**（不带 `data:image/...;base64,` 前缀），
   * 由调用方决定怎么包。
   *
   * `signal` = **用户那边按了「停止」**（浏览器掐断连接 → app.ts 跟着 abort）。
   * 全项目只有这一条路带 signal：它是唯一一条让用户干等十几秒的路。
   */
  async edit(o: { imageDataUrl: string; prompt: string; size: Size },
             signal?: AbortSignal): Promise<string> {
    const body = {
      model: this.cfg.imageModel,
      images: [{ image_url: o.imageDataUrl }],
      prompt: o.prompt,
      n: 1,
      // 必须显式传 WxH。实测 size="auto" 会让模型**重画构图**
      // （地平线从 78% 漂到 65%）；锁死后连跑三次构图分毫不差。
      size: `${o.size.width}x${o.size.height}`,
      watermark: false,
      prompt_extend: true,
      // 必须 b64_json。用 url 时图片放在 aoss.cn-sh-01.sensecoreapi-oss.cn，
      // 那个域名经常连接超时——生成成功了却拿不到图。
      response_format: 'b64_json',
    }
    const j = await this.postJson('/images/edits', body, EDIT_TIMEOUT_MS, signal)

    const b64 = (j as any)?.data?.[0]?.b64_json
    if (typeof b64 !== 'string' || !b64) {
      // 不静默退回 url：那条路正是我们花了力气绕开的坑，
      // 悄悄退回去只会让"结果拿不到"变成偶发的、难以复现的故障。
      throw new SnError('UPSTREAM_FAILED', '上游没有返回 b64_json 图片数据', true)
    }
    return b64
  }

  private async postJson(path: string, body: unknown, timeoutMs: number,
                         outer?: AbortSignal): Promise<unknown> {
    const url = `${this.cfg.baseUrl}${path}`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        // 两个中断源合成一个：**超时**（一直就有）和**用户按了停止**（2026-09-30 加）。
        // AbortSignal.any 要 Node 20.3+，这个项目钉的是 Node 24。
        signal: outer
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), outer])
          : AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      // ★ 用户按了停止 —— **绝不能标成可重试**。
      //   标成可重试的话，那个已经不想要的请求会再打一遍上游：钱再花一次、
      //   串行队列再被占十几秒，正好和"停止"想要的反着来。
      //   （超时也走 AbortError，但它**该**重试 —— 靠 outer.aborted 区分。）
      if (outer?.aborted) {
        throw new SnError('UPSTREAM_FAILED', '用户取消了这次生成', false)
      }
      // 网络层异常（DNS 失败 / 超时 / 连接重置）统一归为可重试
      throw new SnError('UPSTREAM_FAILED', `连不上上游：${(e as Error).message}`, true)
    }

    // ⚠️ 正文读取必须**同等**对待，不能放在 try 之外。
    // fetch 在**响应头**到达时就 resolve 了，正文是随后独立的一次网络往返：
    // 连接下载到一半被重置、或 AbortSignal.timeout 掐在几 MB 的 edit 正文
    // 传输途中（EDIT_TIMEOUT_MS 覆盖的是整个传输过程），都在这一句上炸。
    // 裸异常逃出去，调用方按 `SnError && retryable` 重试的网关会把它当成
    // 永久失败——一次抖动变成用户可见的硬错误。
    // 范围**只包住这一句**：下面 res.ok 与 JSON 解析抛的 SnError 分类已经正确，
    // 套进来只会把它们重新包装一遍。
    let text: string
    try {
      text = await res.text()
    } catch (e) {
      // 同上：停止可能发生在**读正文**这一段（生成那一路正文是几百 KB 的 base64）。
      if (outer?.aborted) {
        throw new SnError('UPSTREAM_FAILED', '用户取消了这次生成', false)
      }
      throw new SnError('UPSTREAM_FAILED', `读取上游响应正文失败：${(e as Error).message}`, true)
    }
    if (!res.ok) {
      throw new SnError(codeForStatus(res.status),
        `上游 HTTP ${res.status}：${text.slice(0, 300)}`, res.status === 429 || res.status >= 500)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new SnError('UPSTREAM_FAILED', `上游返回的不是 JSON：${text.slice(0, 200)}`, true)
    }
  }
}

function codeForStatus(status: number): AppErrorCode {
  if (status === 429) return 'UPSTREAM_LIMIT'
  if (status >= 500) return 'UPSTREAM_FAILED'
  // 其余 4xx：上游**拒了**这次请求（提示词/图片不合规、鉴权被拒……）。
  // 这类错误重试永远不会成功，所以绝不能报成可重试的 UPSTREAM_FAILED——
  // 那会给用户一句"AI 服务暂时没响应，再试一次"的假话（而且每一次都白等一个来回）。
  return 'BAD_REQUEST'
}
