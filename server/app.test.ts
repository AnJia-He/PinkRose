import { connect } from 'node:net'
import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { request, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { handleSignup, type AccountDeps } from './account.ts'
import { b64Of, jpegBytes } from './testImages.ts'
import { createApp, type AppDeps } from './app.ts'
import type { ClientDeps } from './clientFor.ts'
import type { Config } from './config.ts'
import { openDb, type Db } from './db.ts'
import { createVault } from './keyvault.ts'
import { SerialQueue } from './queue.ts'
import { SESSION_COOKIE } from './session.ts'
import { SenseNovaClient } from './sn.ts'
import { createStorage, type Storage } from './storage.ts'

/**
 * 让 `node:fs.createReadStream` 对**被点名的那个路径**返回一个立刻报错的流。
 *
 * 为什么必须打桩：中途中止的读错误（TOCTOU 删除 / EACCES / EIO）在 Windows
 * 上没法可靠地现场制造，而这件事要验的恰恰是"它来了之后进程还活着"。
 * `vi.hoisted` 是必须的——vi.mock 的工厂会被提到所有 import 之前。
 */
const fsFail = vi.hoisted(() => ({ path: '' }))

vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>()
  const { Readable } = await import('node:stream')
  return {
    ...real,
    createReadStream: ((p: Parameters<typeof real.createReadStream>[0], opts?: unknown) => {
      if (fsFail.path && String(p) === fsFail.path) {
        const s = new Readable({ read() {} })
        process.nextTick(() => s.emit('error', new Error('injected EIO')))
        return s as unknown as ReturnType<typeof real.createReadStream>
      }
      return real.createReadStream(p, opts as Parameters<typeof real.createReadStream>[1])
    }) as typeof real.createReadStream,
  }
})

const cfg: Config = {
  apiKey: 'sk-secret-must-not-leak',
  baseUrl: 'https://x.cn/v1',
  imageModel: 'm',
  vlmModel: 'v',
  port: 0,
  // 这个测试不碰数据库文件。写 :memory: 是为了明说"不会在磁盘上开文件"
  dbPath: ':memory:',
  // Config 上的必填字段（起服务要它），这个文件不碰图 —— 真建目录的是 newStorage
  photoDir: 'unused',
  // 签名钥匙：测试里随便一串就行，反正网络那头没有别人
  sessionSecret: 'test-session-secret',
}

// sn.ts 收窄之后，客户端吃的是「一条连接 + 一个模型名」，不再是整份 Config（Task 6）。
// Task 7 起连接是**按登录用户现拼**的（clientFor.ts），所以这个文件里已经没有
// "手搓一条连接"的地方了 —— 要造的客户端一律走下面的 `stubClients`。

let server: Server | undefined
/** 这个文件开出来的内存库。谁开谁关，跟 db.test.ts 一样。 */
const openedDbs: Db[] = []
/** 这个文件开出来的图片目录。同上 —— 测试跑完不留东西在临时目录里。 */
const openedDirs: string[] = []

afterEach(async () => {
  await new Promise<void>(r => server?.close(() => r()))
  while (openedDbs.length) openedDbs.pop()!.close()
  while (openedDirs.length) rmSync(openedDirs.pop()!, { recursive: true, force: true })
})

/**
 * 一套账号依赖：一个内存库 + 一把测试钥匙。
 *
 * 三个 AI 接口从这一版起要登录，所以**每次起 app 都必须给这个**——
 * `auth` 在 AppDeps 上是必填的：少接线要是编译错误，不是运行时 503。
 */
function newAuth(now: () => number = () => Date.now()): AccountDeps {
  const db = openDb(':memory:')
  openedDbs.push(db)
  return { db, secret: cfg.sessionSecret, now }
}

/**
 * 一套存储依赖：一个临时目录。
 *
 * `storage` 从这一版起也是 AppDeps 上的**必填**字段 —— 和 `auth` 同一个道理：
 * 少接一根线要是编译错误，而不是"图默默存不下来"这种没人看得见的运行时降级。
 * 每次起 app 都建一个新的：测试之间不共享目录，不然一个用例留下的文件
 * 会让另一个用例的"盘上应该正好有这几个文件"看着是对的。
 */
function newStorage(): Storage {
  const root = mkdtempSync(join(tmpdir(), 'ruixing-app-photos-'))
  openedDirs.push(root)
  return createStorage(root)
}

/** 只给下面那组"裸 socket 路径穿越"用例用的静态根。
 *  **诱饵在它的上一层** —— 穿出去才够得着。 */
const siteRoot = join(mkdtempSync(join(tmpdir(), 'ruixing-traversal-')), 'site')

async function boot(extra: Partial<AppDeps> = {}): Promise<string> {
  // `extra.auth ?? newAuth()`：调用方自带 auth 时就不再另开一个没人用的库
  const auth = extra.auth ?? newAuth()
  server = createApp({
    config: cfg, auth, storage: extra.storage ?? newStorage(),
    // 模型设置那一层。**和账号共用同一个库** —— model_configs 和 users 是同一件
    // 事的两半（两个指针就挂在 users 上），各开一个库会让"这条配置是谁的"有两个答案。
    // 保险箱的主钥匙照生产来：从 SESSION_SECRET 派生（用途分隔符见 keyvault.ts）。
    models: extra.models ?? { db: auth.db, vault: createVault(cfg.sessionSecret) },
    ...extra,
  })
  await new Promise<void>(r => server!.listen(0, r))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

/**
 * 起一个**已经登录过**的 app，返回它的 cookie。
 *
 * 三个 AI 接口从这一版起要登录 —— 所以原来那些直接打 /api/route 的用例
 * 全都会变成 401。与其在每个用例里手抄一遍注册流程，不如就这一个出口。
 *
 * ⚠️ 这里回的是 `base`（地址字符串）而不是 brief 原稿里的 `server`：
 * 这个文件拿地址一直是"`boot()` 返回字符串 + 模块级 `server` 由 afterEach 关"，
 * 多回一个 server 只会多出第二种关法。**不另发明一套。**
 */
async function appWithUser(
  extra: Partial<AppDeps> = {},
): Promise<{ base: string; cookie: string; auth: AccountDeps }> {
  const auth = newAuth()
  const base = await boot({ ...extra, auth })
  const r = await handleSignup({ username: '测试用户', email: 't@t.com', password: 'password123' }, auth)
  return { base, cookie: `${SESSION_COOKIE}=${r.token}`, auth }
}

/**
 * 起一个"票会变老"的 app：起点取此刻，之后全靠 `tick(天数)` 往前拨。
 *
 * 滑动续期的判据是"这张票还剩几天"—— 不把"现在几点"攥在手里就验不了它
 * （真实时钟下，一张 30 天的票永远"还剩 29 天多"）。
 * 起点用 `Date.now()` 而不是写死一个数字：比较全是相对的，日历走到哪一天都不影响，
 * 而 Set-Cookie 里的 Max-Age 会是真实的 30 天，不会变成一个看着可疑的 0。
 */
async function appWithAgingTicket(): Promise<{
  base: string
  cookie: string
  auth: AccountDeps
  tick: (days: number) => void
}> {
  const clock = { t: Date.now() }
  const auth = newAuth(() => clock.t)
  const base = await boot({ auth })
  const r = await handleSignup({ username: '老用户', email: 'o@o.com', password: 'password123' }, auth)
  return {
    base,
    cookie: `${SESSION_COOKIE}=${r.token}`,
    auth,
    tick: days => { clock.t += days * 86400_000 },
  }
}

/** 端点断言用的合法 /api/edit 请求体。 */
const editBody = {
  imageDataUrl: 'data:image/jpeg;base64,/9j/AA==',
  editPrompt: '删掉后面那个人',
  width: 1024,
  height: 768,
}

/**
 * 一套「用户接了自己模型」时三个 AI 接口要的依赖（Task 7）：**真实的**
 * SenseNovaClient，只把最后一跳的网络换成假 fetch。
 *
 * ⚠️ 注入点必须在 `clientFactory` 上，不能是"换掉最终那个客户端"——
 * 要验的是"它拿的是哪一套连接"，假客户端只有站在**拼连接的下游**才看得见
 * 出站请求头里到底是哪把钥匙（clientFor.ts 上那段注释说的同一件事）。
 *
 * `db` 特意新开一个空内存库：里面一条模型配置都没有，`resolveClients`
 * 于是永远回默认那一套 —— 这正是下面那些老用例要的"用户没配"。
 */
function stubClients(fetchImpl: typeof fetch): ClientDeps {
  return {
    db: newAuth().db, vault: createVault(cfg.sessionSecret), config: cfg,
    clientFactory: c => new SenseNovaClient(c, fetchImpl),
  }
}

/**
 * 桩上游：记下每次请求体，**不真出网**。`status !== 200` 时回一个带独特
 * 哨兵串的错误体——用来验证"上游原文不会漏进给用户的响应"。
 */
function stubUpstream(status = 200) {
  const calls: any[] = []
  const impl = (async (_u: any, init: any) => {
    calls.push(JSON.parse(init.body))
    return status === 200
      ? new Response('{"choices":[{"message":{"content":"{\\"cards\\":[]}"}}]}', { status: 200 })
      : new Response('{"error":{"message":"SENTINEL-UPSTREAM-BODY-c4d1"}}', { status })
  }) as unknown as typeof fetch
  return {
    calls,
    deps: { clients: stubClients(impl), queue: new SerialQueue({ sleep: async () => {} }) },
  }
}

async function post(base: string, path: string, body: unknown, cookie?: string) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() as { error?: { code: string; message: string } } }
}

/**
 * 通用的 JSON 调用 —— `post` 的普适版。
 *
 * 模型那五个接口里有三种 `post` 接不住的形状：不带体的 GET、不带体的 DELETE、
 * 以及 PATCH。`body === undefined` 时**既不送体、也不带 content-type** ——
 * 给 GET / DELETE 塞一个请求体正是 app.ts 那几条注释里说的"没什么可送的"。
 */
async function call(
  base: string, method: string, path: string, body?: unknown, cookie?: string,
): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

describe('createApp', () => {
  it('GET /api/health 返回 ok', async () => {
    const base = await boot()
    const r = await fetch(`${base}/api/health`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it('未知 /api 路径返回 404 的 JSON 错误，不是 HTML', async () => {
    const base = await boot()
    const r = await fetch(`${base}/api/nope`)
    expect(r.status).toBe(404)
    const body = await r.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_REQUEST')
  })

  it('任何响应体里都不能出现 API key', async () => {
    const base = await boot()
    for (const p of ['/api/health', '/api/nope']) {
      const r = await fetch(`${base}${p}`)
      expect(await r.text()).not.toContain('sk-secret-must-not-leak')
    }
  })

  it('非 /api 路径不回 JSON —— 那是静态资源的领地', async () => {
    const base = await boot()
    const r = await fetch(`${base}/some/asset.js`)
    expect(r.headers.get('content-type') ?? '').not.toContain('application/json')
  })

  it('POST /api/route 在没接客户端时返回 503 的结构化错误', async () => {
    // ⚠️ 必须**带着 cookie**打：鉴权守卫排在 503 守卫前面，没登录的人拿到的是 401
    // （那条路由「没登录打 AI 接口 → 401」钉着）。这一条问的是另一个人：
    // 登录过了、但后端没接线。
    const { base, cookie } = await appWithUser()
    const r = await fetch(`${base}/api/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,/9j/AA==', text: '亮一点' }),
    })
    expect(r.status).toBe(503)
    // tsconfig.server.json 的 lib 不含 DOM：Response.json() 是 unknown，
    // 断言形状跟本文件其它用例一致（Task 1 起的写法）。
    const body = await r.json() as { error: { code: string } }
    expect(body.error.code).toBe('INTERNAL')
  })

  it('POST /api/route 的请求体超限时不把内存吃光', async () => {
    // **必须注入 deps**：否则 503 守卫会先于 readJsonBody 触发，
    // 这条测试永远拿不到 413（brief 原稿的缺陷，已由控制方裁定）。
    // 这里不需要那个客户端真的能工作——只要 `clients` 在、守卫放行。
    // 同理**必须带着 cookie**：鉴权守卫排在 413 那道之前。
    const { base, cookie } = await appWithUser({
      clients: stubClients((async () => new Response('{}')) as unknown as typeof fetch),
      queue: new SerialQueue({ sleep: async () => {} }),
    })
    const r = await fetch(`${base}/api/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(13 * 1024 * 1024), text: 'x' }),
    })
    expect(r.status).toBe(413)
  })

  it('POST /api/suggest 在没接客户端时返回 503 的结构化错误', async () => {
    const { base, cookie } = await appWithUser()
    const r = await post(base, '/api/suggest', { imageDataUrl: 'data:image/jpeg;base64,/9j/AA==' }, cookie)
    expect(r.status).toBe(503)
    expect(r.body.error!.code).toBe('INTERNAL')
  })

  it('POST /api/edit 在没接客户端时返回 503 的结构化错误', async () => {
    const { base, cookie } = await appWithUser()
    const r = await post(base, '/api/edit', editBody, cookie)
    expect(r.status).toBe(503)
    expect(r.body.error!.code).toBe('INTERNAL')
  })

  it('POST /api/suggest 接上客户端后确实走进了 handler（400 是 handler 给的，且没出网）', async () => {
    const { deps, calls } = stubUpstream()
    const { base, cookie } = await appWithUser(deps)
    const r = await post(base, '/api/suggest', {}, cookie)
    expect(r.status).toBe(400)
    expect(r.body.error!.message).toContain('imageDataUrl')
    expect(calls).toHaveLength(0)
  })

  it('POST /api/edit 接上客户端后确实走进了 handler（不合规尺寸在本地就拒掉，一次 API 都不调）', async () => {
    const { deps, calls } = stubUpstream()
    const { base, cookie } = await appWithUser(deps)
    const r = await post(base, '/api/edit', { ...editBody, width: 1000 }, cookie)
    expect(r.status).toBe(400)
    expect(r.body.error!.message).toContain('图片尺寸 1000x768')
    expect(calls).toHaveLength(0)
  })

  it('POST /api/edit 上游 429 -> 503 UPSTREAM_LIMIT，上游原文只进日志', async () => {
    const { deps, calls } = stubUpstream(429)
    const { base, cookie } = await appWithUser(deps)
    const r = await fetch(`${base}/api/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(editBody),
    })
    expect(r.status).toBe(503)
    const text = await r.text()
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe('UPSTREAM_LIMIT')
    expect(text).not.toContain('SENTINEL-UPSTREAM-BODY-c4d1')
    expect(calls.length).toBeGreaterThan(0)   // 是上游真的挂了，不是本地拒的
  })

  /**
   * ★ 2026-09-30 加：**上游不认这把钥匙**时的出口（用户点名的场景 ——
   * "用户自己接入模型接不通给他提示不就好了"）。
   *
   * 原来 401/403 和别的 4xx 一起归 BAD_REQUEST，于是用户自己的钥匙填错时，
   * 屏幕上出现的是 **「这次请求有点问题，换个说法试试」** ——
   * 一句话把"钥匙不对"说成了"你说的话不对"。他改一百遍措辞也没用。
   */
  it('★ POST /api/edit 上游 401（钥匙被拒）-> 502 UPSTREAM_AUTH，文案指去查钥匙，**不叫**用户换说法', async () => {
    // 上游原文（那句 invalid api key）会被打进服务端日志，测试里静音掉，别糊住输出
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { deps, calls } = stubUpstream(401)
      const { base, cookie } = await appWithUser(deps)
      const r = await fetch(`${base}/api/edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(editBody),
      })
      // 502：**不是**我们自己的 401（那是"先登录一下"），失败发生在上游那一段
      expect(r.status).toBe(502)
      const text = await r.text()
      const body = JSON.parse(text) as { error: { code: string; message: string } }
      expect(body.error.code).toBe('UPSTREAM_AUTH')
      expect(body.error.message).toContain('钥匙')
      // ★ 这条用例存在的理由：钥匙不对的人不该被告知"换个说法试试"
      expect(body.error.message).not.toContain('换个说法')
      // 上游原文只进服务端日志（http.ts 那段注释：那是英文运维口径，不能弹给用户）
      expect(text).not.toContain('SENTINEL-UPSTREAM-BODY-c4d1')
      // ★ 恰好一次：被拒的钥匙**不能重试**。队列默认 4 次尝试 ——
      //   哪天它被标成可重试，这里会变成 4，用户白等 3 个来回还多花 3 次钱。
      expect(calls).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('静态文件读流出错时只毁掉那一个响应，进程还活着', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ruixing-static-'))
    try {
      writeFileSync(join(dir, 'index.html'), '<h1>ok</h1>')
      fsFail.path = join(dir, 'index.html')
      const base = await boot({ staticDir: dir })

      // 响应头已经发出去了（200），正文是随后流的——流一炸，
      // 客户端应该看到"读正文失败"，而不是一个把服务进程带走的未捕获异常。
      await expect(
        fetch(`${base}/index.html`).then(r => r.text()),
      ).rejects.toThrow()

      // 真正的断言：进程还活着，别的请求照常服务。
      const health = await fetch(`${base}/api/health`)
      expect(health.status).toBe(200)
    } finally {
      fsFail.path = ''
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('账号与鉴权', () => {
  const routeBody = { imageDataUrl: 'data:image/jpeg;base64,x', text: '亮一点', params: {} }

  it('没登录打 AI 接口 → 401，而且请求体根本没被读', async () => {
    const { base } = await appWithUser()   // 只用它起服务器，不带 cookie
    const res = await fetch(`${base}/api/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(routeBody),
    })
    // 这个 app **没有接线**（上面没传 clients/queue），所以 401 这个数字本身
    // 还说明了一件事：鉴权排在"后端没配置模型客户端"那道 503 之前 ——
    // 顺序反了，没登录的人看到的会是 503，而"没登录"和"部署没接线"是两回事。
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    // 走的是那条统一的错误形状：前端按 code 分流，不能因为这是"另一种 401"
    // 就变成一个前端认不出的东西。
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('★ 没登录的请求连"读体"这一步都不该走到：三个 AI 接口都是 401，不是 400', async () => {
    // ⚠️ brief 把"requireUser 挪到 readJsonBody 之后"列为**单线程测试抓不住**，
    // 其实抓得住 —— 顺序会改变应答码。这条把 clients/queue 都接上，就是为了让
    // 中间**只剩** readJsonBody 这一道：顺序反了，这个畸形请求体会把"没登录"
    // 这个更重要的结局盖成"你的 JSON 不对"（400）。
    // 三个接口走一遍，是因为那句守卫在这三处**各写了一遍** —— 抄漏一处，
    // 只验其中一处的那种写法看不出来。
    // 真正抓不住的只是"服务器到底缓冲了多少字节"（12 MB 那件事）—— 那只能靠 code review。
    const { deps } = stubUpstream()
    const { base } = await appWithUser(deps)
    for (const p of ['/api/route', '/api/suggest', '/api/edit']) {
      const res = await fetch(`${base}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '这根本不是 JSON',
      })
      expect(res.status, `${p} 的请求体在鉴权之前就被读了`).toBe(401)
    }
  })

  it('带 cookie 就能过 —— 栽在"没接线"那一步，而不是 401', async () => {
    const { base, cookie } = await appWithUser()
    const res = await fetch(`${base}/api/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(routeBody),
    })
    // 写成确切的 503（brief 原稿是 `not.toBe(401)`）：503 说明它**过了鉴权**、
    // 栽在"后端没接线"那一步。`not.toBe(401)` 连 500 都算过，问不出这件事。
    expect(res.status).toBe(503)
  })

  it('注册 → 自动登录（响应里带 Set-Cookie）', async () => {
    const { base } = await appWithUser()
    const res = await fetch(`${base}/api/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '新来的', email: 'n@n.com', password: 'password123' }),
    })
    expect(res.status).toBe(200)
    const sc = res.headers.get('set-cookie') ?? ''
    expect(sc).toContain(`${SESSION_COOKIE}=`)
    expect(sc).toContain('HttpOnly')
  })

  it('★ 响应里绝不含密码或哈希', async () => {
    const { base } = await appWithUser()
    const res = await fetch(`${base}/api/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '不漏', email: 'l@l.com', password: 'password123' }),
    })
    const text = await res.text()
    expect(text).not.toContain('password123')
    expect(text).not.toContain('scrypt$')
    // ★ 光查上面两个串还不够 —— 它们只认得"哈希的模样"。响应体的**形状**
    // 也得钉住，理由是一个真变异：把这一句的 `r.user` 写成整个 `r`，
    // 上面两句**一句都不会红**（`handleSignup` 的返回值里没有哈希，哈希只在
    // 签名的输入里），但票会多送一份进响应体，而前端要的那一层 `user` 当场消失。
    // 所以这里比的是**键名清单**：多一个键、少一个键都是红。
    const body = JSON.parse(text) as { user: Record<string, unknown> }
    expect(Object.keys(body)).toEqual(['user'])
    expect(Object.keys(body.user).sort()).toEqual(['email', 'id', 'username'])
  })

  it('登录 → 拿到的 cookie 能用来问「我是谁」', async () => {
    const { base } = await appWithUser()
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '测试用户', password: 'password123' }),
    })
    expect(login.status).toBe(200)
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!
    const me = await fetch(`${base}/api/me`, { headers: { cookie } })
    expect(me.status).toBe(200)
    const body = await me.json() as any
    expect(body.user.username).toBe('测试用户')
    expect(JSON.stringify(body)).not.toContain('scrypt$')
  })

  it('没登录问「我是谁」→ 401', async () => {
    const { base } = await appWithUser()
    const me = await fetch(`${base}/api/me`)
    expect(me.status).toBe(401)
  })

  it('没登录打「改密码」→ 401，而且是同一个 UNAUTHORIZED', async () => {
    // 原来只有「我是谁」这一处问了"没登录会怎样"，而 /api/password 走的是同一道
    // requireUser —— 它管的是**改密码**（改成了就能把别人踢下线、把账号接管走）。
    // 没有这条用例，改成"这道守卫漏了 / 顺序被谁挪到 readJsonBody 后面"照样全绿。
    const { base } = await appWithUser()
    const res = await fetch(`${base}/api/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oldPassword: 'password123', newPassword: 'anotherpass' }),
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    // 前端按 code 分流（401 → 回登录页），所以这里也要是那个认得出的 code
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('没登录不能存作品 —— 401，不是 500、也不是默默存下来', async () => {
    // ⚠️ brief 原稿写的是 `const { base } = await boot()` —— 而 `boot` 回的是
    // **地址字符串**，不是一个带 `base` 的对象（解构出来是 undefined，
    // 报的是 `Failed to parse URL from undefined/api/works`）。
    // 要地址就直接接住它；**不为了迁就原稿去改 boot 的返回形状**（那会牵动全文件）。
    const base = await boot()
    const r = await fetch(`${base}/api/works`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: 'data:image/jpeg;base64,/9j/AA==' }),
    })
    expect(r.status).toBe(401)
  })

  it('取图要登录；路径不匹配的（多一截）也是 404，不是把别人的东西给出去', async () => {
    const { base } = await appWithUser()
    expect((await fetch(`${base}/api/works/1/file`)).status).toBe(401)
    expect((await fetch(`${base}/api/works/1/file/../../etc`)).status).toBe(404)
  })

  it('退出 → cookie 被清掉', async () => {
    const { base, cookie } = await appWithUser()
    const res = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=0')
  })

  it('改密码之后，旧 cookie 立刻不好使了', async () => {
    const { base, cookie } = await appWithUser()
    const ok = await fetch(`${base}/api/me`, { headers: { cookie } })
    expect(ok.status).toBe(200)

    const changed = await fetch(`${base}/api/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ oldPassword: 'password123', newPassword: 'anotherpass' }),
    })
    expect(changed.status).toBe(200)

    // ★ 用**旧** cookie 再问一次 —— 必须 401。这就是"所有设备下线"
    const again = await fetch(`${base}/api/me`, { headers: { cookie } })
    expect(again.status).toBe(401)

    // 而响应里给的新 cookie 是好使的
    const fresh = (changed.headers.get('set-cookie') ?? '').split(';')[0]!
    const after = await fetch(`${base}/api/me`, { headers: { cookie: fresh } })
    expect(after.status).toBe(200)
  })
})

describe('★ 滑动续期：票撑不过 15 天就换一张（设计文档 §6.5）', () => {
  it('票还剩够久 → 一个字都不动它（响应里没有 Set-Cookie）', async () => {
    const { base, cookie, tick } = await appWithAgingTicket()
    tick(10)   // 30 - 10：还剩 20 天，在 15 天那条线外面
    const r = await fetch(`${base}/api/me`, { headers: { cookie } })
    expect(r.status).toBe(200)
    // 断言的是**没有这个头**。设计文档 §6.5 要避免的正是"每个请求都写一次 cookie"，
    // 而这件事只有这里在问 —— 缺了它，一个"每个请求都重签一张"的实现全绿。
    expect(r.headers.get('set-cookie')).toBeNull()
  })

  it('票快到期了就换一张，新票把 30 天重新推满', async () => {
    const { base, cookie, tick } = await appWithAgingTicket()
    const me = (c: string) => fetch(`${base}/api/me`, { headers: { cookie: c } })

    tick(20)   // 只剩 10 天，踩进 15 天以内
    const r = await me(cookie)
    expect(r.status).toBe(200)
    const fresh = (r.headers.get('set-cookie') ?? '').split(';')[0]!
    expect(fresh).toContain(`${SESSION_COOKIE}=`)
    // 真的换了一张 —— 不是把原来那条原样写回去
    expect(fresh).not.toBe(cookie)

    // 新票接着能用
    tick(1)
    const again = await me(fresh)
    expect(again.status).toBe(200)
    // ★ 换完这一次之后**不该再写**：否则就成了"每个请求都写一次 cookie"。
    // 这里的节流**不记在任何状态里** —— 它是"新票还剩 29 天"这个事实自己推出来的，
    // 所以下面这句同时也在钉住那条推理（判据在，节流就在）。
    expect(again.headers.get('set-cookie')).toBeNull()

    // ★ 窗口真的被推满了：从换票那一刻再走 20 天，这张新票还好使。
    // 少了这一条，"换票"可能只是拿**同一个过期时间**又签了一遍 ——
    // 那样 Set-Cookie 有、新票也能用，但滑动窗口一点也没滑。
    // （没有续期的话，原票在签出的第 30 天就到期了，这里必是 401。）
    tick(20)
    expect((await me(fresh)).status).toBe(200)
  })
})

describe('取图：真的把字节发出去', () => {
  it('存一张 → GET /api/works/:id/file 回 200 + image/jpeg + 字节数对', async () => {
    // 这条钉的是取图这条路的**最后一环**：路由接对了 handler、`sendBytes` 的头和正文都对。
    // 上面那两条取图用例只走到 401 / 404 —— `sendBytes`（Task 4 加的）一行都没被它们碰到过，
    // 而它是"图真的回到浏览器"的唯一出口。
    const { base, cookie } = await appWithUser()
    const b64 = b64Of(jpegBytes(64))
    const created = await post(base, '/api/works', { image: `data:image/jpeg;base64,${b64}` }, cookie)
    expect(created.status).toBe(200)
    const id = (created.body as unknown as { id: number }).id

    const r = await fetch(`${base}/api/works/${id}/file`, { headers: { cookie } })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/jpeg')
    // 断言的是**真的那 64 个字节**，不是一个"有响应体"的空壳：
    // 少了它，一个"回 200 但正文是空 / 是 JSON"的实现照样绿
    expect((await r.arrayBuffer()).byteLength).toBe(64)
  })

  it('★ 多一截的路径必须 404 —— 四条路由正则的**锚定**终于有人在守（终审 I2）', async () => {
    // ★ 这条补的是**锚定本身**。四条路由正则（`fileRoute` / `thumbRoute` / `oneRoute`，
    //   `app.ts:206/215/230`）全都锚着整串，而**把那四个 `^…$` 全去掉，整个套件原来
    //   是一片绿的**：唯一那条多段路径（上面那条 `/file/../../etc`）在 **fetch 那头**
    //   就被归一化成 `/api/works/etc`，**走不到正则跟前**（Task 5 的注解里写明了这件事，
    //   却顺手捎上一句"app.test.ts 里那条抓的正是它" —— 那句是**假的**，被抓的
    //   那条正是它自己刚判定走不到跟前的那条）。
    //
    //   为什么值得一条用例：不锚定的 `/\/api\/works\/(\d+)/` 今天只影响"多一截"这种
    //   畸形路径（没人这么请求），但它是**将来会被撞上的不变量** —— 下一段往
    //   `/api/works/:id` 底下加第二条子路由（`/presets`、`/luts` 那种形状）时，
    //   `oneRoute` 会**静默抢走**它，而那时候红的是别的功能的用例，没人会想到是这儿。
    //
    // ⚠️ **必须先真的存一张、并先证明它取得回来。** 库里没有这张作品时，`/file/`
    //   本来也会 404（"没有这张作品"），不锚定的实现在这条用例上照样绿 ——
    //   有图才有"200 + 把图给出去"那条岔路可走。
    const { base, cookie } = await appWithUser()
    const b64 = b64Of(jpegBytes(64))
    const created = await post(base, '/api/works', { image: `data:image/jpeg;base64,${b64}` }, cookie)
    expect(created.status).toBe(200)
    const id = (created.body as unknown as { id: number }).id

    // 正面对照：这张图真的取得到。少了它，下面四条 404 可能只是因为图根本不在。
    expect((await fetch(`${base}/api/works/${id}/file`, { headers: { cookie } })).status).toBe(200)

    // 变异（**逐条实测过**，不是推的；Vitest 只报一个 `it` 里第一条失败的断言，
    // 所以下面说的是"哪一条先红"）：
    //   · 只去掉 `fileRoute` 的 `^…$` → 第 1 条（`/file/`）先红；
    //   · 只去掉 `thumbRoute` 的 → 前两条绿、第 3 条（`/thumb/x`）先红
    //     （`handleWorkThumb` 没有缩略图就退回原图，所以它回的是 200 + 那张图）；
    //   · 只去掉 `oneRoute` 的 → **第 1 条就红**：它排在最后、也最宽松，
    //     `/file/`、`/file/x`、`/thumb/x` 全被它抢走（回的是详情 JSON）。
    //     单看最后那条（`/x`）也够 —— 把它单独留下跑过，一样红。
    //   —— 那正是"静默抢走"的样子，也是下一段往 `/api/works/:id` 底下加
    //   `/presets` 那种子路由时会撞上的事（那时候红的会是别的功能的用例）。
    //   · 三个都去掉 → 整条用例红（这一轮先跑的正是这个）。
    expect((await fetch(`${base}/api/works/${id}/file/`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${base}/api/works/${id}/file/x`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${base}/api/works/${id}/thumb/x`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${base}/api/works/${id}/x`, { headers: { cookie } })).status).toBe(404)
  })
})

describe('列表：路由真的接上了', () => {
  it('没登录 → 401；登录了、库里空的 → 200 + { works: [] }', async () => {
    // 这条守的**不是**数据隔离（那是 works.test.ts 里「列表：只有自己的」那条的事）——
    // 守的是"这条路由真的挂上了"：把 app.ts 里那一整块删掉、或者把方法或路径敲错，
    // 别的用例一条都不会红（一个 404 看着就像"本来就没有这个接口"）。
    //
    // 空库要回的是**空数组**，不是 null、也不是 404 —— 客户端靠它区分
    // "这个人的作品集是空的"和"列表接口坏了"。这两件事对用户是两种界面。
    const { base, cookie } = await appWithUser()

    expect((await fetch(`${base}/api/works`)).status).toBe(401)

    const r = await fetch(`${base}/api/works`, { headers: { cookie } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ works: [] })
  })
})

describe('详情与改名：路由真的接上了', () => {
  it('GET 没登录 → 401；登录了、id 不存在 → 404（而且是"没有这张作品"，不是"没有这个接口"）', async () => {
    // 和上面那条列表一样，守的**只是接线**：把 app.ts 里那两块删掉、或者方法或路径敲错，
    // 别处一条都不会红。数据隔离那半归 works.test.ts（「改别人的名字 → 当它不存在」），
    // 一个不带 `WHERE user_id` 的实现也能过这条 —— 没关系，两件事各归各的用例。
    const { base, cookie } = await appWithUser()

    expect((await fetch(`${base}/api/works/1`)).status).toBe(401)

    const r = await fetch(`${base}/api/works/1`, { headers: { cookie } })
    expect(r.status).toBe(404)
    // ★ 光有 404 不够：路由**整块不见**的时候，兜底那句也是 404。两句文案不一样 ——
    // 这里点的是 handler 说的"没有这张作品"，不是路由没挂时说的"没有这个接口"，
    // 少了这一句，"路由其实没挂上"和"挂上了、这张作品不在"长得一模一样。
    const body = await r.json() as { error: { message: string } }
    expect(body.error.message).toContain('没有这张作品')
  })

  it('PATCH 没登录 → 401，而且请求体根本没被读', async () => {
    // ⚠️ 故意送一个**畸形**请求体：认人排在读体前面，顺序反了它当场变成 400，
    // "没登录"这个更重要的结局就被盖掉了（和 AI 接口那几条是同一条规矩）。
    // 这也是这两条路由里**唯一**看得见"先认人再读体"的东西。
    const { base } = await appWithUser()
    const r = await fetch(`${base}/api/works/1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '这根本不是 JSON',
    })
    expect(r.status).toBe(401)
  })
})

describe('删与替换：路由真的接上了', () => {
  it('三条新路由没登录都是 401（两条读体的，请求体根本没被读）', async () => {
    // 列表、详情改名、加上这三条 —— 同一个洞第三次出现：把 app.ts 里那三块 `if`
    // 删掉、或者方法/路径敲错，别处一条都不会红（一个 404 看着就像"本来就没有这个接口"）。
    // 401 同时说明两件事：路由挂上了，而且认人接上了。
    //
    // ⚠️ PUT 和 POST 那两条故意送**畸形**请求体：认人排在读体前面，顺序反了它当场
    // 变 400，"没登录"这个更重要的结局就被盖掉（同 PATCH 那条）。DELETE 不读体，
    // 没什么可送的。
    const { base } = await appWithUser()

    const del = await fetch(`${base}/api/works/1`, { method: 'DELETE' })
    expect(del.status).toBe(401)

    const put = await fetch(`${base}/api/works/1`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '这根本不是 JSON',
    })
    expect(put.status).toBe(401)

    const bulk = await fetch(`${base}/api/works/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '这根本不是 JSON',
    })
    expect(bulk.status).toBe(401)
  })

  it('DELETE 一个不存在的 id → 404，而且是「没有这张作品」，不是「没有这个接口」', async () => {
    // ★ 光有 404 不够：路由**整块不见**的时候，兜底那句**也是 404**。两句文案不一样 ——
    // 这里点的是 handler 说的"没有这张作品"，不是路由没挂时说的"没有这个接口"，
    // 少了这一句，"路由其实没挂上"和"挂上了、这张作品不在"长得一模一样。
    //
    // 数据隔离那半归 works.test.ts（「删别人的 → 拒，而且他的一动没动」）——
    // 这条只守接线，一个不带 `WHERE user_id` 的实现也能过它，两件事各归各的用例。
    const { base, cookie } = await appWithUser()
    const r = await fetch(`${base}/api/works/1`, { method: 'DELETE', headers: { cookie } })
    expect(r.status).toBe(404)
    const body = await r.json() as { error: { message: string } }
    expect(body.error.message).toContain('没有这张作品')
  })

  it('★ DELETE 和 PUT 的成功路径真的走通了（不是只挂了个块）', async () => {
    // 上面两条只证明"块在"和"认人接上了"：一个把 id 传错（`Number(undefined)`）、
    // 或者干脆回个空 200 的实现，它们一条都不会红。这条把整条路走完：
    // 存 → 删掉 → **再取就没了**；存 → 换 → **取回来的是新那批字节**。
    const { base, cookie } = await appWithUser()
    // ⚠️ 长度**恰好 n**（下面按字节数断言），所以是"拿文件头覆盖前几字节"，
    //    不是"在前面插一段" —— 而文件头本身必须是真的（imagedata.ts 验魔数）。
    const image = (n: number): string => `data:image/jpeg;base64,${b64Of(jpegBytes(n))}`
    const make = async (n: number): Promise<number> => {
      const created = await post(base, '/api/works', { image: image(n) }, cookie)
      expect(created.status).toBe(200)
      return (created.body as unknown as { id: number }).id
    }

    // ① DELETE /api/works/:id
    const doomed = await make(64)
    const del = await fetch(`${base}/api/works/${doomed}`, { method: 'DELETE', headers: { cookie } })
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true })
    // ★ 不只是"回了个 200"：那张作品真的没了
    expect((await fetch(`${base}/api/works/${doomed}`, { headers: { cookie } })).status).toBe(404)

    // ② PUT /api/works/:id
    const kept = await make(64)
    const put = await fetch(`${base}/api/works/${kept}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ image: image(128) }),
    })
    expect(put.status).toBe(200)
    const meta = await put.json() as { id: number; bytes: number }
    expect(meta.id).toBe(kept)        // ★ id 不变（外面存着的链接不能失效）
    expect(meta.bytes).toBe(128)
    // ★ 取回来的**真的是新那 128 个字节** —— 不是旧的留在那儿、只把数字改了
    const file = await fetch(`${base}/api/works/${kept}/file`, { headers: { cookie } })
    expect((await file.arrayBuffer()).byteLength).toBe(128)
  })

  it('★ 批量删的成功路径真的走通了（回的是 deleted / missing 两个桶）', async () => {
    const { base, cookie } = await appWithUser()
    const b64 = b64Of(jpegBytes(64))
    const make = async (): Promise<number> => {
      const created = await post(base, '/api/works', { image: `data:image/jpeg;base64,${b64}` }, cookie)
      expect(created.status).toBe(200)
      return (created.body as unknown as { id: number }).id
    }
    const a = await make()
    const b = await make()

    const r = await fetch(`${base}/api/works/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids: [a, b, 99999] }),
    })

    expect(r.status).toBe(200)
    // ★ 两个桶都在：删掉的按请求顺序列出来，"本来就不在"的那个**也报出来**（§3.5：不能静默）
    expect(await r.json()).toEqual({ deleted: [a, b], missing: [99999] })
    expect(await (await fetch(`${base}/api/works`, { headers: { cookie } })).json()).toEqual({ works: [] })
  })
})

describe('/api/models', () => {
  const BODY = {
    kind: 'chat', provider: 'custom', baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-abcdefghijklmnop-4f2', modelId: 'm', alias: '我的便宜货',
  }

  /**
   * 两张表的**整表快照** —— 一行不带 `user_id` 过滤，因为要钉的是"谁的都不许动"。
   *
   * ⚠️ 为什么非要看库、而不是"再 GET 一次看看"：T3 用变异测试证明过一条
   * **照样回 404** 的坏实现 —— `activateConfig` 的 UPDATE 挪到属主检查前面：
   * 请求回 404，但指针**已经被写歪了**。抓这种实现只有一条路：请求前后对库拍照。
   *
   * 带上 `api_key_enc`（`SELECT *`）也不多余：顺手钉住"没有谁偷偷把它重封一遍"。
   */
  const snapshot = (db: Db) => ({
    configs: db.raw.prepare('SELECT * FROM model_configs ORDER BY id').all(),
    pointers: db.raw.prepare(
      'SELECT id, active_chat_config_id, active_image_config_id FROM users ORDER BY id',
    ).all(),
  })

  it('★ 没登录 → 401，而且比读请求体更早', async () => {
    const { base } = await appWithUser()   // 只用它起服务器，不带 cookie
    // GET / DELETE 不读体，没登录就是 401
    expect((await call(base, 'GET', '/api/models')).status).toBe(401)
    expect((await call(base, 'DELETE', '/api/models/1')).status).toBe(401)
    // ★ 读体的那三条故意送**畸形**请求体：认人排在读体前面，顺序反了当场变 400、
    //   "没登录"这个更重要的结局就被盖掉（和三个 AI 接口那条是同一条规矩）。
    //   少了这一段，这个用例标题里"比读请求体更早"那半句一个字都没被验到。
    for (const [m, p] of [
      ['POST', '/api/models'], ['POST', '/api/models/activate'],
      ['POST', '/api/models/test'], ['PATCH', '/api/models/1'],
    ] as const) {
      const r = await fetch(`${base}${p}`, {
        method: m, headers: { 'content-type': 'application/json' }, body: '这根本不是 JSON',
      })
      expect(r.status, `${m} ${p} 的请求体在鉴权之前就被读了`).toBe(401)
    }
  })

  it('建 → 列 → 改 → 删 走一遍', async () => {
    const { base, cookie } = await appWithUser()
    const c = await call(base, 'POST', '/api/models', BODY, cookie)
    expect(c.status).toBe(200)
    const made = c.body as { id: number; keyHint: string }

    const list = await call(base, 'GET', '/api/models', undefined, cookie)
    expect(list.status).toBe(200)
    expect((list.body as { configs: unknown[] }).configs).toHaveLength(1)

    const patched = await call(base, 'PATCH', `/api/models/${made.id}`, { kind: 'chat', alias: '改名了' }, cookie)
    expect(patched.status).toBe(200)
    expect((patched.body as { alias: string }).alias).toBe('改名了')

    const del = await call(base, 'DELETE', `/api/models/${made.id}`, undefined, cookie)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ wasActive: false })
    // ★ 不只是"回了个 { wasActive: false }"：那一行**真的没了**。
    //   少了这一句，一个"把值原样回出去、根本没删"的实现照样绿。
    expect((await call(base, 'GET', '/api/models', undefined, cookie)).body).toEqual({ configs: [] })
  })

  it('★ 响应里不许出现完整钥匙 —— 全链路（§10）', async () => {
    const { base, cookie } = await appWithUser()
    const c = await call(base, 'POST', '/api/models', BODY, cookie)
    // 三种"回配置"的响应都走一遍 —— "全链路"指的就是它们（少了 PATCH 这条，
    // patch 路上漏钥匙的实现照样绿）。
    const id = (c.body as { id: number }).id
    const patched = await call(base, 'PATCH', `/api/models/${id}`, { alias: '换个名字' }, cookie)
    const list = await call(base, 'GET', '/api/models', undefined, cookie)
    for (const r of [c, patched, list]) {
      expect(JSON.stringify(r.body)).not.toContain('abcdefghijklmnop')
    }
    // ★ 另一半：钥匙**存下来了**，只是只露前 3 后 4（`maskKey` 的规矩）。
    //   少了这一句，一个"创建时把钥匙整个丢了、keyHint 回空串"的实现也满足上面三行 ——
    //   而那种实现的后果是"用户配了钥匙、一次都没用上"，最安静的那种坏。
    expect(JSON.stringify(list.body)).toContain('sk-…-4f2')
  })

  it('★ 别人的那一套：改 / 删 / 激活一律 404（不是 403），而且谁的数据都没动', async () => {
    // 「不存在」和「不是你的」必须是同一个结局：分开处理等于告诉人
    // 哪些 id 是真的、只是不归你（§6.1）。所以钉的是 404，不是 403。
    const { base, auth, cookie: mine } = await appWithUser()
    // 第二个人：**同一个 app、同一个库**，只是另一张票 ——
    // 照 appWithUser 内部那一句写（同一个 auth 上再注册一个，就是"另一个人"）。
    const other = await handleSignup(
      { username: '对面的人', email: 'other@t.com', password: 'password123' }, auth,
    )
    const theirs = `${SESSION_COOKIE}=${other.token}`

    const c = await call(base, 'POST', '/api/models', BODY, mine)
    expect(c.status).toBe(200)
    const id = (c.body as { id: number }).id

    const before = snapshot(auth.db)

    expect((await call(base, 'PATCH', `/api/models/${id}`, { kind: 'chat', alias: 'x' }, theirs)).status).toBe(404)
    expect((await call(base, 'DELETE', `/api/models/${id}`, undefined, theirs)).status).toBe(404)
    expect((await call(base, 'POST', '/api/models/activate', { kind: 'chat', id }, theirs)).status).toBe(404)

    // ★ 状态码之外的**第二半**，就是这条用例的重点：三条路各自的坏实现都会"先写后判"——
    //   DELETE 先删再判 → 那一行没了；PATCH 先 UPDATE 再判 → alias 变了；
    //   activate 先写指针再判 → 写歪的是**发起人自己**的 active_chat_config_id。
    //   三种都不影响上面那三个 404，只有这张快照抓得住。
    expect(snapshot(auth.db)).toEqual(before)

    // 正面对照：同样的操作，**主人自己做**是通的 ——
    // 少了它，上面三个 404 可能只是因为接口整个坏了（那也是一种"别人没动"）。
    expect((await call(base, 'PATCH', `/api/models/${id}`, { alias: '我的' }, mine)).status).toBe(200)
    expect((await call(base, 'POST', '/api/models/activate', { kind: 'chat', id }, mine)).status).toBe(200)
  })

  it('★ 激活别的 kind 的那一套 → 404（指针不许串场）', async () => {
    const { base, auth, cookie } = await appWithUser()
    const img = await call(base, 'POST', '/api/models', { ...BODY, kind: 'image' }, cookie)
    expect(img.status).toBe(200)
    const id = (img.body as { id: number }).id

    // ★ 这里也必须看库：一个"先写 chat 指针、再检查 kind"的实现照样回 404，
    //   但那张**图**配置已经被写成 chat 的当前选择了 —— 而且这条歪指针在列表上
    //   看不出来（`listConfigs` 的 active 是 chat / image 各算各的），
    //   它只在真正取钥匙出图的那一刻才咬人。
    const before = snapshot(auth.db)

    expect((await call(base, 'POST', '/api/models/activate', { kind: 'chat', id }, cookie)).status).toBe(404)
    expect(snapshot(auth.db)).toEqual(before)
  })

  it('★ 「测一下」：别人的 id / 不存在的 id → 404，空钥匙 → 400（都在出网之前）', async () => {
    const { base, auth, cookie: mine } = await appWithUser()
    const other = await handleSignup(
      { username: '对面的人', email: 'other@t.com', password: 'password123' }, auth,
    )
    const theirs = `${SESSION_COOKIE}=${other.token}`
    const c = await call(base, 'POST', '/api/models', BODY, mine)
    const id = (c.body as { id: number }).id

    // ★ 别人的那一套和「没有这个 id」必须是同一个结局（§6.1）——
    //   分开处理等于告诉人哪些 id 是真的、只是不归你。
    //   这一条钉的是 `resolveSecretById` 的 user_id：少了它，"测一下"就成了
    //   一个借别人的地址和钥匙去探路的接口。
    const denied = await call(base, 'POST', '/api/models/test', { id, kind: 'chat' }, theirs)
    expect(denied.status).toBe(404)
    expect((denied.body as { error: { message: string } }).error.message).toContain('没有这一套设置')
    expect((await call(base, 'POST', '/api/models/test', { id: 99999, kind: 'chat' }, mine)).status).toBe(404)

    // 没保存的表单那条路上，钥匙是必填 —— 空着当场 400。放它过去只会换来一句
    // 「钥匙不认」，把人指到"去检查钥匙"那个错的方向上。
    expect((await call(base, 'POST', '/api/models/test',
      { baseUrl: 'https://api.example.com/v1', apiKey: '   ' }, mine)).status).toBe(400)
  })

  it('★ 「测一下」真的走通了：打的是 /models、带的是库里那把钥匙 —— 两种调用方式', async () => {
    // ⚠️ 这个用例必须把 `globalThis.fetch` 拦住：路由那句 `probeConnection(conn)`
    //   用的是**全局 fetch**（没有注入口，brief 就是这么定的 —— 注入口要一路穿过
    //   AppDeps，为一条测试不值得）。不拦的话它是真的去连 api.example.com ——
    //   一个依赖外网的测试比没有测试更糟。只拦这一个域名，这个用例自己打向
    //   127.0.0.1 的请求原样放行。
    const { base, cookie } = await appWithUser()
    const c = await call(base, 'POST', '/api/models', BODY, cookie)
    const id = (c.body as { id: number }).id

    const realFetch = globalThis.fetch
    const seen: { url: string; auth: string | undefined }[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (url.startsWith('http://127.0.0.1:')) return realFetch(url, init)
      if (!url.startsWith('https://api.example.com/')) {
        // 宁可当场炸掉，也别让一个拼歪的地址真的出网。
        // ⚠️ 这个 throw 会被 probeConnection 自己的 catch 吞成"连不上" ——
        //   所以那条拼歪的地址也要**先记进 seen**：不然失败信息里根本看不见它。
        seen.push({ url, auth: undefined })
        throw new Error(`这条用例没拦住的请求：${url}`)
      }
      seen.push({ url, auth: (init.headers as Record<string, string> | undefined)?.authorization })
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      // ① 已经存过的那一套：只给 id，拿库里那把（解密出来的）钥匙去测
      const byId = await call(base, 'POST', '/api/models/test', { id, kind: 'chat' }, cookie)
      expect(byId.status).toBe(200)
      expect(byId.body).toEqual({ ok: true, models: ['m'] })
      // ★ 打的是 `${baseUrl}/models`，带的是**完整**钥匙 —— 不是列表里那把掩码过的
      //   （少了后半句，一个"拿 keyHint 去请求"的实现照样绿，而它永远 401）
      expect(seen[0]).toEqual({
        url: 'https://api.example.com/v1/models', auth: 'Bearer sk-abcdefghijklmnop-4f2',
      })

      // ② 表单里刚敲进去、**还没保存**的那一份：参数直接带上来
      //    （LobeChat 的教训：不偷偷"先存后测"，那样测的是上次保存的值）
      const live = await call(base, 'POST', '/api/models/test',
        { baseUrl: 'api.example.com', apiKey: ' sk-live ' }, cookie)
      expect(live.status).toBe(200)
      // 这一段顺带钉住两条"替用户擦屁股"的规矩：补 https:// 和 /v1、钥匙去空格
      expect(seen[1]).toEqual({ url: 'https://api.example.com/v1/models', auth: 'Bearer sk-live' })

      // ★ 「不偷偷保存」不是靠嘴说的：库里**还是只有一条**配置。
      //   少了这一句，一个"先把表单存下来再测"的实现照样绿 —— 而它会往库里写进
      //   一套用户可能根本不想要的配置。
      const list = await call(base, 'GET', '/api/models', undefined, cookie)
      expect((list.body as { configs: unknown[] }).configs).toHaveLength(1)
    } finally {
      // 用例之间不共享这个替换（这个文件里别的用例要发真请求）
      globalThis.fetch = realFetch
    }
  })
})

/**
 * ★ §7.4 ——「用户带自己的钥匙」这件事到底生效没有，只有下面这四条说了算。
 *
 * 断言看的是**真发出去的那条请求**（URL + Authorization 头）：那才是
 * 「用了谁的钥匙」的唯一证据。断言"调了哪个 mock"是自欺欺人 —— 假客户端
 * 可以被塞对，而请求头里的钥匙仍然是错的。所以这里注入的是一条**真实的
 * SenseNovaClient**（真的拼 URL、真的带请求头），只有最后一跳的网络是假的。
 */
describe('★ 两套 key 彻底分开（§7.4，用户点名要的四条；⑤ 是 Task 11 补的）', () => {
  // 这一份测试里的"默认那一套"就是 cfg（生产上 baseUrl 指向 token.sensenova.cn）。
  // 下面凡说"走默认"的断言比的都是它，不写死域名 —— 默认换地址时测试跟着走。
  const CHAT = { kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat', modelId: 'vlm', alias: '甲' }
  const IMAGE = { kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-img', modelId: 'edit', alias: '乙' }
  /** ④ 里那把"填错了"的图片钥匙：上游见到它就回 401。 */
  const TYPO = 'sk-img-typo'

  /** 演示用的 /api/route 请求体（上一个 describe 里的 routeBody 在别的作用域，不共用）。 */
  const askBody = { imageDataUrl: 'data:image/jpeg;base64,/9j/AA==', text: '亮一点' }

  type Outbound = { url: string; auth: string | undefined }

  /**
   * 记下每一次真被发出去的上游请求，并按 URL 回一个**形状对得上**的最小响应：
   * route 那条要 `choices[0].message.content`，edit 那条要 `data[0].b64_json`。
   * 形状给错会让 handler 走降级那条路（状态码也许还是 200）—— 那是另一回事，
   * 不该混进这四条里。
   *
   * `reject` = 上游"不认这把钥匙"（401）。④ 用它模拟"图片那把 key 填错了"。
   */
  function recordingFetch(calls: Outbound[],
                          reject?: (auth: string | undefined) => boolean): typeof fetch {
    return (async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string> | undefined)?.authorization
      calls.push({ url: String(url), auth })
      if (reject?.(auth)) {
        return new Response('{"error":{"message":"invalid api key"}}', { status: 401 })
      }
      return String(url).endsWith('/images/edits')
        ? new Response('{"data":[{"b64_json":"AAAA"}]}', { status: 200 })
        : new Response(
          '{"choices":[{"message":{"content":"{\\"route\\":\\"params\\",\\"param_deltas\\":{\\"exposure\\":10},\\"reply\\":\\"好\\"}"}}]}',
          { status: 200 })
    }) as unknown as typeof fetch
  }

  /**
   * 起一个 app。`clients.db` 和 `models.db` 是**同一个库**（`boot` 的默认行为）——
   * 否则"设置里存的那一套"和"取钥匙时看到的那个库"是两回事，测试就假了。
   */
  async function appWithRecording(opts: { reject?: (auth: string | undefined) => boolean } = {}) {
    const calls: Outbound[] = []
    const auth = newAuth()
    const base = await boot({
      auth,
      queue: new SerialQueue({ sleep: async () => {} }),
      clients: {
        db: auth.db, vault: createVault(cfg.sessionSecret), config: cfg,
        clientFactory: c => new SenseNovaClient(c, recordingFetch(calls, opts.reject)),
      },
    })
    const r = await handleSignup({ username: '测试用户', email: 't@t.com', password: 'password123' }, auth)
    const cookie = `${SESSION_COOKIE}=${r.token}`
    /** 走真接口建一套配置并激活 —— 用户就是这么做的（不是直接往库里塞）。 */
    const addAndActivate = async (body: typeof CHAT | typeof IMAGE): Promise<void> => {
      const made = await call(base, 'POST', '/api/models', body, cookie)
      expect(made.status).toBe(200)
      expect((await call(base, 'POST', '/api/models/activate',
        { kind: body.kind, id: (made.body as { id: number }).id }, cookie)).status).toBe(200)
    }
    return { base, cookie, calls, addAndActivate }
  }

  it('① 只配了图片 → 对话照常能用（走默认那一套）', async () => {
    const { base, cookie, calls, addAndActivate } = await appWithRecording()
    await addAndActivate(IMAGE)   // 用户只配了图片那一套

    expect((await post(base, '/api/route', askBody, cookie)).status).toBe(200)

    // ★ 上游 URL 是**默认那个**、Authorization 是**默认那把钥匙**。
    //   一个"顺手拿用户配的那一套去打对话"的实现，这里出现的是
    //   img.example.com / sk-img，当场红。
    expect(calls).toEqual([{ url: `${cfg.baseUrl}/chat/completions`, auth: `Bearer ${cfg.apiKey}` }])
  })

  it('② 只配了对话 → 图片照常能用（走默认那一套）', async () => {
    const { base, cookie, calls, addAndActivate } = await appWithRecording()
    await addAndActivate(CHAT)

    expect((await post(base, '/api/edit', editBody, cookie)).status).toBe(200)

    expect(calls).toEqual([{ url: `${cfg.baseUrl}/images/edits`, auth: `Bearer ${cfg.apiKey}` }])
  })

  it('③ 两边都配了 → 各走各的，绝不串', async () => {
    const { base, cookie, calls, addAndActivate } = await appWithRecording()
    await addAndActivate(CHAT)
    await addAndActivate(IMAGE)

    expect((await post(base, '/api/route', askBody, cookie)).status).toBe(200)
    expect((await post(base, '/api/edit', editBody, cookie)).status).toBe(200)

    // ★ 两条请求各自打到自己那一套的地址、带自己那一把钥匙。
    //   把 chat / image 写反（route 拿了 image 的连接、或者反过来），
    //   或者两处共用一个客户端，这两行必红。
    expect(calls).toEqual([
      { url: 'https://chat.example.com/v1/chat/completions', auth: 'Bearer sk-chat' },
      { url: 'https://img.example.com/v1/images/edits', auth: 'Bearer sk-img' },
    ])
  })

  it('★ ④ 图片的 key 填错了 → 对话完全不受影响', async () => {
    // 上游只守一条规矩：见到那把填错的图片钥匙就 401。
    const { base, cookie, calls, addAndActivate } =
      await appWithRecording({ reject: a => a === `Bearer ${TYPO}` })
    await addAndActivate(CHAT)
    await addAndActivate({ ...IMAGE, apiKey: TYPO })

    // 第一次：改图。它走的是图片那一套 → 上游 401 → 这次请求失败
    // （http.ts 那张表把上游 401/403 映射成 502 UPSTREAM_AUTH —— 不是 503，也不是 200）。
    // ⚠️ 2026-09-30 改过：原来是 400 BAD_REQUEST。两者长得像（都是"这次请求没成"），
    //    但文案完全不同 —— BAD_REQUEST 会说「这次请求有点问题，换个说法试试」，
    //    而这里是**钥匙被拒**，让用户去改措辞是句假话（见上面那条新用例）。
    //    这条断言在这里还多管一件事：**分得清**是"上游拒了钥匙"还是"本地校验挂了"。
    const edit = await post(base, '/api/edit', editBody, cookie)
    expect(edit.status).toBe(502)
    expect(edit.body.error!.code).toBe('UPSTREAM_AUTH')

    // ★ 第二次：对话。**必须照常成功**，而且出站用的仍然是 chat 那把钥匙。
    const route = await post(base, '/api/route', askBody, cookie)
    expect(route.status).toBe(200)
    // ⚠️ 光看状态码不够：handleRoute 会把上游失败吞成 degraded 降级、照样回 200 ——
    //    一个"route 也拿了图片客户端"的实现在上一句上也是绿的。
    //    degraded=false 钉的是"这次结果是模型老实给的"，也就是那条对话真的走通了。
    expect((route.body as unknown as { decision: { degraded: boolean } }).decision.degraded).toBe(false)

    expect(calls).toEqual([
      // 那次失败确实是**图片那一套**造成的：URL 和坏钥匙都在里面。
      { url: 'https://img.example.com/v1/images/edits', auth: `Bearer ${TYPO}` },
      // ★ 紧接着这条对话：打的是 chat 那一套、带的是那把好钥匙。
      //   两条路各自独立 —— 这就是"图片的 key 填错了，对话完全不受影响"。
      { url: 'https://chat.example.com/v1/chat/completions', auth: 'Bearer sk-chat' },
    ])
  })

  /**
   * ★ ⑤ `/api/suggest` 也必须走 **chat** 那一套（Task 11 补）。
   *
   * 这张网原来漏着：把那一路的 `const { chat } = resolveClients(...)` 改成
   * `image`，**整个套件一条都不红**。原因是别处验它的时候用户没配过模型，
   * 两个 kind 那时候只有 `modelId` 不同，而没有任何断言读 `modelId`
   * （URL 和钥匙都是我们自己的那一份，一模一样）。
   *
   * 所以这条和上面四条同一种做法：**两个类别都配上，各带各的地址和钥匙**，
   * 再断言"真发出去的那一条上游请求"用的是哪一套。
   * ⚠️ 这就是 §7.4 那四条唯一的证据形式（裁定 9）：断言**出站的 URL + Authorization**，
   *    不是"断言调了哪个 mock"—— 后者在"拿对了连接但拼错了客户端"时照样绿。
   *
   * 变异：把 `server/app.ts` 里 `/api/suggest` 那一支的 `{ chat }` 换成 `{ image }`
   *      → 出站变成 img.example.com / sk-img，这条红。
   */
  it('★ ⑤ /api/suggest 走的是对话那一套（和 route 同一条路，不是图片那一套）', async () => {
    const { base, cookie, calls, addAndActivate } = await appWithRecording()
    await addAndActivate(CHAT)
    await addAndActivate(IMAGE)

    expect((await post(base, '/api/suggest',
      { imageDataUrl: askBody.imageDataUrl }, cookie)).status).toBe(200)

    // ★ 只有一条出站请求，而且是 chat 那一套。
    //   接错成 image 时这里是 img.example.com / sk-img，当场红。
    expect(calls).toEqual([
      { url: 'https://chat.example.com/v1/chat/completions', auth: 'Bearer sk-chat' },
    ])
  })
})

describe('会话接口', () => {
  /** 第二个用户。`appWithUser` 只建第一个，第二个往同一个 auth 里再注册一次。 */
  async function twoUsers() {
    const a = await appWithUser()
    const b = await handleSignup({ username: '小红', email: 'r@r.com', password: 'password123' }, a.auth)
    return { base: a.base, auth: a.auth, cookieA: a.cookie, cookieB: `${SESSION_COOKIE}=${b.token}` }
  }
  const JPEG = 'data:image/jpeg;base64,/9j/'

  it('★ 没登录 → 401，而不是 400 —— 鉴权排在读体之前', async () => {
    // 判据和上面那条 AI 接口的用例**同一个套路**：送一个畸形体。
    // 顺序反了的话，畸形体会把"没登录"盖成"你的 JSON 不对"。
    const { base } = await appWithUser()
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '这根本不是 JSON',
    })
    expect(res.status).toBe(401)
  })

  it('★ 别人的会话：取 / 改 / 删一律 404，且**两张表一个字节都没动**', async () => {
    const { base, auth, cookieA, cookieB } = await twoUsers()
    const mine = await call(base, 'POST', '/api/sessions', { image: JPEG }, cookieA)
    const id = (mine.body as { id: number }).id

    const snap = () => JSON.stringify({
      sessions: auth.db.raw.prepare('SELECT * FROM sessions ORDER BY id').all(),
      works: auth.db.raw.prepare('SELECT * FROM works ORDER BY id').all(),
    })
    const before = snap()

    expect((await call(base, 'GET', `/api/sessions/${id}`, undefined, cookieB)).status).toBe(404)
    expect((await call(base, 'PUT', `/api/sessions/${id}`, { title: '偷来的' }, cookieB)).status).toBe(404)
    expect((await call(base, 'DELETE', `/api/sessions/${id}`, undefined, cookieB)).status).toBe(404)
    expect((await call(base, 'GET', `/api/sessions/${id}/file/original`, undefined, cookieB)).status).toBe(404)
    expect((await call(base, 'GET', `/api/sessions/${id}/thumb`, undefined, cookieB)).status).toBe(404)

    // ★★ 这一句才是真判据。上面那五个 404 只说明"应答码对"，而**改坏了数据
    //    再回 404** 也全是 404（上面那五个照样全绿）。
    expect(snap()).toBe(before)
    // 顺带确认它真的还在（别把"被删掉了所以 404"当成通过）
    expect((await call(base, 'GET', `/api/sessions/${id}`, undefined, cookieA)).status).toBe(200)
  })

  it('★ GET / DELETE 不读请求体 —— 挂着一个永远不结束的体，也该立刻回', async () => {
    // 这条守的是 Global Constraints 里那句"读它只会挂住等一个永远不会来的流"。
    // 用手搓的 http 请求（`fetch` 没法半开着体不发）：先发头、发半截体，然后**不 end**。
    // 路由要是读了体，响应就永远不来 —— 所以判据是"超时之前拿到了响应"。
    const { base, cookieA } = await twoUsers()
    const mine = await call(base, 'POST', '/api/sessions', { image: JPEG }, cookieA)
    const id = (mine.body as { id: number }).id

    for (const method of ['GET', 'DELETE'] as const) {
      const status = await new Promise<number>((resolve, reject) => {
        // ⚠️ 闹钟在**成功那条路**上也要收掉（clearTimeout）：不收的话 vitest 会抱怨
        //    有个句柄没关。先声明、后赋值 —— 响应回调最早也要等到下一个 tick 才跑，
        //    那一刻 timer 早就赋好了。
        let timer: ReturnType<typeof setTimeout>
        const req = request(
          `${base}/api/sessions/${id}`,
          { method, headers: { cookie: cookieA, 'transfer-encoding': 'chunked' } },
          (res) => {
            res.resume()
            clearTimeout(timer)
            resolve(res.statusCode!)
            // ⚠️ 光把闹钟收掉还不够：这条连接**还是半开的**（请求体永远不 end），
            //    不收掉它，afterEach 里那句 `server.close()` 会一直等这个连接，
            //    整个文件挂在那儿跑不完。destroy 的是**客户端这一头**，
            //    服务端的应答已经发出来了，不影响上面那句断言。
            req.destroy()
          },
        )
        req.on('error', reject)
        req.write('{"title":')      // ← 半截 JSON，而且绝不 end()
        timer = setTimeout(() => { req.destroy(); reject(new Error(`${method} 挂住了：它读了请求体`)) }, 3000)
      })
      expect(status, `${method} 的响应没回来`).toBeLessThan(500)
    }
  })

  // ── 下面两条是 Task 1 评审点名补的覆盖缺口 ──────────────────────────────
  // Task 1 只测了建 / 取 / 改 / 删四件事，而 `handleListSessions`、
  // `handleSessionStepFile`（**唯一一条真能走到 `requireOwnFile` 的路**）、
  // `toSteps` 的 `reusesPrev`、`stepCount` 全程**没有任何自动化覆盖** ——
  // 而它们错了不会报错，只会静静地错（列表少一条、步骤图给错一张、
  // 「回到这一步」跳错地方）。
  it('★ 列表：只出自己的，按 updated_at 倒序，而且**不带硬盘文件名**', async () => {
    const { base, auth, cookieA, cookieB } = await twoUsers()
    const a1 = (await call(base, 'POST', '/api/sessions', { image: JPEG, name: '甲.jpg' }, cookieA))
    // ⚠️ 两次建会话之间也要隔开：`created_at` 落在**同一个毫秒**时，
    //    `ORDER BY created_at DESC/ASC` 的变异会跟正确实现给出一样的顺序、两相全绿 ——
    //    "created_at 那一半"就退化成看运气（实测 back-to-back 的 POST 约有 2% 撞上）。
    //    id 那一半不用等：AUTOINCREMENT 保证甲 < 乙 是结构性的。
    await new Promise(r => setTimeout(r, 5))
    const a2 = (await call(base, 'POST', '/api/sessions', { image: JPEG, name: '乙.jpg' }, cookieA))
    await call(base, 'POST', '/api/sessions', { image: JPEG, name: '别人的.jpg' }, cookieB)
    const idA1 = (a1.body as { id: number }).id
    const idA2 = (a2.body as { id: number }).id
    // ★ 这条属性（"按**最后动过**的时间倒序"）要**两相**才问得住 —— 一个也别删、
    //    也别"简化"回单相，单相无论动哪一条都漏一个静默的洞：
    //    · 只动**后建**那条（期望 [乙, 甲]）：`ORDER BY id DESC` 和
    //      `ORDER BY created_at DESC` 在这套夹具上给出**同一个答案**，照样绿；
    //    · 只动**先建**那条（期望 [甲, 乙]）：`ORDER BY id ASC` 和
    //      `ORDER BY created_at ASC` 照样绿。
    //    也就是说"最后动过"和"创建时间 / 编号"在单相里**分不开**，而分不开的
    //    那个洞正好是用户能看见的 bug：列表写着"最近改的在最前"，实际按创建时间排，
    //    改过的旧会话永远沉底。两相合起来才把四个都逼红 —— 前提是下面那三处
    //    显式等待都在（各自实测过，见 task-2-report §8）。
    // ⚠️ 这条用例里那**三处** `setTimeout(…, 5)` 缺一不可，别当多余删掉 ——
    //    它们逼出的是**严格**先后：建甲建乙之间那格保证 `created_at 甲 < created_at 乙`，
    //    两次 PUT 前那两格保证 `updated_at` 也一路严格递增。少了任何一格，"时间序"
    //    就会退化成并列（并列时退回落库序），上面那句"两相合起来把四个都逼红"
    //    就变成**看运气**而不是结构性成立。id 不用等：AUTOINCREMENT 是结构性的。
    const listed = async () => (await call(base, 'GET', '/api/sessions', undefined, cookieA))
      .body as { sessions: {
        id: number; title: string | null; originalName: string | null; stepCount: number
      }[] }

    // 相 1：动**先建**的甲 —— 它必须顶到最前（时间倒序 = [甲, 乙]）。
    // 这一相专门逼红 `id DESC` / `created_at DESC`（它们在相 2 里恰好和答案一致）。
    await new Promise(r => setTimeout(r, 5))
    await call(base, 'PUT', `/api/sessions/${idA1}`, { title: '刚改过' }, cookieA)
    expect((await listed()).sessions.map(r => r.id)).toEqual([idA1, idA2])

    // 相 2：接着动**后建**的乙 —— 现在轮到它顶到最前（时间倒序 = [乙, 甲]）。
    // 这一相专门逼红 `id ASC` / `created_at ASC`（它们在相 1 里恰好和答案一致）。
    await new Promise(r => setTimeout(r, 5))
    await call(base, 'PUT', `/api/sessions/${idA2}`, { title: '也改过了' }, cookieA)
    const last = await listed()
    const rows = last.sessions
    expect(rows.map(r => r.id)).toEqual([idA2, idA1])   // 倒序 + 只有自己的
    expect(rows[0]!.originalName).toBe('乙.jpg')
    expect(rows.every(r => r.stepCount === 0)).toBe(true)

    // ⚠️ Global Constraints 那句"`stored_name` 这类硬盘上的文件名永远不许出门"。
    //    判据是**拿库里那三个真值去比**，不是拿照片名去比 —— `originalName`
    //    **本来就该出门**（它是用户自己的文件名，不是 storage 起的不透明名字）。
    const diskNames = auth.db.raw
      .prepare('SELECT original, base, thumb FROM sessions WHERE user_id = 1').all() as
      { original: string; base: string; thumb: string | null }[]
    const body = JSON.stringify(last)
    for (const n of diskNames.flatMap(r => [r.original, r.base, r.thumb])) {
      if (n) expect(body, `硬盘文件名 ${n} 漏出去了`).not.toContain(n)
    }
  })

  it('★ 某一步的图：自己的给 200（而且是**那一步自己的**那张），别人的和不存在的都 404', async () => {
    const { base, cookieA, cookieB } = await twoUsers()
    const mine = await call(base, 'POST', '/api/sessions', { image: JPEG }, cookieA)   // 原图 3 字节
    const id = (mine.body as { id: number }).id
    // ⚠️ 这次 PUT 故意送**两张图**、两个步骤：按 mergeSteps 的规矩 ③，新文件只落在
    //    **最后一个新步骤**上，于是第 1 步照规矩 ① 留在原图上（3 字节），而 base
    //    换成了新那张（4 字节）。少了这一手，"回的是那一步自己的图"和"无脑回 base"
    //    两种实现在下面那三句上长得一模一样 —— 而"步骤图给错一张"正是这条用例
    //    要守的那件事（见上面那段覆盖缺口的说明）。
    const NEW = 'data:image/jpeg;base64,/9j/AA=='   // 4 字节（FF D8 FF 00），和原图那 3 个区分得开
    await call(base, 'PUT', `/api/sessions/${id}`, {
      base: NEW,
      steps: [{ id: 1, label: '调色', params: {}, at: 1 }, { id: 2, label: '再来一步', params: {}, at: 2 }],
    }, cookieA)

    const url = `/api/sessions/${id}/file/step/1`
    // ⚠️ 这条 200 不能用 `call`：它回的是**图片字节**，而 `call` 每次都 `r.json()`
    //    （那会当场 SyntaxError）。取图那两条用例也是这么写的 —— 手搓 fetch，
    //    顺带把 contentType 和字节数钉住（不然"回 200 但正文是空"照样绿）。
    const own = await fetch(`${base}${url}`, { headers: { cookie: cookieA } })
    expect(own.status).toBe(200)
    expect(own.headers.get('content-type')).toBe('image/jpeg')
    expect((await own.arrayBuffer()).byteLength).toBe(3)
    // ★ 底图是**另外 4 个字节** —— 所以上面那个 3 证明的才是"这一步自己的图"，
    //   而不是"凡是 step 就回 base"。
    const baseNow = await fetch(`${base}/api/sessions/${id}/file/base`, { headers: { cookie: cookieA } })
    expect((await baseNow.arrayBuffer()).byteLength).toBe(4)
    // 别人的、和不存在的（这两条 404 是 JSON，`call` 用得上）：**同一个结局** ——
    // 不存在的步不能"退回 base"、也不能给一张空图。
    expect((await call(base, 'GET', url, undefined, cookieB)).status).toBe(404)
    expect((await call(base, 'GET', `/api/sessions/${id}/file/step/999`, undefined, cookieA)).status)
      .toBe(404)
  })

  it('★ 步骤列表：`reusesPrev` 只在"接着上一步那张图"时为 true（列表上那个「几步」也跟着走）', async () => {
    // ★ 这条补的是 Task 1 评审点名的四个零覆盖里的最后一个。上面两条钉住了
    //   `handleListSessions` / `handleSessionStepFile` / `stepCount`（0 那一半），
    //   而 `toSteps` 那三行（`sessions.ts:136`）**整个仓库一条断言都没有** ——
    //   错了既不报错也不 4xx：`false` 时客户端白下一次图、白解一次码，
    //   而**该 false 的写成 true** 更糟 —— 界面会把两张不同的图当成同一张，
    //   「回到这一步」跳回去看到的是错的画面。
    const { base, cookieA } = await twoUsers()
    const mine = await call(base, 'POST', '/api/sessions', { image: JPEG }, cookieA)
    const id = (mine.body as { id: number }).id
    await call(base, 'PUT', `/api/sessions/${id}`, {
      base: 'data:image/jpeg;base64,/9j/AQIDBA==', steps: [{ id: 1, label: '调色', params: {}, at: 1 }],
    }, cookieA)
    // 第二次**不带图**（拖滑块那种）：新的一步按规矩 ③ 接着上一步那张
    await call(base, 'PUT', `/api/sessions/${id}`, {
      steps: [
        { id: 1, label: '调色', params: {}, at: 1 },
        { id: 2, label: '再亮一点', params: {}, at: 2 },
      ],
    }, cookieA)

    const detail = await call(base, 'GET', `/api/sessions/${id}`, undefined, cookieA)
    const steps = (detail.body as { steps: { id: number; reusesPrev: boolean }[] }).steps
    expect(steps.map(s => s.id)).toEqual([1, 2])
    // 第 1 步没有上一步（永远 false），第 2 步和它共用一张图 → true
    expect(steps.map(s => s.reusesPrev)).toEqual([false, true])
    // 顺带把非零的 `stepCount` 钉住 —— 列表那条只验了 0 那一半，
    // 一个写死 `stepCount: 0` 的实现在它上面照样绿。
    expect((detail.body as { stepCount: number }).stepCount).toBe(2)
  })

  it('★ 删 / 原图 / 缩略图 三条的成功路径真的走通了（不是只挂了个块）', async () => {
    // ★ 上面那几条都只走到 404 —— 而**兜底那句也是 404**：把 app.ts 里这三块 `if`
    //   整块删掉、或者方法/路径敲错，上面一条都不会红（"本来就没有这个接口"和
    //   "没有这条会话"长得一模一样）。作品那组为同一个洞写过「★ DELETE 和 PUT 的
    //   成功路径真的走通了」，这里是它的会话版。
    const { base, cookieA } = await twoUsers()
    const mine = await call(base, 'POST', '/api/sessions', { image: JPEG }, cookieA)   // 原图 3 字节
    const id = (mine.body as { id: number }).id
    // 把底图换成另外 4 个字节 —— 下面"原图那一条回的是**上传时那张**"才有得比。
    await call(base, 'PUT', `/api/sessions/${id}`, { base: 'data:image/jpeg;base64,/9j/AQIDBA==' }, cookieA)

    // ① 原图：是上传时那张（3 字节），不是现在的底图（4 字节）。
    //    顺带钉住 `original` 这个分支真的接上了（正则里少写一个 `original` 就 404）。
    const orig = await fetch(`${base}/api/sessions/${id}/file/original`, { headers: { cookie: cookieA } })
    expect(orig.status).toBe(200)
    expect((await orig.arrayBuffer()).byteLength).toBe(3)

    // ② 缩略图：这条**没存过 thumb** → 按规矩兜底回原图，而且同样是 200
    //    （`handleSessionThumb` 那条 `row.thumb ?? row.original` 的兜底）。
    const thumb = await fetch(`${base}/api/sessions/${id}/thumb`, { headers: { cookie: cookieA } })
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get('content-type')).toBe('image/jpeg')
    expect((await thumb.arrayBuffer()).byteLength).toBe(3)

    // ③ 删：回的是 `{ ok: true }`，而且**真的没了**（不是回个 200 就算）
    const del = await call(base, 'DELETE', `/api/sessions/${id}`, undefined, cookieA)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })
    expect((await call(base, 'GET', `/api/sessions/${id}`, undefined, cookieA)).status).toBe(404)
  })

  it('★★ 改一次 → updated_at 必须往前走（缩略图的缓存钥匙靠它），而且**真的落库**了', async () => {
    // ★ 这条是 Task 2 评审后补的，形状照 `works.test.ts` 那条
    //   「★★ 替换真的把 updated_at **写进库**了」抄 —— 同一类 bug、同一条理由：
    //   `updated_at` 不只是"上次改的时间"，**它同时是缩略图 URL 的版本号**
    //   （`handleUpdateSession` 上面那段注释说的就是这个）。忘了 bump 不会报错、
    //   不会 4xx、日志里什么都没有 —— 用户只是**静默地**一直看到 `immutable`
    //   缓存里那张旧缩略图，直到缓存过期为止。
    //
    // ⚠️ 和作品那条一样：`handleUpdateSession` 回给你的那个 `updatedAt` 是**内存里
    //    拼的**（`toMeta({ ...row, updated_at: t })`），不是从库里读回来的 ——
    //    所以**光断言响应**挡不住"UPDATE 里根本没写 updated_at"的实现（它照样绿）；
    //    库里那一行才是 `?v=` 真正吃进去的那一份，必须单独钉。
    const { base, auth, cookieA } = await twoUsers()
    const made = await call(base, 'POST', '/api/sessions', { image: JPEG }, cookieA)
    const id = (made.body as { id: number }).id
    // 读的是**列表接口**（它每次都从库里读），不是 PUT 的返回值 —— 免得自己骗自己
    const at = async () => {
      const l = await call(base, 'GET', '/api/sessions', undefined, cookieA)
      return (l.body as { sessions: { id: number; updatedAt: number }[] })
        .sessions.find(s => s.id === id)!.updatedAt
    }
    const t0 = await at()
    // ⚠️ 光 `await` 不保证时钟往前走（同一毫秒内两次调用是常事），所以显式等一格 ——
    //    否则这条测试会**偶发地红**，比没有更糟。
    await new Promise(r => setTimeout(r, 5))
    const put = await call(base, 'PUT', `/api/sessions/${id}`, { title: '改过了' }, cookieA)
    const t1 = await at()
    expect(t1).toBeGreaterThan(t0)                                  // ★ 列表上那个数往前走了
    // ★ 落库那一半：库里那一行必须**就是**列表给你的那个数（响应好看不算数）。
    //   变异（实测过）：删掉 UPDATE 里的 `updated_at = ?` → 上面第一句就红（列表读的是库）；
    //   而**只断言 PUT 响应**的那一版在这个变异下**照样绿**（works 那条「★★ 替换真的把
    //   updated_at 写进库了」说的就是这件事）—— 所以下面这两句是必须的，不是啰嗦。
    const row = auth.db.raw.prepare('SELECT updated_at FROM sessions WHERE id = ?')
      .get(id) as { updated_at: number }
    expect(row.updated_at).toBe(t1)                                 // ★ 库里的数 = 列表给的那个
    expect((put.body as { updatedAt: number }).updatedAt).toBe(t1)  // 响应 = 库，两个方向都对上
  })

  it('★ 多一截的路径必须 404 —— 三条路由正则的**锚定**终于有人在守', async () => {
    // ★ 和作品那条「多一截的路径必须 404（终审 I2）」同一个形状。锚定是 Global
    //   Constraints 里的一条（`/api/works/1/file/../../etc` 那件事），而**把
    //   app.ts 里会话这三个 `^…$` 全去掉，原来的套件一条都不会红** ——
    //   会话这边此前没有任何用例问过"多一截会怎样"。
    //
    // ⚠️ 那条 `..` 路径在这里同样**不能用**：`fetch` 在发出之前就把 `/file/../../etc`
    //   归一化掉了，请求根本走不到正则跟前（作品那边踩过这个坑）—— 真正抓锚定的
    //   是下面这些"多一截"的路径。
    //
    // ⚠️ **必须先真的建一条会话、并先证明它取得回来。** 库里没有这条时，下面几条
    //   本来也会 404（"没有这条会话"），不锚定的实现在这条用例上照样绿 ——
    //   有会话、有步骤，才有"200 + 把图给出去"那条岔路可走。
    const { base, cookieA } = await twoUsers()
    const mine = await call(base, 'POST', '/api/sessions', { image: JPEG }, cookieA)
    const id = (mine.body as { id: number }).id
    // 放一步进去：`/file/step/1/x` 那句要咬住的是**内层** `step\/(\d+)` 的锚定，
    // 没有第 1 步时它两种实现都 404（"没有这一步"），咬不动。
    await call(base, 'PUT', `/api/sessions/${id}`, {
      steps: [{ id: 1, label: '调色', params: {}, at: 1 }],
    }, cookieA)

    // 正面对照：这些路径真的通（否则下面一片 404 全是"本来就没有"）
    expect((await call(base, 'GET', `/api/sessions/${id}`, undefined, cookieA)).status).toBe(200)
    expect((await fetch(`${base}/api/sessions/${id}/file/base`, { headers: { cookie: cookieA } })).status)
      .toBe(200)
    expect((await fetch(`${base}/api/sessions/${id}/file/step/1`, { headers: { cookie: cookieA } })).status)
      .toBe(200)

    // 变异（三条都实测过；Vitest 只报第一条失败的断言）：
    //   · 只去掉 `sessionFileRoute` 的 `^…$` → **第 3 句**（`/file/step/1/x`）先红，
    //     而且回的是 200 + 图片字节 —— 内层 `step\/(\d+)` 锚不住了，匹配到 `step/1`
    //     就收工。但 `/file/`、`/file/x` 两句**照样绿**：外层那三个并列词还得出
    //     现一个才匹配得上，"完不完整"它管不着（所以这两句用的是 `call`，
    //     它们永远走 JSON）。
    //   · 只去掉 `sessionThumbRoute` 的 `^…$` → 前两句绿、`/thumb/x` 先红
    //     （这条会话没存过 thumb，兜底回原图 → 200 + 那张图）。
    //   · 只去掉 `sessionOneRoute` 的 `^…$`  → **第 1 句就红**：它最宽松，而它在
    //     app.ts 里排在最后，`/file/`、`/thumb/x`、`/x` 全被它抢走，回的是详情
    //     JSON —— 这就是"静默抢走"的样子，也正是以后往 `/api/sessions/:id` 底下
    //     加子路由（比如会话历史 `/messages`）时会撞上的事。
    expect((await call(base, 'GET', `/api/sessions/${id}/file/`, undefined, cookieA)).status).toBe(404)
    expect((await call(base, 'GET', `/api/sessions/${id}/file/x`, undefined, cookieA)).status).toBe(404)
    // ⚠️ 下面这两句用裸 fetch：正则失守时它们回的是**图片字节**（200），用 `call`
    //    会先炸在 `r.json()` 上（报 SyntaxError，看不出"本该 404"）—— 裸 fetch 才让
    //    失败信息读作干干净净的 `expected 200 to be 404`。
    const cutStep = await fetch(`${base}/api/sessions/${id}/file/step/1/x`, { headers: { cookie: cookieA } })
    expect(cutStep.status).toBe(404)
    const cutThumb = await fetch(`${base}/api/sessions/${id}/thumb/x`, { headers: { cookie: cookieA } })
    expect(cutThumb.status).toBe(404)
    expect((await call(base, 'GET', `/api/sessions/${id}/x`, undefined, cookieA)).status).toBe(404)
  })
})

/**
 * ★ 2026-10-02 加（安全审计 H2 / S3）。
 *
 * 在那之前 `/api/login` **一个失败计数都没有** —— 无锁定、无退避，而接口还主动
 * 回答"这个账号存不存在"。字典可以慢慢试密码，这个项目最恨的那种静默失守
 * （界面上一切正常，只是有人在门外一把把试钥匙）就长在这里。
 */
describe('★ 限流：登录、注册、探活', () => {
  const WRONG = { username: '查无此人', password: 'whatever-1234' }

  it('★ 同一个账号连打十次 → 第十一次是 429，而且说得出还要等多久', async () => {
    const base = await boot({ auth: newAuth() })
    for (let i = 0; i < 10; i++) {
      const r = await post(base, '/api/login', WRONG)
      // 前 ten 次是"没这个账号"，不是限流 —— 先钉住这个前提，
      // 不然下面那条 429 可能只是别的东西坏了
      expect(r.status).toBe(400)
    }
    const r = await post(base, '/api/login', WRONG)
    expect(r.status).toBe(429)
    expect(r.body.error?.code).toBe('TOO_MANY')
    // 文案规范 5：哪不对 + 怎么办。而"怎么办"里必须有个**人算得出来的时间**
    // （900 秒没人算得出是多久）。
    expect(r.body.error?.message).toMatch(/等 .*(分钟|秒)再试/)
  })

  it('★ 限的是**那个账号**，不是全站 —— 别人被限不该连累你', async () => {
    const base = await boot({ auth: newAuth() })
    for (let i = 0; i < 11; i++) await post(base, '/api/login', WRONG)
    expect((await post(base, '/api/login', WRONG)).status).toBe(429)
    // 换一个名字，照常走正常逻辑（这里是"没这个账号"，不是 429）
    const other = await post(base, '/api/login', { username: '别人', password: 'whatever-1234' })
    expect(other.status).toBe(400)
  })

  it('登录成功把计数清零 —— 前几次打错不该一直攒着', async () => {
    const auth = newAuth()
    const base = await boot({ auth })
    await handleSignup({ username: '小明', email: 'm@m.com', password: 'goodpassword' }, auth)
    for (let i = 0; i < 9; i++) {
      await post(base, '/api/login', { username: '小明', password: 'wrongpassword' })
    }
    // 第九次之后用对的密码进来 —— 应该成功，而且把计数清掉
    expect((await post(base, '/api/login', { username: '小明', password: 'goodpassword' })).status).toBe(200)
    // 再打十次错的，第 11 次才该被限（如果没清，第 2 次就满了）
    for (let i = 0; i < 10; i++) {
      await post(base, '/api/login', { username: '小明', password: 'wrongpassword' })
    }
    expect((await post(base, '/api/login', { username: '小明', password: 'wrongpassword' })).status).toBe(429)
  })
})

/**
 * ★ 2026-10-02（安全审计）：**这一条才是真的测到路径穿越的。**
 *
 * 上面那条 `/api/works/1/file/../../etc` **证明不了任何事** —— `fetch` 在把请求
 * 发出去**之前**就把 `..` 归一化掉了（本文件里两处注释自己也承认了）。
 * 也就是说 `serveStatic` 那道防线**一直没有有效的自动化守卫**：
 * 下次谁改它，不会有测试变红。安全审计是用一次性裸 socket 手工验的，
 * 这次把它固定下来。
 *
 * 所以这里**不走 fetch**：直接开 TCP，把原始的请求行写出去。
 *
 * ⚠️⚠️ **但变异之后发现：这一组也没守住 `serveStatic` 那道前缀检查。**
 *   把 `if (target !== root && !target.startsWith(root + sep))` 整段拿掉，
 *   下面九条**全绿**。原因是 `handle()` 里那句 `new URL(req.url, 'http://localhost')`
 *   已经把 `..` 归一化掉了 —— 等路径走到 `serveStatic` 时，里面已经没有 `..` 了。
 *   （同一个原因也让上面用 fetch 写的那条永远测不到东西。）
 *
 *   所以这一组守的是一个**端到端的性质**：这几串畸形的请求行，读不到静态根外面的
 *   任何东西。这是真正要紧的那件事，而且它**确实会红** —— 谁哪天把 URL 解析那一步
 *   换成一个不做归一化的实现，这里立刻就抓到了。
 *
 *   至于那行前缀检查本身：它是**够不到的纵深防御**（今天走 URL 到不了那儿）。
 *   留着是为了"哪天上面那层变了"——但它今天**没有守卫，也造不出守卫**。
 *   别以为这九条守着它。真要动那一行，先读这段。
 */
describe('★ 静态服务：原始的路径穿越 payload（裸 socket，不走 fetch）', () => {
  /** 静态根**外面**的诱饵。它只要出现在响应里，就是穿出去了。 */
  const DECOY = join(dirname(siteRoot), 'SECRET-OUTSIDE.txt')

  beforeAll(() => {
    mkdirSync(siteRoot, { recursive: true })
    writeFileSync(join(siteRoot, 'index.html'), 'INDEX-OK')
    writeFileSync(DECOY, 'TOPSECRET-MUST-NOT-LEAK')
  })
  afterAll(() => rmSync(siteRoot, { recursive: true, force: true }))

  /** 裸 socket 发一个请求行，把整个响应读回来。 */
  async function rawGet(base: string, target: string): Promise<string> {
    const port = Number(new URL(base).port)
    return await new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
      })
      let buf = ''
      sock.setEncoding('utf8')
      sock.on('data', d => { buf += d })
      sock.on('end', () => resolve(buf))
      sock.on('error', reject)
    })
  }

  it('对照：正常那条路真的在发文件（不然下面几条全是空转）', async () => {
    const res = await rawGet(await boot({ staticDir: siteRoot }), '/index.html')
    expect(res).toContain('INDEX-OK')
  })

  for (const payload of [
    '/../SECRET-OUTSIDE.txt',
    '/../../SECRET-OUTSIDE.txt',
    '/..%2fSECRET-OUTSIDE.txt',
    '/%2e%2e/SECRET-OUTSIDE.txt',
    '/%2e%2e%2fSECRET-OUTSIDE.txt',
    '/..\SECRET-OUTSIDE.txt',
    '/....//SECRET-OUTSIDE.txt',
    '/%00SECRET-OUTSIDE.txt',
    '/C:/Windows/win.ini',
  ]) {
    it(`穿不出去：${payload}`, async () => {
      const res = await rawGet(await boot({ staticDir: siteRoot }), payload)
      expect(res).not.toContain('TOPSECRET-MUST-NOT-LEAK')
      expect(res).not.toContain('[extensions]')   // win.ini 的内容
    })
  }
})
