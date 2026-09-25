import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSignup, type AccountDeps } from './account.ts'
import { createApp, type AppDeps } from './app.ts'
import type { Config } from './config.ts'
import { openDb, type Db } from './db.ts'
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
  server = createApp({
    config: cfg, auth: extra.auth ?? newAuth(), storage: extra.storage ?? newStorage(),
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
    deps: { client: new SenseNovaClient(cfg, impl), queue: new SerialQueue({ sleep: async () => {} }) },
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
    // 这里不需要 client 真的能工作——只要守卫放行。
    // 同理**必须带着 cookie**：鉴权守卫排在 413 那道之前。
    const { base, cookie } = await appWithUser({
      client: new SenseNovaClient(cfg, (async () => new Response('{}')) as unknown as typeof fetch),
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
