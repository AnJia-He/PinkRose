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
 * 这次失败是不是「用户自己按了停止」。
 *
 * ★ 2026-09-30 跟着「停止」按钮一起加的。为什么需要一个专门的判据：
 *   `fetch` 被 `abort()` 掐掉时抛的是 `AbortError`，而它在**形状上**和
 *   "网线掉了"一模一样（都是一个 DOMException / TypeError）。上面那两层
 *   catch 本来会把任何异常都翻译成「连不上服务器，检查一下网络？」——
 *   用户按了停止，屏幕上却冒出一句让他去查网络的话。所以**必须**在这里
 *   把它认出来、原样放行，由调用方决定怎么说（现在是说一句「停了。」）。
 *
 * 判 `name` 而不是 `instanceof DOMException`：Node 和浏览器里 AbortError
 * 的构造器不是同一个，跨环境比 `name` 才是稳的。
 */
export function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError'
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
  } catch (e) {
    // ⚠️ 用户按了「停止」也从这儿过 —— 那不是"连不上"，别替他判断网络。
    if (isAbort(e)) throw e
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
  } catch (e) {
    // 同上：停止按钮可能在**读正文**这一段才生效（生成那一路正文有几百 KB）。
    if (isAbort(e)) throw e
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

/**
 * 四个动词只差一个 method、一个 body 和两个开关 —— 抽出来，"带不带 cookie"
 * 仍然只有一处说了算。
 *
 * `signal`：只有「停止」那条路用（/api/edit，见 postEdit）。
 *
 * ★ `keepalive`（2026-10-01 加）：页面**正在消失**时（刷新 / 关标签页）还要
 *   发得出去的那条路 —— 普通 fetch 会在卸载时被浏览器掐断，keepalive 的不会。
 *   今天只有落盘那一层用它（见 App.tsx 的 `pagehide` / `visibilitychange`）。
 *   ⚠️ 浏览器对 keepalive 的**请求体有 64 KiB 的硬上限**，超了 fetch 会被
 *   **当场拒绝**（TypeError，不是网络错误）—— 所以"要不要用它"得由调用方
 *   按体量决定（App.tsx 里量过；别在这里替它猜）。
 */
function send<T>(
  method: string, path: string, body?: unknown,
  opts: { signal?: AbortSignal; keepalive?: boolean } = {},
): Promise<T> {
  return request<T>(path, {
    method,
    // ⚠️ 两个开关都写成"有才加"：`signal: undefined` / `keepalive: false` 看着
    //   无害，但那会让 init 的形状随调用点漂 —— 有测试钉着"不传 signal 时
    //   和以前一模一样"（client.test.ts 那三条）。
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.keepalive ? { keepalive: true } : {}),
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

/** 写接口。今天三个 AI 接口和账号那几个都在用。 */
export const post = <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> =>
  send<T>('POST', path, body, { signal })
/** 读接口（今天 `/api/me` 和作品列表用）。它不该是内联在账号模块里的一句 fetch ——
 *  那样 cookie 和错误翻译这两件事就又有了第二个说法。 */
export const get = <T>(path: string): Promise<T> => send<T>('GET', path)
export const patch = <T>(path: string, body: unknown): Promise<T> => send<T>('PATCH', path, body)
/** ⚠️ 第三个参数是 `keepalive`（见 `send` 那段）—— 只有落盘那层用得上，
 *  其余调用点不传，行为和以前一字不差。 */
export const put = <T>(path: string, body: unknown, keepalive = false): Promise<T> =>
  send<T>('PUT', path, body, { keepalive })
export const del = <T>(path: string): Promise<T> => send<T>('DELETE', path)

export async function postRoute(o: RouteRequest): Promise<RouteDecision> {
  const r = await post<RouteResponse>('/api/route', o)
  return r.decision
}

export async function postSuggest(o: SuggestRequest): Promise<SuggestResponse> {
  return post<SuggestResponse>('/api/suggest', o)
}

/**
 * 生成式编辑。**唯一带 signal 的那个** —— 它是唯一一条让用户干等十几秒、
 * 而且用户会有明确"我不想等了"的时刻的路（见 App.tsx 的 stopGeneration）。
 */
export async function postEdit(o: EditRequest, signal?: AbortSignal): Promise<EditResponse> {
  return post<EditResponse>('/api/edit', o, signal)
}
