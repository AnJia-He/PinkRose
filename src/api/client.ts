import type {
  EditRequest, EditResponse, RouteDecision, RouteRequest, RouteResponse,
  SuggestRequest, SuggestResponse, AppErrorCode,
} from '../../shared/protocol.ts'

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
 *
 * ⚠️ `credentials: 'same-origin'` 是**必须有**的 —— 账号的会话在 cookie 里
 * （见 server/session.ts），不带这一句浏览器根本不发那个 cookie，于是**每个**
 * 请求看上去都是"没登录"。而现象是「登录了还是用不了」——票明明拿到了、
 * 页面上也看不出任何异常，排查时很难往这里想。有测试专门钉着这一句。
 *
 * 写成 `{ credentials, ...init }` 而不是各调用点自己带：这样"会不会带 cookie"
 * 只有**这一个**地方能决定，将来加接口的人不必记得补。
 */
async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init })
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

/** 写接口。今天三个 AI 接口和账号那几个都在用。 */
export async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 读接口（今天只有 `/api/me` 用，但它不该是内联在账号模块里的一句 fetch ——
 *  那样 cookie 和错误翻译这两件事就又有了第二个说法）。 */
export async function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' })
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
