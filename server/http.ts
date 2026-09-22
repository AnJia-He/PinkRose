import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppErrorCode } from '../shared/protocol.ts'

/** 路由处理里唯一该抛的错误类型。带上 HTTP 状态码和给用户看的文案。 */
export class HttpError extends Error {
  // ⚠️ 不用构造函数参数属性（`constructor(public readonly code: ...)`）。
  // Node 24 默认的 TypeScript **剥离**模式不支持它，会抛
  // `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。而 vitest 走 esbuild 能正常转译——
  // 于是测试全绿、`node server/index.ts` 直接崩。必须显式声明字段。
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

/** 统一异常出口：HttpError 按原样回，其它一律 500 且**不回显内部信息**。 */
export function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof HttpError) {
    sendJson(res, e.status, e)
    return
  }
  console.error('[internal]', e)   // 详细堆栈只进服务端日志
  sendJson(res, 500, new HttpError('INTERNAL', '服务器内部错误', 500))
}
