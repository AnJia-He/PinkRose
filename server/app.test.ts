import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSignup, type AccountDeps } from './account.ts'
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
  const r = handleSignup({ username: '测试用户', email: 't@t.com', password: 'password123' }, auth)
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
  const r = handleSignup({ username: '老用户', email: 'o@o.com', password: 'password123' }, auth)
  return {
    base,
    cookie: `${SESSION_COOKIE}=${r.token}`,
    auth,
    tick: days => { clock.t += days * 86400_000 },
  }
}

/** 端点断言用的合法 /api/edit 请求体。 */
const editBody = {
  imageDataUrl: 'data:image/jpeg;base64,AA',
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
      body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,AA', text: '亮一点' }),
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
    const r = await post(base, '/api/suggest', { imageDataUrl: 'data:image/jpeg;base64,AA' }, cookie)
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
    // 这个 app **没有接线**（上面没传 client/queue），所以 401 这个数字本身
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
    // 其实抓得住 —— 顺序会改变应答码。这条把 client/queue 都接上，就是为了让
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
      body: JSON.stringify({ image: 'data:image/jpeg;base64,AA' }),
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
    const b64 = Buffer.from(new Uint8Array(64).fill(7)).toString('base64')
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
    const b64 = Buffer.from(new Uint8Array(64).fill(7)).toString('base64')
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
    const image = (n: number): string =>
      `data:image/jpeg;base64,${Buffer.from(new Uint8Array(n).fill(7)).toString('base64')}`
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
    const b64 = Buffer.from(new Uint8Array(64).fill(7)).toString('base64')
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
    const other = handleSignup(
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
    const other = handleSignup(
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
describe('★ 两套 key 彻底分开（§7.4，用户点名要的四条）', () => {
  // 这一份测试里的"默认那一套"就是 cfg（生产上 baseUrl 指向 token.sensenova.cn）。
  // 下面凡说"走默认"的断言比的都是它，不写死域名 —— 默认换地址时测试跟着走。
  const CHAT = { kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat', modelId: 'vlm', alias: '甲' }
  const IMAGE = { kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-img', modelId: 'edit', alias: '乙' }
  /** ④ 里那把"填错了"的图片钥匙：上游见到它就回 401。 */
  const TYPO = 'sk-img-typo'

  /** 演示用的 /api/route 请求体（上一个 describe 里的 routeBody 在别的作用域，不共用）。 */
  const askBody = { imageDataUrl: 'data:image/jpeg;base64,AA', text: '亮一点' }

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
    const r = handleSignup({ username: '测试用户', email: 't@t.com', password: 'password123' }, auth)
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
    // （http.ts 那张表把上游 401 映射成 400 BAD_REQUEST —— 不是 503，也不是 200）。
    // ⚠️ 这个状态码本身**分不清**"上游拒了图片那把钥匙"和"本地校验挂了"——
    //    两者都是 400 BAD_REQUEST。钉住前者的，是下面那条看 `calls` 的断言。
    const edit = await post(base, '/api/edit', editBody, cookie)
    expect(edit.status).toBe(400)
    expect(edit.body.error!.code).toBe('BAD_REQUEST')

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
})
