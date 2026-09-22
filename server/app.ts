import { createServer, type Server } from 'node:http'
import { existsSync, createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import type { Config } from './config.ts'
import { HttpError, readJsonBody, sendError, sendJson } from './http.ts'
import type { SerialQueue } from './queue.ts'
import { handleRoute } from './route.ts'
import type { SenseNovaClient } from './sn.ts'

export type AppDeps = {
  config: Config
  /** 静态资源目录（npm run build 的产物）。测试里不传。 */
  staticDir?: string
  /** 不传时 /api/route 会返回 503 —— 让"没接线"可见，而不是静默失败。 */
  client?: SenseNovaClient
  queue?: SerialQueue
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
}

export function createApp(deps: AppDeps): Server {
  return createServer((req, res) => {
    handle(deps, req, res).catch(e => sendError(res, e))
  })
}

async function handle(deps: AppDeps, req: import('node:http').IncomingMessage,
                      res: import('node:http').ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (path.startsWith('/api/')) {
    if (req.method === 'GET' && path === '/api/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && path === '/api/route') {
      if (!deps.client || !deps.queue) {
        throw new HttpError('INTERNAL', '后端没有配置模型客户端', 503)
      }
      const body = await readJsonBody(req)
      sendJson(res, 200, await handleRoute(body, { client: deps.client, queue: deps.queue }))
      return
    }
    throw new HttpError('BAD_REQUEST', `没有这个接口：${path}`, 404)
  }

  await serveStatic(deps.staticDir, path, res)
}

/**
 * 静态托管。生产用 `npm run build` 出来的 dist；开发时前端在 5173，
 * 走 Vite 的 proxy 打到 /api，这个分支根本不会命中。
 */
async function serveStatic(dir: string | undefined, path: string,
                           res: import('node:http').ServerResponse): Promise<void> {
  if (!dir) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('开发模式下前端在 http://localhost:5173')
    return
  }
  // 先 normalize 再拼到 dir 上，然后确认结果仍在 dir 内——挡住 ../.. 穿越
  const root = resolve(dir)
  const target = resolve(join(root, normalize(path)))
  if (!target.startsWith(root)) {
    res.writeHead(403); res.end('forbidden'); return
  }
  const file = existsSync(target) && statSync(target).isFile()
    ? target
    : join(root, 'index.html')   // SPA 兜底：未知路径交给前端路由
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('没有构建产物，先跑 npm run build')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}
