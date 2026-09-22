import type {
  EditRequest, EditResponse, RouteDecision, RouteRequest, RouteResponse,
  SuggestRequest, SuggestResponse, AppErrorCode,
} from '../../shared/protocol'

export class ApiError extends Error {
  readonly code: AppErrorCode
  // 前端这份跑在 Vite/esbuild 上，参数属性本来也能用，
  // 但全项目统一不用——免得哪天被复制到后端踩 Node 剥离模式的坑。
  constructor(code: AppErrorCode, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/**
 * 统一的请求出口。
 *
 * 只做三件事：打过去、把非 2xx 翻成 ApiError、把"响应根本不是 JSON"
 * 也翻成 ApiError。**绝不让 JSON.parse 的 SyntaxError 冒到调用方**——
 * 那条错误对用户毫无意义，而我们有一个现成的、能显示给人看的错误类型。
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ApiError('UPSTREAM_FAILED', '连不上服务器，检查一下网络？')
  }

  // fetch() 在**响应头到达时**就 resolve，正文是这时候才读的——它是独立的一次
  // 网络往返。读正文失败（连接中途被重置、代理掐断）抛的是裸 TypeError，不是
  // ApiError，于是调用方只能给出通用的"出了点问题"。包起来，让它和上面的连不上
  // 走同一条路。
  //
  // 前端这边的后果比后端轻（ApiError 没有 retryable 概念，不存在"静默丢重试"），
  // 但两端形状保持一致，将来谁把这段抄去别处都不会踩。
  let text: string
  try {
    text = await res.text()
  } catch {
    throw new ApiError('UPSTREAM_FAILED', '连不上服务器，检查一下网络？')
  }

  let parsed: any
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError('UPSTREAM_FAILED', '服务器返回了看不懂的东西，再试一次？')
  }

  if (!res.ok) {
    const code: AppErrorCode = parsed?.error?.code ?? 'INTERNAL'
    const message = typeof parsed?.error?.message === 'string'
      ? parsed.error.message
      : '出了点问题，再试一次？'
    throw new ApiError(code, message)
  }
  return parsed as T
}

export async function postRoute(o: RouteRequest): Promise<RouteDecision> {
  const r = await post<RouteResponse>('/api/route', o)
  return r.decision
}

export async function postSuggest(o: SuggestRequest): Promise<SuggestResponse> {
  return post<SuggestResponse>('/api/suggest', o)
}

export async function postEdit(o: EditRequest): Promise<EditResponse> {
  return post<EditResponse>('/api/edit', o)
}
