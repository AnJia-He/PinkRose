import type { IncomingMessage, ServerResponse } from 'node:http'
import { UNEXPECTED_FAILURE } from '../shared/copy.ts'
import type { AppErrorCode } from '../shared/protocol.ts'
import { SnError, redactSecrets } from './sn.ts'

/** 路由处理里唯一该抛的错误类型。带上 HTTP 状态码和给用户看的文案。 */
export class HttpError extends Error {
  // ⚠️ 不用构造函数参数属性（`constructor(public readonly code: ...)`）。
  // Node 24 默认的 TypeScript **剥离**模式不支持它，会抛
  // `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。而 vitest 走 esbuild 能正常转译——
  // 于是测试全绿、`node HeadEnd/BackEnd/index.ts` 直接崩。必须显式声明字段。
  readonly code: AppErrorCode
  readonly status: number
  constructor(code: AppErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'HttpError'
    this.code = code
    this.status = status
  }
}

/**
 * 单个请求体的字节上限。
 *
 * 前端送来的图是 base64 的 data URL（2048 长边的 JPEG 约 1.5 MB，
 * base64 后约 2 MB）。12 MB 给足余量，同时挡住"一坨无限大的 body
 * 把内存吃光"这种最简单的打法。
 */
export const DEFAULT_BODY_LIMIT = 12 * 1024 * 1024

/** 读出并解析 JSON 请求体。超限或格式错都抛 HttpError('BAD_REQUEST')。 */
export function readJsonBody(req: IncomingMessage, limitBytes = DEFAULT_BODY_LIMIT): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limitBytes) {
        // 超限后**只丢不攒**：内存上限就是 limitBytes + 一个 chunk。
        // ⚠️ 这里不写 req.destroy()。实测（Node 24.15.0）：destroy 会同步掐掉
        // 底层 socket（res.socket.destroyed === true），413 响应就再也送不出去了，
        // 客户端只能看到连接被重置（UND_ERR_SOCKET）。请求还在流没关系——
        // 调用方把 413 写完后，Node 的 resOnFinish 会自动 _dump() 掉剩余字节。
        reject(new HttpError('BAD_REQUEST', `请求体超过 ${Math.round(limitBytes / 1024 / 1024)} MB 上限`, 413))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new HttpError('BAD_REQUEST', '请求体不是合法 JSON', 400))
      }
    })
    req.on('error', e => reject(e))
  })
}

/**
 * 请求体必须是**普通对象**。
 *
 * `JSON.parse('42')` / `'null'` / `'[]'` 都是合法 JSON —— 直接读 `.username`
 * 会得到 undefined 或者抛，于是"这次请求有问题"变成 500。
 * 数组也挡掉：它是对象，但没有任何一层意思说账号是个数组。
 *
 * ⚠️ 这两个助手是从 `account.ts` **搬**过来的（那边现在也从这里 import）。
 * 它们是"读请求体"的通用工具，`works.ts` 也要用 —— 留着两份 = 两份会漂。
 */
export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError('BAD_REQUEST', '请求体不对')
  }
  return body as Record<string, unknown>
}

/**
 * 非字符串一律当空串。
 *
 * 缺字段（`{}`）、或者字段是数字/对象，都该走"格式不对"这条正常路，
 * 而不是让 `checkUsername` 里的 `.trim()` 抛出去 —— 那又是把 400 变成 500。
 */
export const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 写 JSON 响应。传 HttpError 时自动转成 spec 定的错误体形状。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const isErr = body instanceof HttpError
  const payload = isErr
    ? { error: { code: body.code, message: body.message } }
    : body
  const text = JSON.stringify(payload)
  res.writeHead(isErr ? body.status : status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 发一段二进制（图片）。和 sendJson 并列 —— 图片不能走 JSON */
export function sendBytes(res: ServerResponse, status: number, bytes: Uint8Array, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': bytes.byteLength,
    // 图是不可变的（换了图 = 换了 URL 上的 ?v=，见 Task 11）。
    // private：这是某个人的图，别让中间缓存留下它
    'cache-control': 'private, max-age=31536000, immutable',
  })
  res.end(Buffer.from(bytes))
}

/**
 * `SnError` 只带 `code`，不带 HTTP 状态码；这张表是二者之间**唯一**的桥。
 * 少了它，上游限流/超时都会以 500 INTERNAL 的形状到达前端，
 * 前端按 `UPSTREAM_LIMIT` 分流的那条分支就成了死代码。
 *
 * ⚠️ `UNAUTHORIZED` 不会从上游来（是我们自己抛的 HttpError，状态码随它一起走）。
 * 它出现在这里，是为了让这张表保持**穷尽**：AppErrorCode 上加一个成员而忘了
 * 这里，必须是编译错误，而不是运行时一个 undefined 状态码。
 */
const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400, UNAUTHORIZED: 401, UPSTREAM_AUTH: 502, UPSTREAM_LIMIT: 503,
  UPSTREAM_FAILED: 502, INTERNAL: 500,
}

/**
 * 「钥匙不对」那句里**两个出口必须逐字相同**的那半句。
 *
 * ★ 为什么抽出来：这句话有两个出口 —— 这张表里的 `UPSTREAM_AUTH`（`/api/edit`
 * 这一路：请求没做成，用户只剩"去查钥匙"）和 `server/route.ts` 的 `AUTH_REPLY`
 * （对话那一路：这次**还是照他说的改完了**，只是顺便告诉钥匙的事）。
 * 两个出口"接下来会发生什么"确实不同，措辞也该不同；**但"去哪查钥匙"必须一样** ——
 * 它今天指的是一条真实走得通的路径（右上角 👤 → 「模型」），改一处漏一处的话，
 * 用户照着另一句去找一个不存在的地方（《文案规范》第三条：不许写产品做不到的事）。
 *
 * ⚠️ 改这半句之前先确认那个路径真的还在（`src/ui/AccountPage.tsx` 里那一行）。
 */
export const CHECK_YOUR_KEY_TIP =
  '如果你填过自己的钥匙，去右上角头像里的「模型」那一页检查一下；没填过的话，那就是我们这边的问题'

/**
 * 给用户看的文案，与上游原文**无关**。
 *
 * ⚠️ 绝不要用 `e.message` 当这里的文案：那是 `上游 HTTP 429：inference
 * exceeds tpm/rpm limit` 这类英文运维口径，前端会原样弹给用户。
 * 上游原文的去处只有一处——服务端日志。
 */
const USER_MESSAGE: Record<AppErrorCode, string> = {
  BAD_REQUEST: '这次请求有点问题，换个说法试试',
  UNAUTHORIZED: '先登录一下',
  // ★ 这一句必须**不知道这把钥匙是谁的**也说真话。
  //
  // 归属（用户自己填的 / 我们自己的）没有被传到这个位置 —— 那要给三个 deps 类型
  // 和三个调用点各加一个字段，为的只是把一句话分两种口吻。
  // 所以写成"谁填的都对号入座"的一句：填过的人去右上角头像里的「模型」那一页查，
  // 没填过的人知道是我们这边的问题。
  // ⚠️ 别改成"你的钥匙填错了"——没填过钥匙的人看到那句话会去找一个根本不存在的东西。
  //
  // ⚠️ 路径**必须写成用户真走得通的那一条**（2026-09-30 改）：原来是
  // 「设置 › 模型」，而界面上**没有**叫「设置」的入口 —— 入口是右上角那颗 👤
  // （用户管理）里的「模型」一行，那个页面自己的标题是「模型设置」。
  // 让用户去找一个不存在的地方，和骗他没两样（《文案规范》第三条）。
  // 后半句和 `server/route.ts` 共用 `CHECK_YOUR_KEY_TIP` —— 别再各写一遍。
  UPSTREAM_AUTH: '服务商不认这把钥匙。' + CHECK_YOUR_KEY_TIP + '，过一会儿再试。',
  UPSTREAM_LIMIT: '排队的人有点多，稍等一下再试',
  UPSTREAM_FAILED: 'AI 服务暂时没响应，再试一次',
  // 和登录页那条兜底同一句（`shared/copy.ts` 里那句注释写了为什么要一份）
  INTERNAL: UNEXPECTED_FAILURE,
}

/** 统一异常出口：HttpError 按原样回；SnError 按 code 映射；其它一律 500 且**不回显内部信息**。 */
export function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof HttpError) {
    sendJson(res, e.status, e)
    return
  }
  if (e instanceof SnError) {
    const status = STATUS_BY_CODE[e.code]
    // 上游原文只进服务端日志；而且过一遍 `redactSecrets` ——
    // 第三方网关会在 401 正文里回显收到的钥匙（§7.7「绝不进日志」，见 sn.ts 那段）
    console.error('[upstream]', redactSecrets(e.message))
    sendJson(res, status, new HttpError(e.code, USER_MESSAGE[e.code], status))
    return
  }
  console.error('[internal]', e)   // 详细堆栈只进服务端日志
  sendJson(res, 500, new HttpError('INTERNAL', USER_MESSAGE.INTERNAL, 500))
}

/**
 * ★ 2026-10-02（安全审计 S2）：**出站响应体的上限**。
 *
 * 加这个之前，`sn.ts` 和 `modeltest.ts` 读正文用的都是裸的 `await res.text()`
 * —— Node 对响应体**没有任何内置上限**（实测：64 MB 一秒内完整缓冲），
 * 代码里也没有 content-length 预检。而这两处的地址是**用户自己填的**：
 * 注册一个号、把地址指向自己的服务器、让它流式回几十 GB，就能把这台机器的
 * 内存吃光（全站一起挂，包括别人的修图）。超时（8s/60s/180s）兜的是**时间**，
 * 兜不住**大小**。
 *
 * 三档差得很开，是照着各自的正常体量定的：探活只要一个模型名单；
 * 路由/卡片是一小段 JSON；出图那一路正文是几百 KB 的 base64。
 */
export const OUTBOUND_LIMITS = {
  probe: 1 << 20,   // 1 MB
  chat: 2 << 20,    // 2 MB
  edit: 64 << 20,   // 64 MB
} as const

/**
 * 读上游正文，**超过上限就掐断**。
 *
 * 两道闸，缺一不可：
 *   ① `content-length` 先看一眼 —— 老实报长度的，连读都不读；
 *   ② 边读边累计 —— **攻击者不会老实报长度**，他会一块一块地灌
 *      （`ReadableStream` 分块响应天然没有 content-length）。
 *      只做①的话，这一条就是空的。
 *
 * 超限时**要把连接收掉**（`cancel()`）：不然对面还在往里灌，
 * 我们这边只是不读了，连接一直挂着。
 */
export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel().catch(() => {})
    throw new Error(`上游声称要回 ${declared} 字节，超过上限 ${maxBytes}`)
  }
  if (!res.body) return ''

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      void reader.cancel().catch(() => {})
      throw new Error(`上游回的正文超过上限 ${maxBytes} 字节，已掐断`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
