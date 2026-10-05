import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { KEY_REQUIRED } from '../shared/copy.ts'
import { normalizeUsername } from '../shared/account.ts'
import {
  findUserByCookie, handleChangePassword, handleDeleteAccount, handleLogin, handleSignup,
  type AccountDeps, type PublicUser,
} from './account.ts'
import { resolveClients, type ClientDeps } from './clientFor.ts'
import type { Config } from './config.ts'
import { handleEdit } from './edit.ts'
import { HttpError, asObject, readJsonBody, sendBytes, sendError, sendJson, str } from './http.ts'
import {
  activateConfig, createConfig, deleteConfig, listConfigs, normalizeBaseUrl,
  resolveSecretById, updateConfig, type ModelConfigDeps, type ModelKind,
} from './models.ts'
import { assertModelHostAllowed, assertResolvedHostAllowed } from './hostGuard.ts'
import { createLut, deleteLut, handleLutFile, listLuts, lutUsage, renameLut } from './luts.ts'
import { QUOTA_BYTES, storedBytes } from './quota.ts'
import { createLimiter, type Limiter } from './ratelimit.ts'
import { probeConnection } from './modeltest.ts'
import type { SerialQueue } from './queue.ts'
import { handleRoute } from './route.ts'
import {
  clearSessionCookie, daysLeft, expiryOf, parseCookies, RENEW_WITHIN_DAYS,
  sessionCookie, sessionExpiry, signSession, SESSION_COOKIE,
} from './session.ts'
import {
  handleCreateSession, handleDeleteSession, handleGetSession, handleListSessions,
  handleSessionFile, handleSessionStepFile, handleSessionThumb, handleUpdateSession,
} from './sessions.ts'
import type { Storage } from './storage.ts'
import { SnError } from './sn.ts'
import { handleSuggest } from './suggest.ts'
import {
  handleCreateWork, handleDeleteWork, handleDeleteWorks, handleGetWork,
  handleListWorks, handleRenameWork, handleReplaceWork, handleWorkFile, handleWorkThumb,
} from './works.ts'

export type AppDeps = {
  config: Config
  /** 静态资源目录（npm run build 的产物）。测试里不传。 */
  staticDir?: string
  /**
   * 三个 AI 接口要的那一套（§7）：**每个请求按登录用户现取**（见 clientFor.ts）——
   * 用户接了自己的模型就走用户的，没配（或用不了）就回落到 `config` 里我们自己的那一份。
   *
   * ⚠️ **不传时 /api/route、/api/suggest、/api/edit 都返回 503** —— 让"没接线"
   * 可见，而不是静默失败。（这是原来 `client` 那条注释的原话，现在它管的是
   * "默认那一套"从哪来；具体用哪一条连接由 `resolveClients` 每请求现算。）
   */
  clients?: ClientDeps
  queue?: SerialQueue
  /**
   * 账号这一块要的东西（库 + 签名钥匙）。
   *
   * ★ **必填，不是可选。** 这三个接口每次调用都花真钱 —— 少接一根线必须是
   * **编译错误**，而不是运行时一个 503。静默降级在这里的代价是"谁都能拿你的额度出图"。
   */
  auth: AccountDeps
  /**
   * 图片文件那一层（Task 1）。**同样必填。**
   *
   * 和 `auth` 一个道理：少接这一根线的后果是"每次存作品都 500"，
   * 而不是编译错误 —— 那正是最贵的那种（要等用户点了保存才发现）。
   * 传进来的实现换掉（比如以后换云存储），这一层以上一个字都不用动。
   */
  storage: Storage
  /** 滤镜文件那一层（2026-10-05）。**必填**，理由同 storage —— 缺了就是运行期才炸。 */
  lutStorage: Storage
  /**
   * 用户接进来的模型（§7）。**必填**，理由同 auth / storage：
   * 少接这一根线的后果是"用户配了自己的钥匙但一次都没用上" ——
   * 那是最难发现的一种坏（它不报错，只是安静地花我们的钱）。
   */
  models: ModelConfigDeps
  /**
   * 每账号每分钟最多几次 AI 调用（§6.6 那一行的另一半；默认 10）。
   * ★ 2026-10-04 加。测试注入用：日额度那组用例会连打 20 次 edit，
   *   不把这个数放大，会被这道闸先拦住 —— 拦的还不是它们要验的那件事。
   */
  aiPerMinute?: number
  /**
   * 同时**在途**的请求数上限（默认 64）。★ 2026-10-04 加（审计 F2）：
   * `http.ts` 只限单个请求体（12 MB），不限"同时几个" —— 超了直接 503。
   * 测试注入用。
   */
  maxInFlight?: number
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
  // ★ 2026-10-04 补的三种：dist 里真的有（品牌字 .woff2、落地页 .webp），
  //   而这张表里没有的扩展名会以 application/octet-stream 发出去 ——
  //   字体被当二进制流，有些浏览器直接不认。
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * 三个「可以被人反复打」的入口各一把限流器。
 *
 * ★ 2026-10-02 加（安全审计 H2 / M3 / S3）。在那之前：登录**一个失败计数都没有**
 *   （字典可以慢慢试密码，而接口还主动回答"这个账号存不存在"）、注册不限量
 *   （批量开小号去烧我们的额度）、`/api/models/test` 是登录即可用、不限速、
 *   不排队的**网络探测器**（能靠返回码扫内网端口）。
 *
 * ⚠️ **挂在 `createApp` 里**（每个 app 一份），不是模块级单例 ——
 *   模块级的话测试之间会互相污染：上一个用例把额度用光，下一个莫名其妙 429。
 *
 * ⚠️ **为什么登录按"用户名"记、不按 IP**：这个后端只听 127.0.0.1，而手机调试是
 *   经 vite 代理进来的 —— 所有请求的 `remoteAddress` 都是 127.0.0.1。
 *   按 IP 记等于**全局限流**：一个人打错十次密码，全站都登不上了。
 *   按用户名记才挡得住真正要挡的那件事（盯着一个账号慢慢试）。
 */
type Gates = { login: Limiter; signup: Limiter; probe: Limiter; edit: Limiter; ai: Limiter }

function newGates(aiPerMinute = 10): Gates {
  return {
    login: createLimiter({ max: 10, windowMs: 15 * 60_000 }),
    // 注册按 IP —— 这里没有"某个账号"可盯，要挡的是批量开小号。
    signup: createLimiter({ max: 20, windowMs: 60 * 60_000 }),
    probe: createLimiter({ max: 30, windowMs: 10 * 60_000 }),
    // ★ **日额度**：`/api/edit` 一次约 12,900 tokens，而注册是开放的 ——
    //   同一个 wifi 下任何人注册个号就能把运营者的额度当免费 API 用。
    //   数取自设计文档 §6.6（每人每天 20 次生成）—— 那张表一直躺在文档里没实现。
    //   ⚠️ 2026-10-03 起 App 上传前那一屏**不再提这个数**了（用户把那些提示都撤了），
    //   现在只有当额度真的用完时，下面 `assertDailyQuota` 那句 429 才对用户说一次。
    edit: createLimiter({ max: 20, windowMs: 24 * 60 * 60_000 }),
    // ★ 2026-10-04：§6.6 那张表的另一半 —— **每账号每分钟 10 次 AI 调用**。
    //   三个 AI 接口（route / suggest / edit）共用这一个桶：只限 edit 的话，
    //   route/suggest 这两条花钱少、但**同样花钱**的路完全没有闸，一个人可以
    //   拿它们当免费 API 打。日额度管"今天还能改几张"，这道管"别打得太快"。
    ai: createLimiter({ max: aiPerMinute, windowMs: 60_000 }),
  }
}

/**
 * 日额度用完了。
 *
 * ⚠️ **和 `assertGate` 分开写**：两者都是 429，但**下一步动作不一样** ——
 * 那条是"慢一点再试"（几秒/几分钟），这条是"明天再来"。
 * 共用一句话的话，用户会坐在那儿等一个几分钟后也不会好的东西。
 */
function assertDailyQuota(lim: Limiter, key: string): void {
  if (lim.hit(key).ok) return
  throw new HttpError('TOO_MANY', '今天改得够多了（一天大概二十来张），明天再来。', 429)
}

/**
 * 额度不够就抛。**等待时间要说成人话** —— 900 秒没人算得出来是多久。
 */
function assertGate(lim: Limiter, key: string, what: string): void {
  const r = lim.hit(key)
  if (r.ok) return
  const secs = Math.ceil(r.retryAfterMs / 1000)
  const wait = secs >= 120 ? `${Math.ceil(secs / 60)} 分钟` : `${secs} 秒`
  // ⚠️ **429 必须显式传**：`HttpError` 的 status 默认是 400，它**不查**
  //    `STATUS_BY_CODE`（那张表只管 `SnError`）。不传的话，限流确实挡住了，
  //    但用户收到的是"你的请求有问题"—— 而他要做的是"等一会儿再试"，
  //    两件事的下一步动作完全不同。这一条是写测试时才发现的。
  throw new HttpError('TOO_MANY', `${what}试得太频繁了，等 ${wait}再试。`, 429)
}

/**
 * ★ 2026-10-04：每分钟那道的文案。和 `assertGate` 分开写，因为下一步动作不一样 ——
 * `assertGate` 那三条是"慢一点再试"（几秒到几分钟），这条也是，但那句模板
 * （`${what}试得太频繁了`）套在"AI 调用"上读着别扭（"AI 调用试得太频繁了"）。
 * 不许说成"你的请求有问题" —— 那不是他的请求有问题，是他做得快了点。
 */
function assertAiGate(lim: Limiter, key: string): void {
  const r = lim.hit(key)
  if (r.ok) return
  const secs = Math.ceil(r.retryAfterMs / 1000)
  throw new HttpError('TOO_MANY', `做得有点快 —— 等 ${secs} 秒再继续。`, 429)
}

export function createApp(deps: AppDeps): Server {
  const gates = newGates(deps.aiPerMinute)
  // ★ 2026-10-04（审计 F2）：**全局在途上限**。`http.ts` 只限单个请求体
  //   （12 MB），不限"同时有几个" —— 每人几个 12 MB 的并发就能把内存吃光，
  //   而且它们还得在串行队列里排队（body 整份留在内存）。超了当场 503：
  //   这不是"你的请求有问题"，是"现在人有点多"。
  //   放在**读任何东西之前** —— 挡的就是"别把 body 收进来"。
  let inFlight = 0
  const maxInFlight = deps.maxInFlight ?? 64
  return createServer((req, res) => {
    if (inFlight >= maxInFlight) {
      sendError(res, new HttpError('INTERNAL', '现在人有点多，等一会儿再试。', 503))
      return
    }
    inFlight++
    handle(deps, req, res, gates)
      .catch(e => sendError(res, e))
      .finally(() => { inFlight-- })
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

async function handle(deps: AppDeps, req: IncomingMessage, res: ServerResponse, gates: Gates): Promise<void> {
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
      // 注册按 IP（vite 代理之下所有请求都长着同一个 IP —— 见 newGates 那段）
      assertGate(gates.signup, `signup:${req.socket.remoteAddress ?? '?'}`, '注册')
      const r = await handleSignup(body, deps.auth)
      // 注册即登录：票直接挂在这一条响应上，前端不用再多打一次登录
      res.setHeader('set-cookie', sessionCookie(r.token, r.expiresAt))
      sendJson(res, 200, { user: r.user })
      return
    }
    if (req.method === 'POST' && path === '/api/login') {
      const body = await readJsonBody(req)
      // 按**用户名**记（小写、截断）—— 理由见 newGates 那段。
      // 名字读不出来时用一个固定桶：那是畸形请求，也该被限住。
      // ★ 2026-10-04：这里原来自己写 `trim().toLowerCase()`，而**认人**那条路
      //   还会折中点（`·` 的三种写法，见 shared/account.ts 的 normalizeUsername）——
      //   于是含中点的账号能拿三种写法各试 10 次，等于把 10 次的线变成 30 次。
      //   闸门的 key 必须和认人**同一套归一化**，否则限的是另一种名字。
      const who = normalizeUsername(str((body as { username?: unknown })?.username)).slice(0, 64) || '(空)'
      const gate = `login:${who}`
      assertGate(gates.login, gate, '登录')
      const r = await handleLogin(body, deps.auth)
      // 成功了就把计数清掉 —— 别让"前几次打错"一直攒着，
      // 攒到第十次把一个正常用户挡在门外。
      gates.login.reset(gate)
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
      // ★ 2026-10-04：带上**用量**（作品张数 / 占的空间 / 上限）—— 原来只有 {user}，
      //   于是「使用情况」那一格只能在前端把整份作品清单拉下来自己加，
      //   而且**看不见会话占的空间**（那也是用户的文件）。§6.6 那条 80% 提醒
      //   要的就是这三个数（"还能存几张"由前端按每张 2 MB 估，见 AccountPage）。
      const count = (deps.auth.db.raw
        .prepare('SELECT COUNT(*) AS n FROM works WHERE user_id = ?')
        .get(user.id) as { n: number }).n
      sendJson(res, 200, {
        user,
        usage: { count, bytes: storedBytes(deps.auth.db, user.id), limit: QUOTA_BYTES },
      })
      return
    }
    if (req.method === 'DELETE' && path === '/api/account') {
      // ★ 2026-10-04（spec §5）：注销 = 作品全删（记录 + 文件），会话和模型配置
      //   随用户行级联删。这里只管把票一起清掉 —— 人已经没了，
      //   那张 cookie 留着只会在下一次请求里撞 401。
      const user = requireUser(deps, req, res)
      await handleDeleteAccount(user, { db: deps.auth.db, storage: deps.storage })
      res.setHeader('set-cookie', clearSessionCookie())
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && path === '/api/password') {
      // 顺序同三个 AI 接口：先认人，再读体
      const user = requireUser(deps, req, res)
      const body = await readJsonBody(req)
      const r = await handleChangePassword(body, user, deps.auth)
      res.setHeader('set-cookie', sessionCookie(r.token, r.expiresAt))
      sendJson(res, 200, { user: r.user })
      return
    }
    if (req.method === 'POST' && path === '/api/works') {
      // 顺序同 /api/password：先认人，再读体。没登录的人不该有资格让服务器缓冲 12 MB。
      const user = requireUser(deps, req, res)
      // ⚠️ 不能把 `deps` 整个传下去（brief 原稿那句就是那么写的）：`WorksDeps` 要的是
      // **顶层**的 `db`，而 AppDeps 的库藏在 `auth` 里 —— 两个形状不是一回事，
      // 编译器当场会拦下来。`now` 也照用 auth 那一个：两边各用一个钟，
      // 测试里拨动的时间就只对一半代码生效。
      sendJson(res, 200, await handleCreateWork(await readJsonBody(req), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      }))
      return
    }
    if (req.method === 'GET' && path === '/api/works') {
      const user = requireUser(deps, req, res)
      // 依赖的形状和上面那条 POST 一字不差（理由也一样：库藏在 auth 里，整个 deps
      // 传下去编译器当场会拦）。GET 所以**不读请求体** —— 没什么可读的。
      //
      // 这条回的是**全部作品的元数据**，一张图、一条配方都不带 —— 要一次给完、
      // 又要小，才能让前端自己分组、搜索、再按屏幕上的位置去单取图（裁定 ③，
      // 细节见 works.ts 的 handleListWorks）。
      sendJson(res, 200, handleListWorks(user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      }))
      return
    }
    // ★ 全仓库第一个带路径参数的接口。这个仓库没有路由表（全是精确匹配），
    // 所以参数得自己从 path 里剖出来。正则**必须锚定整串**：
    // 不锚定的话 `/api/works/1/file/../../etc` 也能匹配上。
    //
    // 两条都是 GET，所以**不读请求体** —— 那会挂住等一个永远不会来的流。
    // 依赖的形状同上面那条 POST：库藏在 auth 里，整个 deps 传下去编译器当场会拦。
    const fileRoute = /^\/api\/works\/(\d+)\/file$/.exec(path)
    if (req.method === 'GET' && fileRoute) {
      const user = requireUser(deps, req, res)
      const { bytes, contentType } = await handleWorkFile(Number(fileRoute[1]), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      })
      sendBytes(res, 200, bytes, contentType)
      return
    }
    const thumbRoute = /^\/api\/works\/(\d+)\/thumb$/.exec(path)
    if (req.method === 'GET' && thumbRoute) {
      const user = requireUser(deps, req, res)
      const { bytes, contentType } = await handleWorkThumb(Number(thumbRoute[1]), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      })
      sendBytes(res, 200, bytes, contentType)
      return
    }
    // 单张的详情（GET）和改名（PATCH）—— 两条共用这一个正则。锚定整串的理由同上一条：
    // 不锚定的话 `/api/works/1/file/../../etc` 也能匹配上。
    //
    // ⚠️ **写成独立的一行、别内联进下面的 `if`** —— 后面删和替换那两条走的是同一个
    // `/api/works/:id`，还要接着用这一个变量。放在 file / thumb 之后只是读起来
    // 按"先看图的接口、再看改的"排；三条正则都锚定整串，谁先谁后都只匹配自己那一串。
    const oneRoute = /^\/api\/works\/(\d+)$/.exec(path)
    if (req.method === 'GET' && oneRoute) {
      const user = requireUser(deps, req, res)
      // 依赖的形状同上面几条：库藏在 auth 里，整个 deps 传下去编译器当场会拦。
      // GET 所以**不读请求体** —— 没什么可读的。
      sendJson(res, 200, handleGetWork(Number(oneRoute[1]), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      }))
      return
    }
    if (req.method === 'PATCH' && oneRoute) {
      // 顺序同 /api/password 和 /api/works：先认人，再读体。没登录的人不该有资格
      // 让服务器缓冲 12 MB —— 而且畸形请求体的 400 会盖住"没登录"这个更重要的结局。
      const user = requireUser(deps, req, res)
      sendJson(res, 200, handleRenameWork(Number(oneRoute[1]), await readJsonBody(req), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      }))
      return
    }
    // 删除（DELETE）和替换（PUT）走的是同一个 `/api/works/:id`，复用上面那个正则。
    // DELETE **不读请求体** —— 没什么可读的，读它只会挂住等一个永远不会来的流。
    // 依赖的形状同上面几条：库藏在 auth 里，整个 deps 传下去编译器当场会拦。
    if (req.method === 'DELETE' && oneRoute) {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, await handleDeleteWork(Number(oneRoute[1]), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      }))
      return
    }
    if (req.method === 'PUT' && oneRoute) {
      // 顺序同 PATCH：先认人，再读体。理由也一样 —— 畸形请求体的 400 会把
      // "没登录"这个更重要的结局盖掉。
      const user = requireUser(deps, req, res)
      sendJson(res, 200, await handleReplaceWork(Number(oneRoute[1]), await readJsonBody(req), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      }))
      return
    }
    // 这条是 `/api/works/delete`，而 `/^\/api\/works\/(\d+)$/` 匹配不到 `delete`（\d+ 挡着），
    // 所以它排在 `/api/works/:id` 那组前面还是后面**都无所谓**。写在这儿是为了读的人
    // 一眼看到这三条是一组。
    if (req.method === 'POST' && path === '/api/works/delete') {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, await handleDeleteWorks(await readJsonBody(req), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      }))
      return
    }
    // ── 会话（2026-10-01）。设计和约束见 docs/superpowers/specs/2026-10-01-sessions-design.md
    //
    // 顺序同作品那几条：先认人，再读体；GET / DELETE 不读体。
    // 依赖形状也必须一模一样 —— 库藏在 auth 里，整个 deps 传下去编译器当场会拦。
    if (req.method === 'POST' && path === '/api/sessions') {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, await handleCreateSession(await readJsonBody(req), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      }))
      return
    }
    if (req.method === 'GET' && path === '/api/sessions') {
      const user = requireUser(deps, req, res)
      // ★ 这条 handler 是**同步**的（列表只有一次查询）—— 别顺手写成 `await …`，
      //   那会把它变成 Promise，而 `sendJson` 收下一个 Promise 会序列化成 `{}`。
      sendJson(res, 200, handleListSessions(user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      }))
      return
    }
    // 三条图片接口共用这一条正则。⚠️ **数一数括号**：`(\d+)` 一共两个 ——
    // 第 1 组是会话 id，第 2 组是整个 `original | base | step/<id>`，而
    // `step/` **里面**那个 `(\d+)` 是**第 3 组**（不是第 4，也没有第 4 组）。
    //
    // ⚠️ 写成 `[4]` 的后果**不会报错，只会静静地给错图**：`[4]` 是 `undefined`，
    // 于是三元走 else 那支、把 `[2]`（`"step/999"` 这个**字符串**）当成 `which`
    // 传下去 —— 而 `handleSessionFile` 里 `which === 'original' ? … : row.base`，
    // 凡是不等于 `'original'` 的都回 **base**。也就是说：**任何** step 请求
    // （包括压根不存在的 999）都会拿到 200 + 底图，`handleSessionStepFile`
    // 一步都走不到，`requireOwnFile` 那条守卫永远不被经过。
    // `server/app.test.ts` 里「某一步的图」那条的 `step/999 → 404` 正是钉它的。
    const sessionFileRoute = /^\/api\/sessions\/(\d+)\/file\/(original|base|step\/(\d+))$/.exec(path)
    if (req.method === 'GET' && sessionFileRoute) {
      const user = requireUser(deps, req, res)
      const d = { db: deps.auth.db, storage: deps.storage, now: deps.auth.now }
      const id = Number(sessionFileRoute[1])
      const stepId = sessionFileRoute[3]
      const { bytes, contentType } = stepId
        ? await handleSessionStepFile(id, Number(stepId), user, d)
        : await handleSessionFile(id, sessionFileRoute[2] as 'original' | 'base', user, d)
      sendBytes(res, 200, bytes, contentType)
      return
    }
    // 列表上那张小图。⚠️ 和作品那两条一样，回的是 **`immutable` 长缓存** ——
    // 所以客户端拼 URL 时要带上 `updated_at` 当版本号（前端那边 `sessionThumbUrl`）。
    const sessionThumbRoute = /^\/api\/sessions\/(\d+)\/thumb$/.exec(path)
    if (req.method === 'GET' && sessionThumbRoute) {
      const user = requireUser(deps, req, res)
      const { bytes, contentType } = await handleSessionThumb(Number(sessionThumbRoute[1]), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      })
      sendBytes(res, 200, bytes, contentType)
      return
    }
    // 单条的详情（GET）/ 更新（PUT）/ 删除（DELETE）—— 三条共用这一个正则。
    // ⚠️ 和作品那组同一条规矩：**写成独立的一行、别内联进下面的 `if`**，
    //    下面三条都要接着用这一个变量；而 `^…$` 锚着整串，上面两条子路由
    //    （`/file/…`、`/thumb`）谁也抢不走谁的。
    const sessionOneRoute = /^\/api\/sessions\/(\d+)$/.exec(path)
    if (req.method === 'GET' && sessionOneRoute) {
      const user = requireUser(deps, req, res)
      // 同步 handler，理由同上面列表那条：别写成 `await`。
      sendJson(res, 200, handleGetSession(Number(sessionOneRoute[1]), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      }))
      return
    }
    if (req.method === 'PUT' && sessionOneRoute) {
      // 顺序同 /api/password 和作品那几条：先认人，再读体。没登录的人不该有资格
      // 让服务器缓冲 12 MB —— 而且畸形请求体的 400 会盖住"没登录"这个更重要的结局。
      const user = requireUser(deps, req, res)
      sendJson(res, 200, await handleUpdateSession(Number(sessionOneRoute[1]), await readJsonBody(req), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      }))
      return
    }
    if (req.method === 'DELETE' && sessionOneRoute) {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, await handleDeleteSession(Number(sessionOneRoute[1]), user, {
        db: deps.auth.db, storage: deps.storage, now: deps.auth.now,
      }))
      return
    }
    // ── 模型设置（§7）────────────────────────────────────────────────────
    // 全部需要登录，而且**顺序和别处一致**：先认人，再读体。
    if (req.method === 'GET' && path === '/api/models') {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, listConfigs(user, deps.models))
      return
    }
    if (req.method === 'POST' && path === '/api/models') {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, createConfig(await readJsonBody(req), user, deps.models))
      return
    }
    if (req.method === 'POST' && path === '/api/models/activate') {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, activateConfig(await readJsonBody(req), user, deps.models))
      return
    }
    // ★ 「测一下」：**先存后测，或者给全量参数**。
    //
    //   两种调用方式，因为界面里这两个时刻都存在：
    //   · `{ id }` —— 已经存过的那一套，用库里那把钥匙测；
    //   · `{ kind, baseUrl, apiKey, modelId, alias }` —— 表单里刚敲进去、
    //     **还没保存**的就直接测。
    //
    //   ⚠️ 为什么要有第二种：LobeChat 的教训 —— 它的「检查」按钮**先自动保存
    //     表单再测**，否则测的是"上次保存的值"。我们不用偷偷保存（那会写进去
    //     一套用户可能不想要的配置），直接把参数带上来测，一样是"测的就是
    //     你眼睛看到的那一份"。
    if (req.method === 'POST' && path === '/api/models/test') {
      const user = requireUser(deps, req, res)
      const body = asObject(await readJsonBody(req))
      // ★ 它是登录即可用的**网络探测器**（失败原因三态可区分 = 能扫端口），
      //   所以按用户限速。放在读体之后（要先知道是谁）。
      assertGate(gates.probe, `probe:${user.id}`, '测试连接')
      // 库里那一套：先按 id 取，取不到就是 404（别人的 / 没有的，同一个结局）
      let conn: { baseUrl: string; apiKey: string; anthropic: boolean }
      if (body.id !== undefined) {
        const s = resolveSecretById(Number(body.id), str(body.kind) as ModelKind, user, deps.models)
        if (!s) throw new HttpError('BAD_REQUEST', '没有这一套设置', 404)
        // ★ 2026-10-02：按 id 测的这条路**绕过了 normalizeBaseUrl** ——
        //   它拿的是库里那份存下来的地址，所以这里要单独再拦一次内网
        //   （和 clientFor 里那道同一个理由：存量配置不会自己消失）。
        assertModelHostAllowed(s.baseUrl)
        conn = { baseUrl: s.baseUrl, apiKey: s.apiKey, anthropic: s.provider === 'anthropic-compatible' }
      } else {
        conn = {
          baseUrl: normalizeBaseUrl(str(body.baseUrl)),
          apiKey: str(body.apiKey).trim(),
          // 表单里选的那个形状（"还没保存就先测"的场景 —— 那一刻库里没有它）
          anthropic: str(body.provider) === 'anthropic-compatible',
        }
        if (!conn.apiKey) throw new HttpError('BAD_REQUEST', KEY_REQUIRED)
      }
      // 打的是 `GET {baseUrl}/models` —— 免费的探活，返回的形状见 modeltest.ts。
      // 探不通也回 200：那是"这次探活的结果"，不是"这次请求失败了"。
      // ★ 2026-10-04：就差真正发出去了 —— 把域名解析成 IP 再判一次。
      //   上面那两道（normalizeBaseUrl / assertModelHostAllowed）都只认字面量，
      //   而 `127.0.0.1.nip.io` 这类公共通配 DNS 实测能绕（一分钱不花）。
      //   这里正是那个"靠失败原因扫端口"的探测器，必须先过这一关。
      await assertResolvedHostAllowed(conn.baseUrl, { lookup: deps.clients?.lookupHost })
      sendJson(res, 200, await probeConnection(conn))
      return
    }
    // 带路径参数的那两条。正则**必须锚定整串** —— 和 works 那三条同一个理由。
    // 这条排在 activate 后面无所谓（`/api/models/activate` 不是数字，\d+ 匹配不到）。
    const modelRoute = /^\/api\/models\/(\d+)$/.exec(path)
    if (req.method === 'PATCH' && modelRoute) {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, updateConfig(Number(modelRoute[1]), await readJsonBody(req), user, deps.models))
      return
    }
    if (req.method === 'DELETE' && modelRoute) {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, deleteConfig(Number(modelRoute[1]), user, deps.models))
      return
    }
    // ── 滤镜（LUT，2026-10-05）。设计：docs/superpowers/specs/2026-10-05-lut-design.md
    // 顺序和别处一致：先认人，再读体；GET / DELETE 不读体。
    if (req.method === 'GET' && path === '/api/luts') {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, listLuts(user, { db: deps.auth.db, storage: deps.lutStorage, now: deps.auth.now }))
      return
    }
    if (req.method === 'POST' && path === '/api/luts') {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, await createLut(await readJsonBody(req), user, {
        db: deps.auth.db, storage: deps.lutStorage, now: deps.auth.now,
      }))
      return
    }
    const lutFileRoute = /^\/api\/luts\/(\d+)\/file$/.exec(path)
    if (req.method === 'GET' && lutFileRoute) {
      const user = requireUser(deps, req, res)
      const { bytes, contentType } = await handleLutFile(Number(lutFileRoute[1]), user, {
        db: deps.auth.db, storage: deps.lutStorage, now: deps.auth.now,
      })
      sendBytes(res, 200, bytes, contentType)
      return
    }
    const lutUsageRoute = /^\/api\/luts\/(\d+)\/usage$/.exec(path)
    if (req.method === 'GET' && lutUsageRoute) {
      const user = requireUser(deps, req, res)
      // 同步 handler：`sendJson` 收下的必须**已经是那个对象**。
      // ⚠️ 这里原来那句理由是错的（"写成 await 会变成 Promise"）—— 给同步函数写
      // `await` 是无害的（实测：加 `await` 照样绿）。真正会静默变 `{}` 的是反过来
      // 那一半：`lutUsage` 哪天变成 async 而**这个调用点漏掉 await**，`sendJson`
      // 收到 Promise、`JSON.stringify` 出来就是 `{}`，回 200、看着一切正常。
      // `app.test.ts` 的「usage 回的是 JSON 对象，不是 {}」用变异实测钉着这一条。
      sendJson(res, 200, lutUsage(Number(lutUsageRoute[1]), user, {
        db: deps.auth.db, storage: deps.lutStorage, now: deps.auth.now,
      }))
      return
    }
    const lutOneRoute = /^\/api\/luts\/(\d+)$/.exec(path)
    if (req.method === 'PATCH' && lutOneRoute) {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, renameLut(Number(lutOneRoute[1]), await readJsonBody(req), user, {
        db: deps.auth.db, storage: deps.lutStorage, now: deps.auth.now,
      }))
      return
    }
    if (req.method === 'DELETE' && lutOneRoute) {
      const user = requireUser(deps, req, res)
      sendJson(res, 200, await deleteLut(Number(lutOneRoute[1]), user, {
        db: deps.auth.db, storage: deps.lutStorage, now: deps.auth.now,
      }))
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
      //
      // ★ 返回值要接住：下面取客户端要的就是**这个用户**。
      //   丢着不接的话，取客户端时只能再 requireUser 一遍 —— 同一个请求
      //   认两次人，多花一次验签加查库，也让"是谁"有了两个来处。
      const user = requireUser(deps, req, res)
      if (!deps.clients || !deps.queue) {
        throw new HttpError('INTERNAL', '后端没有配置模型客户端', 503)
      }
      // ★ 2026-10-04：每分钟那道闸（§6.6）。放在 503 之后 —— 后端没接线是我们
      //   这边的问题，不该记用户的次数（和 edit 那条日额度同一个理由）。
      assertAiGate(gates.ai, `ai:${user.id}`)
      const body = await readJsonBody(req)
      // ★ 取客户端放在**读完请求体之后**：读一具 12 MB 的 body 要花时间，
      //   而"该用谁的钥匙"在那一刻之前就已经定了。顺序反过来只是白等。
      //   路由/建议这一路要用**聊天**那一套（§7.4：chat 管 route/suggest）。
      const { chat } = await resolveClients(user, deps.clients)
      sendJson(res, 200, await handleRoute(body, { client: chat, queue: deps.queue }))
      return
    }
    if (req.method === 'POST' && path === '/api/suggest') {
      const user = requireUser(deps, req, res)
      if (!deps.clients || !deps.queue) {
        throw new HttpError('INTERNAL', '后端没有配置模型客户端', 503)
      }
      assertAiGate(gates.ai, `ai:${user.id}`)
      const body = await readJsonBody(req)
      const { chat } = await resolveClients(user, deps.clients)
      sendJson(res, 200, await handleSuggest(body, { client: chat, queue: deps.queue }))
      return
    }
    if (req.method === 'POST' && path === '/api/edit') {
      const user = requireUser(deps, req, res)
      if (!deps.clients || !deps.queue) {
        throw new HttpError('INTERNAL', '后端没有配置模型客户端', 503)
      }
      // ★ 2026-10-04：每分钟那道闸（§6.6），三条 AI 路共用同一个桶 ——
      //   放它**在读体之前**：做得太快的人不该让服务器先把 12 MB 收下来。
      assertAiGate(gates.ai, `ai:${user.id}`)
      // ★ 日额度这一道的两件事**放在读完请求体之后**：
      //   · 503 那条（上面）：后端没接线是**我们这边**的问题，不该记用户的额度；
      //   · 读 body 这条（2026-10-04 补）：原来记在读之前 —— 一个 400/413 的坏请求
      //     也会白占掉今天的一次。
      //   放在 /api/edit（而不是 route/suggest 那两条）是因为**只有它会真的花 12,900 tokens**。
      const body = await readJsonBody(req)
      const editKey = `edit:${user.id}`
      assertDailyQuota(gates.edit, editKey)
      // ★ 2026-09-30（「停止」按钮）：**用户走了，我们也要停。**
      //
      //   前端按停止 → 浏览器掐断这次连接 → 这里拿到 close。
      //   不跟着停会怎样：上游照跑到底（钱照花），而那一次还占着**全局串行
      //   队列**十几秒 —— 用户停完马上说的下一句话得排在它后面白等，
      //   也就是说"停了反而更慢"，比没有这个按钮还糟。
      //
      //   ⚠️ `close` 在**正常结束**时也会触发，用 writableEnded 区分：
      //   已经写完的响应当然不用（也不能）abort。
      //
      //   ⚠️ 顺带量过一件本来担心的事：这次生成随后会失败，统一异常出口
      //   （sendError → sendJson）还想把一句 JSON 写回那个**已经销毁的**响应。
      //   实测（Node 24）那是**静默丢掉**的，不抛也不崩 —— 所以 http.ts 里
      //   **没有**加"res.destroyed 就别写"那类守卫（加过，变异验不出任何差别，
      //   撤了）。别凭直觉再补一条，先看这里。
      const ac = new AbortController()
      res.on('close', () => { if (!res.writableEnded) ac.abort() })
      // ★ 改图这一路要用**图片**那一套（§7.4）—— 和上面两条是两条独立的路，
      //   所以图片的钥匙填错了，对话完全不受影响。取客户端放在读完请求体之后，
      //   理由同 /api/route（别让读 12 MB 的每一毫秒都白等一次解密 + 查询）。
      const { image } = await resolveClients(user, deps.clients)
      try {
        sendJson(res, 200, await handleEdit(body, {
          client: image, queue: deps.queue, signal: ac.signal,
        }))
      } catch (e) {
        // ★ 2026-10-04：**上游自己挂了**（5xx / 限流 / 网络）→ 用户什么也没拿到，
        //   把今天这一次退回去（`SnError.retryable` 正好就是这一类）。
        //   ⚠️ **用户按停止不退**：那个请求已经发出去、上游可能照跑过一段，
        //   而且"取消不计数"会给一条"反复取消"的循环留口子。内容被上游拒（4xx）
        //   也不退 —— 那是用户这边的输入问题。
        if (e instanceof SnError && e.retryable) gates.edit.refund(editKey)
        throw e
      }
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
/** 见上面那句：未知路径该用哪一份壳（`app.html` 优先给 App 那几屏，缺了就退 index）。 */
function shellFor(root: string, path: string): string {
  const appPath = path === '/app' || path.startsWith('/app/') ||
    path === '/works' || path.startsWith('/works/')
  const appShell = join(root, 'app.html')
  return appPath && existsSync(appShell) ? appShell : join(root, 'index.html')
}

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
    // SPA 兜底：未知路径交给前端路由。
    // ★ 2026-10-04：**两份壳**。`index.html` 是**预渲染过的落地页**（爬虫要读的
    //   就是这一份），`/app` 和 `/works` 底下走 `app.html`（空壳）—— 反过来的话
    //   App 那几屏会先闪一帧落地页的内容、再被 React 清掉。
    //   ⚠️ `app.html` 不在时（没跑预渲染、或者 dist 是旧的）退回 index.html：
    //   **少一份壳也要能用**，别让分发这一层变成"构建顺序错了就打不开"。
    : shellFor(root, path)
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
