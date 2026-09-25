import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import {
  findUserByCookie, handleChangePassword, handleLogin, handleSignup,
  type AccountDeps, type PublicUser,
} from './account.ts'
import type { Config } from './config.ts'
import { handleEdit } from './edit.ts'
import { HttpError, readJsonBody, sendError, sendJson } from './http.ts'
import type { SerialQueue } from './queue.ts'
import { handleRoute } from './route.ts'
import {
  clearSessionCookie, daysLeft, expiryOf, parseCookies, RENEW_WITHIN_DAYS,
  sessionCookie, sessionExpiry, signSession, SESSION_COOKIE,
} from './session.ts'
import type { SenseNovaClient } from './sn.ts'
import { handleSuggest } from './suggest.ts'

export type AppDeps = {
  config: Config
  /** 静态资源目录（npm run build 的产物）。测试里不传。 */
  staticDir?: string
  /** 不传时 /api/route、/api/suggest、/api/edit 都会返回 503 —— 让"没接线"可见，而不是静默失败。 */
  client?: SenseNovaClient
  queue?: SerialQueue
  /**
   * 账号这一块要的东西（库 + 签名钥匙）。
   *
   * ★ **必填，不是可选。** 这三个接口每次调用都花真钱 —— 少接一根线必须是
   * **编译错误**，而不是运行时一个 503。静默降级在这里的代价是"谁都能拿你的额度出图"。
   */
  auth: AccountDeps
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

/**
 * 认人。认不出来就 401。
 *
 * ⚠️ **必须在 readJsonBody 之前调用** —— 跟这三个接口原来那句"没接线就立刻失败"
 * 是同一个道理：没登录的人不该有资格让服务器缓冲 12 MB 的请求体。
 * 顺序反了，一个畸形的请求体还会把"没登录"这个更重要的结局盖成"你的 JSON 不对"。
 *
 * ★ 顺带把**滑动续期**做掉（见下面那个函数）。放在这里是因为"认人"只有一个出口：
 * 三个 AI 接口 + /api/me + /api/password 都从这儿过，续期就不必在五个地方各接一次线。
 */
function requireUser(deps: AppDeps, req: IncomingMessage, res: ServerResponse): PublicUser {
  const u = findUserByCookie(req.headers.cookie, deps.auth)
  // 认不出来就到此为止 —— 更不该顺手给一张新票
  if (!u) throw new HttpError('UNAUTHORIZED', '先登录一下', 401)
  renewSessionIfStale(deps, req.headers.cookie, u, res)
  return { id: u.id, username: u.username, email: u.email }
}

/**
 * 滑动续期：这张票离过期不到 `RENEW_WITHIN_DAYS`(15) 天，就重签一张、
 * `Set-Cookie` 换掉，把 30 天重新推满（设计文档 §6.5）。
 *
 * ★ 设计文档还写了一句"同一张票一天最多续一次"，**而这一条不需要记任何状态**：
 *
 *   票里的 `expiresAt` 本身就记着它是什么时候签的（= `expiresAt - SESSION_DAYS`），
 *   于是"剩余不足 15 天才续"这个判据**自己就是节流器** —— 续完的那张票剩余 30 天，
 *   往后 15 天之内都不会再满足这个条件。两张票之间最少隔 15 天，
 *   比"一天最多一次"**更省**（那是它的上界，不是它的目标）。
 *
 *   换句话说：文档要避免的"每个请求都写一次 cookie"，不是靠记一个时间戳避免的，
 *   是靠**判据本身**避免的。判据一旦被去掉，节流也就跟着没了 ——
 *   所以 `server/app.test.ts` 那两条续期用例，一条钉"够了就不写"，
 *   一条钉"快到期才写"。
 *
 * 票读不出过期时间就安静地不续：那张票**已经验过签、已经放行**了，
 * 不该因为一个读不出来的数字把人挡在外面（那是把"没登录"和"我们没看懂"混成一种）。
 *
 * 这里为什么再解析一次 cookie 头（`findUserByCookie` 内部已经解析过）：那个函数的
 * 形状是 Task 5 定下、已经审过的（它只回答"这是谁"），多吐一个 `expiresAt` 出来
 * 比这里多读一次值几个字节的字符串贵 —— 而且"票长什么样"仍然只有 session.ts 知道。
 */
function renewSessionIfStale(
  deps: AppDeps, cookieHeader: string | undefined,
  u: { id: number; passwordHash: string }, res: ServerResponse,
): void {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE]
  const expiresAt = token === undefined ? null : expiryOf(token)
  if (expiresAt === null) return

  // 「现在几点」必须和认人用的**同一个钟**（account.ts 里也是这么取的）：
  // 两边各用一个钟，测试里拨动的时间就只对一半代码生效。
  const nowMs = deps.auth.now ? deps.auth.now() : Date.now()
  if (daysLeft(expiresAt, nowMs) >= RENEW_WITHIN_DAYS) return

  // 新票用的是**刚刚验过的那份哈希** —— 换任何一份（比如从请求里拿）都等于自己造钥匙。
  const next = sessionExpiry(nowMs)
  res.setHeader('set-cookie', sessionCookie(
    signSession(u.id, u.passwordHash, next, deps.auth.secret), next,
  ))
}

async function handle(deps: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (path.startsWith('/api/')) {
    if (req.method === 'GET' && path === '/api/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    // ── 账号：注册 / 登录 / 退出 / 我是谁 / 改密码 ─────────────────────────
    // 这五个不需要 requireUser：注册和登录正是来拿票的，退出只清一个 cookie，
    // 另外两个（/api/me、/api/password）自己在下面调 requireUser。
    if (req.method === 'POST' && path === '/api/signup') {
      const body = await readJsonBody(req)
      const r = handleSignup(body, deps.auth)
      // 注册即登录：票直接挂在这一条响应上，前端不用再多打一次登录
      res.setHeader('set-cookie', sessionCookie(r.token, r.expiresAt))
      sendJson(res, 200, { user: r.user })
      return
    }
    if (req.method === 'POST' && path === '/api/login') {
      const body = await readJsonBody(req)
      const r = handleLogin(body, deps.auth)
      res.setHeader('set-cookie', sessionCookie(r.token, r.expiresAt))
      sendJson(res, 200, { user: r.user })
      return
    }
    if (req.method === 'POST' && path === '/api/logout') {
      // 不用先认人：清 cookie 是幂等且无害的，而"票已经过期的人反而清不掉自己的
      // cookie"才是个真麻烦。这里也**不读请求体** —— 没什么可读的。
      res.setHeader('set-cookie', clearSessionCookie())
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && path === '/api/me') {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, { user })
      return
    }
    if (req.method === 'POST' && path === '/api/password') {
      // 顺序同三个 AI 接口：先认人，再读体
      const user = requireUser(deps, req, res)
      const body = await readJsonBody(req)
      const r = handleChangePassword(body, user, deps.auth)
      res.setHeader('set-cookie', sessionCookie(r.token, r.expiresAt))
      sendJson(res, 200, { user: r.user })
      return
    }
    if (req.method === 'POST' && path === '/api/route') {
      // 顺序是刻意的：守卫在 readJsonBody **之前**。
      // 没接线是部署期的配置错误，要立刻失败——先缓冲 12 MB 再回 503，
      // 而且畸形 body 的 400 会盖住"没接线"这个更重要的信号。
      // 不要为了一条测试把这两句对调。
      //
      // 鉴权排在更前面（requireUser 里那一条），理由同源：没登录的人
      // 更不该有资格让服务器缓冲 12 MB。**这两行的先后也别对调。**
      requireUser(deps, req, res)
      if (!deps.client || !deps.queue) {
        throw new HttpError('INTERNAL', '后端没有配置模型客户端', 503)
      }
      const body = await readJsonBody(req)
      sendJson(res, 200, await handleRoute(body, { client: deps.client, queue: deps.queue }))
      return
    }
    if (req.method === 'POST' && path === '/api/suggest') {
      requireUser(deps, req, res)
      if (!deps.client || !deps.queue) {
        throw new HttpError('INTERNAL', '后端没有配置模型客户端', 503)
      }
      const body = await readJsonBody(req)
      sendJson(res, 200, await handleSuggest(body, { client: deps.client, queue: deps.queue }))
      return
    }
    if (req.method === 'POST' && path === '/api/edit') {
      requireUser(deps, req, res)
      if (!deps.client || !deps.queue) {
        throw new HttpError('INTERNAL', '后端没有配置模型客户端', 503)
      }
      const body = await readJsonBody(req)
      sendJson(res, 200, await handleEdit(body, { client: deps.client, queue: deps.queue }))
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
                           res: ServerResponse): Promise<void> {
  if (!dir) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('开发模式下前端在 http://localhost:5173')
    return
  }
  // 先 normalize 再拼到 dir 上，然后确认结果仍在 dir 内——挡住 ../.. 穿越。
  // 比的是 root + sep，不是裸 root：否则兄弟目录（/a/dist-evil 对 /a/dist）
  // 会被前缀匹配放过去。target === root 不算穿越，照旧走 SPA 兜底。
  const root = resolve(dir)
  const target = resolve(join(root, normalize(path)))
  if (target !== root && !target.startsWith(root + sep)) {
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
  // 读流出错（TOCTOU 删除 / EACCES / EIO）**只毁掉这一个响应**，不能让它
  // 变成进程级的未捕获异常——静态文件读不出来是局部故障，不是致命错误。
  //
  // 只做这一处窄修，**不装全局 uncaughtException**：未知的致命错误让进程
  // 响亮地死掉才是对的，吞掉它等于把以后所有的真 bug 都藏起来。
  const stream = createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
