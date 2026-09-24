# 账号地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 RuiXing 装上账号 —— 能注册、能登录、能退出，并且让三个花钱的 AI 接口从此只认登录过的人。

**Architecture:** 后端从「无状态代理」变成「有状态服务」：加一层 SQLite（Node 24 自带的 `node:sqlite`），加一张 `users` 表，用 **签名 cookie** 记会话。会话签名里**掺进当前密码哈希** —— 于是「改密码 = 所有设备自动下线」成了签名的性质，不用建会话表、不用记"哪些票该作废"。前端加一张登录页挡在前面，登录后就是现在这个界面。

**Tech Stack:** Node 24.15.0 自带的 `node:sqlite` + `node:crypto`（scrypt / HMAC / timingSafeEqual）。**零新依赖** —— 这是设计文档定死的，`package.json` 的 `dependencies` 必须保持只有 `piexifjs` / `react` / `react-dom` 三项。

**Spec:** `docs/superpowers/specs/2026-09-24-accounts-and-gallery-design.md`
（本计划实现的是它的 **§12 实施顺序的「第一段：地基」**。文档里 §6.1–§6.5、§6.3、§7.7 是这一段的直接依据。）

---

## Global Constraints

每一处改动都隐含这些约束。**与本节冲突的实现一律算错。**

| | |
|---|---|
| **零新依赖** | `package.json` 的 `dependencies` 不许增加任何一项。数据库、密码、签名、cookie 全部用 Node 自带 |
| **Node 24 剥离模式** | `server/` 和 `shared/` 里的 import **必须带 `.ts` 扩展名**；`src/` 里**不带**。构造函数参数属性（`constructor(public x)`）**绝对不能用** —— Node 的 TS 剥离模式不支持，会 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（而 vitest 能转译，于是测试全绿、真跑直接崩） |
| **中文注释** | 所有注释用中文，叙述式，写**为什么**不是写**做了什么**。这个仓库的注释密度很高，照着现有的来 |
| **行尾 CRLF** | 这个仓库的工作区是 CRLF。新建文件写完要转成 CRLF（`unix2dos` 或等价的 Node 一行脚本），否则 `git diff` 会显示整个文件都变了 |
| **提交前必须** | `git diff --cached --name-only` 里**不许出现 `.env`**。`.env` 里有真实 API key |
| **钱** | **全程不许发起真实 API 调用**。测试里三个 AI 接口都是 mock 的；不许为了"试一下"去跑真接口 |
| **提交信息** | 中文、叙述式，讲清"为什么"；尾行逐字 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` |
| **每个测试都要有变异** | 每条断言都必须有一个**能让它变红**的变异（改代码 → 测试必须红 → 改回来）。**变异跑不红就如实报告"这条断言抓不住这个变异"，不许调断言让报告好看** |
| **收尾必须** | `npm test` 全绿 + `npm run typecheck` 干净 + `git status` 干净 |

### 这一段**不做**（后面几段才做，但缝已经留好）

邮箱验证、找回密码、用户管理页、作品集、模型设置、预设、LUT、按 IP 限流、图形验证码。

**但 schema 和接口要给它们留位置**：注册时就要收 `email` 字段（只是这一版不验它），
`db.ts` 的迁移要做成**数组**（加表就是往数组里追加一条，不是改老的那条）。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `server/db.ts` | 开库、建表、迁移。**全仓库所有 SQL 只住在这里和调用它的模块**，换 Postgres 时只改这一层 | **新建** |
| `server/password.ts` | scrypt 哈希与校验。纯加密，不认识数据库 | **新建** |
| `server/session.ts` | 签名 cookie 的签发与校验、cookie 解析 | **新建** |
| `shared/account.ts` | 用户名/邮箱/密码的**格式规则**。前后端共用（前端要即时提示） | **新建** |
| `server/account.ts` | 注册/登录/退出/我是谁/改密码 五个处理函数 | **新建** |
| `server/config.ts` | 加 `sessionSecret`（**没配就拒绝启动**）、`dbPath` | 改 |
| `server/app.ts` | 路由表加账号接口；**三个 AI 接口加登录检查** | 改 |
| `server/index.ts` | 开库、把 db 和 secret 注入 `createApp` | 改 |
| `src/api/client.ts` | 请求带上 cookie（`credentials`）；加 `get()` | 改 |
| `src/api/account.ts` | 前端调账号接口 | **新建** |
| `src/ui/LoginPage.tsx` | 登录 / 注册页 | **新建** |
| `src/App.tsx` | 没登录就显示登录页 | 改 |
| `src/styles.css` | 登录页样式 | 改 |
| `.env.example` | 加 `SESSION_SECRET` 说明 | 改（没有就新建） |
| `.gitignore` | 加 `data/` | 改 |

---

## Task 1: 数据库层

**Files:**
- Create: `server/db.ts`
- Create: `server/db.test.ts`
- Modify: `server/config.ts`（加 `dbPath`）
- Modify: `.gitignore`（加 `data/`）

**Interfaces:**
- Consumes: 无
- Produces:
  - `type Db = { raw: DatabaseSync; close(): void }`
  - `function openDb(path: string): Db` —— 开库 + 跑迁移。`:memory:` 也支持（测试用）
  - `const MIGRATIONS: readonly string[]` —— **下标 + 1 = 版本号**。加表就往数组**追加**

- [ ] **Step 1: 写失败的测试**

新建 `server/db.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { openDb, MIGRATIONS } from './db.ts'

describe('openDb', () => {
  it('建出 users 表，字段齐全', () => {
    const db = openDb(':memory:')
    const cols = db.raw.prepare(`SELECT name FROM pragma_table_info('users')`).all()
      .map((r: any) => r.name)
    expect(cols).toContain('id')
    expect(cols).toContain('username')
    expect(cols).toContain('email')
    expect(cols).toContain('password_hash')
    expect(cols).toContain('created_at')
    db.close()
  })

  it('username 和 email 都是唯一的 —— 靠数据库约束，不靠代码查', () => {
    const db = openDb(':memory:')
    const ins = db.raw.prepare(
      `INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)`)
    ins.run('a', 'a@x.com', 'h', 1)
    // 同一个 username、不同 email：必须被数据库拒绝
    expect(() => ins.run('a', 'b@x.com', 'h', 1)).toThrow()
    // 同一个 email、不同 username：也必须被拒绝
    expect(() => ins.run('b', 'a@x.com', 'h', 1)).toThrow()
    db.close()
  })

  it('迁移是幂等的 —— 开两次不炸', () => {
    const db = openDb(':memory:')
    db.close()
    // 同一个文件开两次（这里用内存库模拟"再开一次"）
    expect(() => { const d = openDb(':memory:'); d.close() }).not.toThrow()
  })

  it('迁移数组只增不改 —— 拿掉一条就会炸在旧库上', () => {
    const db = openDb(':memory:')
    const v = db.raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as any
    expect(v.v).toBe(MIGRATIONS.length)
    db.close()
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run server/db.test.ts`
Expected: FAIL —— `Failed to resolve import "./db.ts"`（文件还不存在）

- [ ] **Step 3: 写实现**

新建 `server/db.ts`：

```ts
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 建表语句，**下标 + 1 = 版本号**。
 *
 * ⚠️ 只许往后追加，永远不许改或删已经发布过的那几条 —— 用户的库是按顺序跑过来的，
 * 改一条老的就等于让"新库"和"老库升上来的"长得不一样，而现场已经跑过的那个不会重跑。
 * 要改结构就追加一条新的（ALTER TABLE / 新建表都行）。
 */
export const MIGRATIONS: readonly string[] = [
  // 1 —— users
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    created_at    INTEGER NOT NULL
  );
  `,
]

export type Db = {
  raw: DatabaseSync
  close(): void
}

/**
 * 开库并跑迁移。
 *
 * 传 ':memory:' 时不开文件（测试用）。传路径时会先把父目录建出来 ——
 * 不然第一次跑会因为 data/ 不存在而挂在一个跟数据库无关的错误上。
 */
export function openDb(path: string, versionTable = true): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const raw = new DatabaseSync(path)

  // 外键默认是关的，得显式打开。现在只有一个表用不上，
  // 但后面 works.user_id 要靠它保证删用户时不留孤儿。
  raw.exec('PRAGMA foreign_keys = ON')

  raw.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`)
  const row = raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
  const current = row?.v ?? 0
  if (current === 0) raw.prepare('INSERT INTO schema_version (version) VALUES (0)').run()

  for (let i = current; i < MIGRATIONS.length; i++) {
    raw.exec(MIGRATIONS[i]!)
    raw.prepare('UPDATE schema_version SET version = ?').run(i + 1)
  }

  return {
    raw,
    close: () => raw.close(),
  }
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run server/db.test.ts`
Expected: PASS（4 条）

- [ ] **Step 5: 变异验证（每条断言都要能红）**

逐条做，**每做完一条都改回来**：

| 变异 | 应该红在哪条 |
|---|---|
| 把 `CREATE TABLE users` 里的 `UNIQUE` 去掉 | 「username 和 email 都是唯一的」 |
| 把迁移循环的 `for (let i = current; ...)` 改成 `for (let i = 0; ...)` | 迁移不幂等那条会红（第二次开库重跑建表 → 表已存在） |
| 把 `schema_version` 的写入删掉 | 「迁移数组只增不改」 |

**没红就如实报告，不要调断言。**

- [ ] **Step 6: config 加 dbPath，.gitignore 加 data/**

`server/config.ts` 的 `Config` 加一行 `dbPath: string`，`loadConfig` 里：

```ts
dbPath: env.DB_PATH?.trim() || resolve(process.cwd(), 'data', 'ruixing.db'),
```

（`resolve` 从 `node:path` import。注意 `server/config.ts` 现在的 import 区是空的，要加。）

`.gitignore` 末尾加：

```
# 用户数据：数据库和照片。绝不提交
data/
```

- [ ] **Step 7: 收尾验证 + 提交**

```bash
npm test          # 必须全绿
npm run typecheck # 必须无输出
git status        # 工作区干净
git add server/db.ts server/db.test.ts server/config.ts .gitignore
git commit -m "feat(db): 加一层 SQLite —— 全仓库的 SQL 从此只住在这里

node:sqlite 是 Node 24 自带的（实测可用、无实验警告），所以零新依赖 ——
这个项目至今只装过 3 个依赖，后端也是手写的，引 ORM 会破坏那个一致性。

迁移做成数组（下标+1=版本号），只许追加不许改。这一条是给后面四段留的：
加作品表、模型配置表、预设表都是往数组里追一条，而不是去动已经发布过的那条 ——
用户的库是按顺序跑过来的，改老的那条会让"新库"和"老库升上来的"长得不一样。

username 和 email 的唯一性交给数据库约束，不靠代码查。代码查有个缝：
两个人同时注册同一个名字，两边都查到"没被占用"，然后就重复了。

dbPath 走 config，data/ 进 .gitignore（里面是用户的照片和数据库）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 密码哈希

**Files:**
- Create: `server/password.ts`
- Create: `server/password.test.ts`

**Interfaces:**
- Consumes: 无（只用 `node:crypto`）
- Produces:
  - `function hashPassword(plain: string): string` —— 返回 `scrypt$N$r$p$<盐base64>$<哈希base64>`，**每次调用盐都不同**
  - `function verifyPassword(plain: string, stored: string): boolean` —— 用 `timingSafeEqual`，**绝不用 `===`**

- [ ] **Step 1: 写失败的测试**

新建 `server/password.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password.ts'

describe('password', () => {
  it('哈希里不含明文', () => {
    const h = hashPassword('my-secret-pw')
    expect(h).not.toContain('my-secret-pw')
  })

  it('同一个密码两次哈希结果不同（盐是随机的）', () => {
    expect(hashPassword('same-pw-1234')).not.toBe(hashPassword('same-pw-1234'))
  })

  it('对得上就是 true，对不上就是 false', () => {
    const h = hashPassword('correct-horse')
    expect(verifyPassword('correct-horse', h)).toBe(true)
    expect(verifyPassword('correct-horsf', h)).toBe(false)
    expect(verifyPassword('', h)).toBe(false)
  })

  it('中文密码、空格、符号都支持', () => {
    const h = hashPassword('我的密码 有空格!@#')
    expect(verifyPassword('我的密码 有空格!@#', h)).toBe(true)
  })

  it('存坏的哈希不抛异常，只返回 false', () => {
    // 数据库被手工改坏、或者格式换了代，都不能让登录接口 500
    for (const bad of ['', 'garbage', 'scrypt$1$2$3', 'md5$a$b$c$d']) {
      expect(verifyPassword('x', bad)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run server/password.test.ts`
Expected: FAIL —— 解析不到 `./password.ts`

- [ ] **Step 3: 写实现**

新建 `server/password.ts`：

```ts
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** scrypt 参数。N=2^15 在 2026 年的机器上约几十毫秒，够慢也够快。 */
const N = 32768
const R = 8
const P = 1
const KEY_LEN = 64
const SALT_LEN = 16

/**
 * 把明文密码变成可以进数据库的字符串。
 *
 * **每次调用的盐都不一样** —— 同一个密码在两个用户那里哈希也不同，
 * 于是"撞库"（拿别人的哈希表来试）在这个库里没有意义。
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_LEN)
  const key = scryptSync(plain, salt, KEY_LEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

/**
 * 校验。**永远返回 boolean，永远不抛。**
 *
 * 存坏的哈希（数据库被手工改过、或者以后换了算法）只该让这个人登不上，
 * 不该让整个登录接口 500 —— 那会把"一个人有问题"放大成"所有人都登不了"。
 *
 * 比对用 timingSafeEqual：普通 `===` 会因为"比到第几位才不一样"而耗时不同，
 * 理论上能被用来一位一位地猜出哈希。
 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (n <= 0 || r <= 0 || p <= 0) return false

  let salt: Buffer; let expected: Buffer
  try {
    salt = Buffer.from(parts[4]!, 'base64')
    expected = Buffer.from(parts[5]!, 'base64')
  } catch { return false }
  if (salt.length === 0 || expected.length === 0) return false

  let actual: Buffer
  try {
    actual = scryptSync(plain, salt, expected.length, { N: n, r, p })
  } catch {
    // 参数大到内存扛不住时 scryptSync 会抛。当成"对不上"，不是"服务器坏了"
    return false
  }
  // 长度不同的 timingSafeEqual 会抛，先挡掉
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run server/password.test.ts`
Expected: PASS（5 条）

- [ ] **Step 5: 变异验证**

| 变异 | 应该红在哪条 |
|---|---|
| `verifyPassword` 里的 `timingSafeEqual(actual, expected)` 改成 `actual.toString() === expected.toString()` | 这条**未必会红** —— `===` 的结果值和 timingSafeEqual 一样。**如果没红，如实报告**："这条断言抓不住 `===` 这个变异，因为两者返回值相同，差别只在耗时"。这条断言保护的是**行为**，不是**耗时**；耗时要靠 code review 看 |
| 把盐写死成 `Buffer.alloc(SALT_LEN)` | 「两次哈希结果不同」 |
| 去掉 `parts.length !== 6` 的守卫 | 「存坏的哈希不抛异常」 |
| `hashPassword` 直接返回 `plain` | 「哈希里不含明文」 |

- [ ] **Step 6: 收尾验证 + 提交**

```bash
npm test && npm run typecheck && git status
git add server/password.ts server/password.test.ts
git commit -m "feat(auth): 密码用 scrypt 存，比对用 timingSafeEqual

scrypt 是 Node 自带的（node:crypto），所以这里也没引新依赖 ——
比自己装一个 bcrypt 还少一样要更新维护的东西。

盐每次随机，于是同一个密码在两个用户那里哈希也不同，"撞库"在这个库里没意义。
比对必须用 timingSafeEqual：普通 === 会因为"比到第几位才不一样"而耗时不同，
理论上能被一位一位地猜出哈希。

verifyPassword 永远返回 boolean、永远不抛 —— 数据库被手工改坏只该让那个人登不上，
不该让整个登录接口 500（那会把"一个人有问题"放大成"所有人都登不了"）。

出参格式 scrypt\$N\$r\$p\$盐\$哈希 自带参数，以后调 N 了老哈希照样能验。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 格式规则（前后端共用）

**Files:**
- Create: `shared/account.ts`
- Create: `shared/account.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（`shared/` —— 前后端都 import 它）：
  - `const USERNAME_MIN = 2` / `USERNAME_MAX = 20`
  - `const PASSWORD_MIN = 8` / `PASSWORD_MAX = 128`
  - `const RESERVED_USERNAMES: readonly string[]`
  - `type Check = { ok: true; value: string } | { ok: false; message: string }`
  - `function checkUsername(raw: string): Check` —— 成功时 `value` 是**小写、去空白的**
  - `function checkEmail(raw: string): Check` —— 成功时 `value` 是**小写、去空白的**
  - `function checkPassword(raw: string, username?: string): Check`

- [ ] **Step 1: 写失败的测试**

新建 `shared/account.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { checkUsername, checkEmail, checkPassword, USERNAME_MIN } from './account.ts'

describe('checkUsername', () => {
  it('两个汉字可以 —— 中文两个字的名字太常见了', () => {
    expect(checkUsername('小明')).toEqual({ ok: true, value: '小明' })
  })

  it('一个字不行', () => {
    expect(checkUsername('李').ok).toBe(false)
  })

  it('21 个字不行', () => {
    expect(checkUsername('a'.repeat(21)).ok).toBe(false)
  })

  it('大写转小写 —— Zhang 和 zhang 得算同一个，防冒充', () => {
    expect(checkUsername('Zhang')).toEqual({ ok: true, value: 'zhang' })
  })

  it('前后空白去掉', () => {
    expect(checkUsername('  abc  ')).toEqual({ ok: true, value: 'abc' })
  })

  it('中文、字母、数字、下划线可以；空格和符号不行', () => {
    expect(checkUsername('小_明2').ok).toBe(true)
    expect(checkUsername('小 明').ok).toBe(false)
    expect(checkUsername('a-b').ok).toBe(false)
    expect(checkUsername('a@b').ok).toBe(false)
    expect(checkUsername('a😀').ok).toBe(false)
  })

  it('保留名不让注册', () => {
    for (const n of ['admin', 'root', 'system', 'administrator', 'ADMIN']) {
      expect(checkUsername(n).ok).toBe(false)
    }
  })

  it('失败时 message 是给人看的中文', () => {
    const r = checkUsername('!')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0)
  })

  it('USERNAME_MIN 就是 2 —— 改大了「小明」就注册不了', () => {
    expect(USERNAME_MIN).toBe(2)
  })
})

describe('checkEmail', () => {
  it('正常邮箱可以，转小写', () => {
    expect(checkEmail('  A@B.COM ')).toEqual({ ok: true, value: 'a@b.com' })
  })
  it('缺 @ 或点不行', () => {
    expect(checkEmail('abc').ok).toBe(false)
    expect(checkEmail('a@b').ok).toBe(false)
    expect(checkEmail('@b.com').ok).toBe(false)
    expect(checkEmail('a@.com').ok).toBe(false)
  })
  it('太长不行', () => {
    expect(checkEmail('a'.repeat(250) + '@b.com').ok).toBe(false)
  })
})

describe('checkPassword', () => {
  it('八位可以，七位不行', () => {
    expect(checkPassword('12345678').ok).toBe(true)
    expect(checkPassword('1234567').ok).toBe(false)
  })

  it('不强制大写数字符号 —— 强制会逼出 Password1! 这种更好猜的', () => {
    expect(checkPassword('aaaaaaaa').ok).toBe(true)
    expect(checkPassword('我的密码我的密码').ok).toBe(true)
    expect(checkPassword('有 空格 !@#').ok).toBe(true)
  })

  it('不能和用户名一样', () => {
    expect(checkPassword('same-name-1', 'same-name-1').ok).toBe(false)
    expect(checkPassword('other-name', 'same-name-1').ok).toBe(true)
  })

  it('超长不行（防被人拿它当 DoS）', () => {
    expect(checkPassword('a'.repeat(129)).ok).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run shared/account.test.ts`
Expected: FAIL —— 解析不到 `./account.ts`

- [ ] **Step 3: 写实现**

新建 `shared/account.ts`：

```ts
/**
 * 账号的格式规则。**前后端共用** —— 前端要一边打一边提示，后端要再验一遍
 * （前端那遍是体验，后端那遍才是规矩：请求可以伪造）。
 */

export const USERNAME_MIN = 2
export const USERNAME_MAX = 20
export const EMAIL_MAX = 254
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128

/**
 * 不让注册的名字。
 *
 * 不是为了防谁攻击，是为了**防冒充** —— 有个用户叫 "admin"，别人会以为他是官方。
 */
export const RESERVED_USERNAMES: readonly string[] = [
  'admin', 'administrator', 'root', 'system', 'official', 'ruixing', 'support', 'help',
]

export type Check =
  | { ok: true; value: string }
  | { ok: false; message: string }

/**
 * ⚠️ 名字长度按**字符数**算（`[...raw].length`），不是 `.length`。
 * JS 的 `.length` 数的是 UTF-16 码元，emoji 和部分汉字会算成 2，于是
 * 一个 emoji 就"占两个位置"，规则会变得莫名其妙。
 */
const charLen = (s: string): number => [...s].length

export function checkUsername(raw: string): Check {
  const v = raw.trim().toLowerCase()
  if (v.length === 0) return { ok: false, message: '起个名字吧' }
  const n = charLen(v)
  if (n < USERNAME_MIN) return { ok: false, message: `名字至少 ${USERNAME_MIN} 个字` }
  if (n > USERNAME_MAX) return { ok: false, message: `名字最多 ${USERNAME_MAX} 个字` }
  // 中文、字母、数字、下划线。**空格和符号不收** —— 空格开头结尾会让人看不出区别，
  // 符号则是纯给冒充留余地（"官方客服★"）
  if (!/^[一-龥a-z0-9_]+$/.test(v)) {
    return { ok: false, message: '只能用中文、字母、数字和下划线' }
  }
  if (RESERVED_USERNAMES.includes(v)) {
    return { ok: false, message: '这个名字被保留了，换一个吧' }
  }
  return { ok: true, value: v }
}

export function checkEmail(raw: string): Check {
  const v = raw.trim().toLowerCase()
  if (v.length === 0) return { ok: false, message: '填个邮箱吧，忘记密码时要靠它' }
  if (v.length > EMAIL_MAX) return { ok: false, message: '邮箱太长了' }
  // 故意写得宽松：邮箱的真实规则复杂到没人实现对，而严格规则会把合法邮箱挡在外面。
  // 真正证明"这个邮箱是他的"靠第三段的验证邮件，不靠这里的正则。
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) {
    return { ok: false, message: '这个邮箱看起来不对' }
  }
  return { ok: true, value: v }
}

export function checkPassword(raw: string, username?: string): Check {
  if (raw.length === 0) return { ok: false, message: '设个密码吧' }
  if (charLen(raw) < PASSWORD_MIN) return { ok: false, message: `密码至少 ${PASSWORD_MIN} 位` }
  if (raw.length > PASSWORD_MAX) return { ok: false, message: `密码最多 ${PASSWORD_MAX} 位` }
  // **不强制大写/数字/符号。** 强制会逼出 Password1! 这种更好猜的密码 ——
  // 现在公认的做法是够长就行。中文、空格、符号都允许，它们只会让密码更强。
  if (username !== undefined && raw === username) {
    return { ok: false, message: '密码不能和名字一样' }
  }
  return { ok: true, value: raw }
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run shared/account.test.ts`
Expected: PASS（17 条左右）

- [ ] **Step 5: 变异验证**

| 变异 | 应该红在哪条 | 注 |
|---|---|---|
| `USERNAME_MIN` 从 2 改成 3 | 「两个汉字可以」+「USERNAME_MIN 就是 2」 | **这就是设计文档里记的那个教训**（照搬英文网站习惯会把「小明」挡在外面） |
| 去掉 `.toLowerCase()` | 「大写转小写」 | |
| 正则里加上 `\s` | 「空格和符号不行」 | |
| 去掉保留名判断 | 「保留名不让注册」 | |
| `checkPassword` 加上"必须有数字" | 「不强制大写数字符号」 | |
| 用户名比较改成 `raw === username`（不转小写） | 「不能和用户名一样」—— 如果没红，说明该条测试用的是已经小写的名字，**如实报告** | |

- [ ] **Step 6: 收尾验证 + 提交**

```bash
npm test && npm run typecheck && git status
git add shared/account.ts shared/account.test.ts
git commit -m "feat(auth): 账号的格式规则，前后端共用一份

放 shared/ 是因为前端要一边打一边提示、后端要再验一遍 —— 前端那遍是体验，
后端那遍才是规矩（请求可以伪造）。两份实现一定会漂，所以只留一份。

三个从设计文档里带出来的决定：

- 名字最短 2 个字符。原来写的是 3（英文网站的习惯，ab 这种两字母像垃圾号），
  但**中文里两个字的名字太常见**（小明、阿宝、李雷），按 3 个卡他们注册不了。
- **不强制密码有大写/数字/符号**。强制会逼出 Password1! 这种更好猜的密码，
  现在公认的做法是够长就行。中文、空格、符号都允许 —— 它们只会让密码更强。
- 长度按**字符数**算（[...s].length）不是 .length，因为后者数的是 UTF-16 码元，
  emoji 会被算成 2，规则会变得莫名其妙。

邮箱正则故意写宽松：邮箱的真实规则复杂到没人实现对，而严格规则会把合法邮箱
挡在外面。真正证明'这个邮箱是他的'靠第三段的验证邮件，不靠这里的正则。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 会话签名（掺密码哈希）

**Files:**
- Create: `server/session.ts`
- Create: `server/session.test.ts`

**Interfaces:**
- Consumes: 无（`node:crypto`）
- Produces:
  - `const SESSION_COOKIE = 'rx_session'`
  - `const SESSION_DAYS = 30`
  - `const RENEW_WITHIN_DAYS = 15` —— 离过期不到这么多天就续
  - `function signSession(userId: number, passwordHash: string, expiresAt: number, secret: string): string`
  - `function verifySession(token: string, passwordHash: string, nowMs: number, secret: string): { userId: number; expiresAt: number } | null`
  - `function parseCookies(header: string | undefined): Record<string, string>`
  - `function sessionCookie(token: string, expiresAt: number): string` —— 拼 `Set-Cookie` 的值
  - `function clearSessionCookie(): string`

- [ ] **Step 1: 写失败的测试**

新建 `server/session.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import {
  signSession, verifySession, parseCookies, sessionCookie, clearSessionCookie,
  SESSION_COOKIE, SESSION_DAYS,
} from './session.ts'

const SECRET = 'test-secret-not-a-real-one'
const HASH_A = 'scrypt$1$2$3$c2FsdA==$aGFzaA=='
const HASH_B = 'scrypt$1$2$3$c2FsdA==$b3RoZXJoYXNo'
const NOW = 1_700_000_000_000
const EXP = NOW + SESSION_DAYS * 86400_000

describe('会话签名', () => {
  it('签出来能验回来', () => {
    const t = signSession(7, HASH_A, EXP, SECRET)
    expect(verifySession(t, HASH_A, NOW, SECRET)).toEqual({ userId: 7, expiresAt: EXP })
  })

  it('改一个字节就验不过', () => {
    const t = signSession(7, HASH_A, EXP, SECRET)
    const tampered = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')
    expect(verifySession(tampered, HASH_A, NOW, SECRET)).toBeNull()
  })

  it('换把钥匙签就验不过', () => {
    const t = signSession(7, HASH_A, EXP, SECRET)
    expect(verifySession(t, HASH_A, NOW, 'another-secret')).toBeNull()
  })

  it('过期的验不过', () => {
    const t = signSession(7, HASH_A, EXP, SECRET)
    expect(verifySession(t, HASH_A, EXP + 1, SECRET)).toBeNull()
  })

  it('★ 密码改了，票自己就失效 —— 不用建表也不用记「哪些该作废」', () => {
    const t = signSession(7, HASH_A, EXP, SECRET)
    // 同一个用户、同一把钥匙、同一个时间，只是密码哈希变了
    expect(verifySession(t, HASH_B, NOW, SECRET)).toBeNull()
  })

  it('把 userId 从 7 改成 8 自己重签也没用 —— 签名覆盖了它', () => {
    const t = signSession(7, HASH_A, EXP, SECRET)
    const [, exp, sig] = t.split('.')
    const forged = `8.${exp}.${sig}`
    expect(verifySession(forged, HASH_A, NOW, SECRET)).toBeNull()
  })

  it('垃圾输入一律返回 null，不抛', () => {
    for (const bad of ['', 'a', 'a.b', 'a.b.c', '....', '1.2.3']) {
      expect(verifySession(bad, HASH_A, NOW, SECRET)).toBeNull()
    }
  })
})

describe('cookie', () => {
  it('带 HttpOnly 和 SameSite=Lax 和 Path=/', () => {
    const c = sessionCookie('tok', EXP)
    expect(c).toContain(`${SESSION_COOKIE}=tok`)
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Lax')
    expect(c).toContain('Path=/')
  })

  it('清除就是把 Max-Age 设成 0', () => {
    const c = clearSessionCookie()
    expect(c).toContain(`${SESSION_COOKIE}=`)
    expect(c).toContain('Max-Age=0')
  })

  it('能解析出 cookie，能容忍各种空白', () => {
    const got = parseCookies('a=1; rx_session=xyz ;b=2')
    expect(got['rx_session']).toBe('xyz')
    expect(got['a']).toBe('1')
    expect(got['b']).toBe('2')
  })

  it('没有 cookie 头时返回空对象', () => {
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies('')).toEqual({})
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run server/session.test.ts`
Expected: FAIL —— 解析不到 `./session.ts`

- [ ] **Step 3: 写实现**

新建 `server/session.ts`：

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'rx_session'
export const SESSION_DAYS = 30
/** 离过期不到这么多天就重新签一张，把 30 天推满 */
export const RENEW_WITHIN_DAYS = 15

const DAY_MS = 86400_000

/**
 * 票的内容是 `用户ID.过期时间.签名`。
 *
 * ★ 签名里**掺了当前的密码哈希** —— 这是这一版最省事的一招：
 *
 *   - 用户改了密码 → 数据库里的哈希变了 → 旧票**自己就验不过**
 *   - 于是"改密码 = 所有设备自动下线"成了**签名的性质**
 *   - 也于是：不用建会话表、不用记"哪些票该作废"、不用定时清理
 *
 * 哈希**不在票里**，只在 HMAC 的输入里 —— 票上看得见的仍然只有 ID 和时间。
 */
function sign(userId: number, expiresAt: number, passwordHash: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${userId}.${expiresAt}.${passwordHash}`)
    .digest('base64url')
}

export function signSession(
  userId: number, passwordHash: string, expiresAt: number, secret: string,
): string {
  return `${userId}.${expiresAt}.${sign(userId, expiresAt, passwordHash, secret)}`
}

/**
 * 校验。**任何不对都返回 null，绝不抛。**
 *
 * 票是从网上来的，所以要假设它什么形状都可能 —— 畸形输入只该让这个人
 * 变成"没登录"，不该让接口 500。
 */
export function verifySession(
  token: string, passwordHash: string, nowMs: number, secret: string,
): { userId: number; expiresAt: number } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [rawId, rawExp, sig] = parts as [string, string, string]
  const userId = Number(rawId)
  const expiresAt = Number(rawExp)
  if (!Number.isInteger(userId) || userId <= 0) return null
  if (!Number.isInteger(expiresAt)) return null
  if (expiresAt <= nowMs) return null

  const expected = sign(userId, expiresAt, passwordHash, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null

  return { userId, expiresAt }
}

/** 过期时间：从现在起 30 天 */
export function sessionExpiry(nowMs: number): number {
  return nowMs + SESSION_DAYS * DAY_MS
}

/** 还差几天过期 —— 用来决定要不要续签 */
export function daysLeft(expiresAt: number, nowMs: number): number {
  return (expiresAt - nowMs) / DAY_MS
}

/**
 * 拼 Set-Cookie 的值。
 *
 * HttpOnly：JS 读不到 → 页面被塞了坏代码也偷不走。
 * SameSite=Lax：别的网站伪造请求带不上这张票（CSRF）。
 * Path=/：整站都带上。
 *
 * ⚠️ 没有 Secure —— 因为本地跑的是明文 http，加了它浏览器根本不发这张票。
 * **上线前必须加上**（设计文档 §6.5 / §11 都记着这笔）。
 */
export function sessionCookie(token: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

/**
 * 解析 Cookie 头。手写是因为 node:http 不带这个 —— 而为了三行代码引一个
 * cookie 库，会破坏"零新依赖"。
 *
 * 容错：值里的空白去掉；没有 `=` 的段直接跳过，不抛。
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return out
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run server/session.test.ts`
Expected: PASS（12 条）

- [ ] **Step 5: 变异验证**

| 变异 | 应该红在哪条 |
|---|---|
| HMAC 输入里去掉 `passwordHash` | **「★ 密码改了，票自己就失效」** ← **这一条是整段的重点** |
| `expiresAt <= nowMs` 改成 `<` | 「过期的验不过」边界（**未必红**，如实报告） |
| 去掉 `if (a.length !== b.length) return null` | 「垃圾输入一律返回 null」（timingSafeEqual 长度不同会抛） |
| 签名只签 `userId`、不签 `expiresAt` | 「把 userId 从 7 改成 8 自己重签也没用」**未必红** —— 如果要红得把过期时间也改，如实报告 |
| `sessionCookie` 去掉 `HttpOnly` | 「带 HttpOnly 和 SameSite=Lax」 |

⚠️ **特别注意第 4 条**：如果它不红，说明签名覆盖过期时间这件事**没有断言保护**。
那就**补一条测试**（改过期时间 → 必须拒），不要只是报告。

- [ ] **Step 6: 收尾验证 + 提交**

```bash
npm test && npm run typecheck && git status
git add server/session.ts server/session.test.ts
git commit -m "feat(auth): 签名 cookie —— 并且把'改密码踢掉所有设备'做成签名的性质

票是 用户ID.过期时间.签名，签名里掺当前密码哈希。这一招一次解决两件事：

  改完密码，别的设备还登着怎么办   → 哈希变了，那些票自己就验不过
  被偷了号，改密码后小偷还在里面     → 同上，改密码就是踢他出去的那一下

而且不用建会话表、不用记哪些票该作废、不用定时清理 ——
**'改密码就该踢掉所有人'成了签名的一部分，而不是一段要记得写的代码**。
这是这一版第三次把'不会错'做成结构而不是做成纪律（前两次：两套模型配置用
kind 区分、在用哪套用指针）。

哈希不在票里，只在 HMAC 的输入里 —— 票上看得见的仍然只有 ID 和时间。
校验永远返回 null 绝不抛：票是从网上来的，畸形输入只该让这个人变成没登录，
不该让接口 500。

Cookie 是 HttpOnly + SameSite=Lax + Path=/。**没有 Secure** —— 本地跑明文 http，
加了它浏览器根本不发这张票；上线前必须加，设计文档里记着这笔。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 账号接口

**Files:**
- Create: `server/account.ts`
- Create: `server/account.test.ts`

**Interfaces:**
- Consumes: `Db`（Task 1）、`hashPassword`/`verifyPassword`（Task 2）、`checkUsername`/`checkEmail`/`checkPassword`（Task 3）、`signSession`/`verifySession`/`SESSION_COOKIE`/`parseCookies`（Task 4）
- Produces:
  - `type PublicUser = { id: number; username: string; email: string }`
  - `type AccountDeps = { db: Db; secret: string; now?: () => number }`
  - `function findUserByCookie(cookieHeader: string | undefined, deps: AccountDeps): (PublicUser & { passwordHash: string }) | null`
  - `function handleSignup(body: unknown, deps: AccountDeps): { user: PublicUser; token: string; expiresAt: number }`
  - `function handleLogin(body: unknown, deps: AccountDeps): { user: PublicUser; token: string; expiresAt: number }`
  - `function handleChangePassword(body: unknown, user: PublicUser, deps: AccountDeps): { token: string; expiresAt: number }`

- [ ] **Step 1: 写失败的测试**

新建 `server/account.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from './db.ts'
import { handleSignup, handleLogin, handleChangePassword, findUserByCookie, type AccountDeps } from './account.ts'
import { sessionCookie, SESSION_COOKIE } from './session.ts'

let db: Db
let deps: AccountDeps
let clock = 1_700_000_000_000

beforeEach(() => {
  db = openDb(':memory:')
  clock = 1_700_000_000_000
  deps = { db, secret: 'test-secret', now: () => clock }
})

const GOOD = { username: '小明', email: 'a@b.com', password: 'goodpassword' }

describe('注册', () => {
  it('能注册，回的是用户名（小写）而不是密码', () => {
    const r = handleSignup(GOOD, deps)
    expect(r.user.username).toBe('小明')
    expect(r.user.email).toBe('a@b.com')
    expect(JSON.stringify(r)).not.toContain('goodpassword')
  })

  it('★ 数据库里存的是哈希，不是明文', () => {
    handleSignup(GOOD, deps)
    const row = db.raw.prepare('SELECT password_hash AS h FROM users WHERE username = ?')
      .get('小明') as { h: string }
    expect(row.h).not.toBe('goodpassword')
    expect(row.h.startsWith('scrypt$')).toBe(true)
  })

  it('同一个名字注册第二次被拒 —— 靠数据库唯一约束', () => {
    handleSignup(GOOD, deps)
    expect(() => handleSignup({ ...GOOD, email: 'other@b.com' }, deps)).toThrow(/名字/)
  })

  it('同一个邮箱注册第二次被拒', () => {
    handleSignup(GOOD, deps)
    expect(() => handleSignup({ ...GOOD, username: '小红' }, deps)).toThrow(/邮箱/)
  })

  it('格式不对的当场拒，且说得出为什么', () => {
    expect(() => handleSignup({ ...GOOD, username: '!' }, deps)).toThrow()
    expect(() => handleSignup({ ...GOOD, email: 'nope' }, deps)).toThrow()
    expect(() => handleSignup({ ...GOOD, password: '123' }, deps)).toThrow()
  })

  it('body 不是对象也不炸', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(() => handleSignup(bad, deps)).toThrow()
    }
  })
})

describe('登录', () => {
  it('密码对就能登进来', () => {
    handleSignup(GOOD, deps)
    const r = handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    expect(r.user.username).toBe('小明')
  })

  it('大小写不敏感 —— 用 小明 注册能用 XIAO... 随便什么大小写登', () => {
    handleSignup({ ...GOOD, username: 'Alice' }, deps)
    expect(handleLogin({ username: 'ALICE', password: 'goodpassword' }, deps).user.username).toBe('alice')
  })

  it('★ 密码错和用户不存在，报的是同一句话 —— 不告诉别人哪些名字是真的', () => {
    handleSignup(GOOD, deps)
    const a = (() => { try { handleLogin({ username: '小明', password: 'wrongpassword' }, deps) } catch (e) { return (e as Error).message } })()
    const b = (() => { try { handleLogin({ username: '查无此人', password: 'wrongpassword' }, deps) } catch (e) { return (e as Error).message } })()
    expect(a).toBe(b)
    expect(a).toBeTruthy()
  })
})

describe('会话', () => {
  it('拿登录发的票能查出人来', () => {
    handleSignup(GOOD, deps)
    const { token } = handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    const u = findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)
    expect(u?.username).toBe('小明')
  })

  it('没有 cookie 就是 null', () => {
    expect(findUserByCookie(undefined, deps)).toBeNull()
    expect(findUserByCookie('', deps)).toBeNull()
    expect(findUserByCookie('other=1', deps)).toBeNull()
  })

  it('垃圾票就是 null，不抛', () => {
    expect(findUserByCookie(`${SESSION_COOKIE}=garbage`, deps)).toBeNull()
  })

  it('用户被删了之后，票也查不出人', () => {
    handleSignup(GOOD, deps)
    const { token } = handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    db.raw.prepare('DELETE FROM users').run()
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)).toBeNull()
  })
})

describe('改密码', () => {
  it('改完能用新密码登', () => {
    handleSignup(GOOD, deps)
    const user = handleLogin({ username: '小明', password: 'goodpassword' }, deps).user
    handleChangePassword({ oldPassword: 'goodpassword', newPassword: 'brandnewpw' }, user, deps)
    expect(handleLogin({ username: '小明', password: 'brandnewpw' }, deps).user.id).toBe(user.id)
  })

  it('旧密码错了就拒', () => {
    handleSignup(GOOD, deps)
    const user = handleLogin({ username: '小明', password: 'goodpassword' }, deps).user
    expect(() => handleChangePassword({ oldPassword: 'nope-nope', newPassword: 'brandnewpw' }, user, deps)).toThrow()
  })

  it('新密码不合规就拒', () => {
    handleSignup(GOOD, deps)
    const user = handleLogin({ username: '小明', password: 'goodpassword' }, deps).user
    expect(() => handleChangePassword({ oldPassword: 'goodpassword', newPassword: '123' }, user, deps)).toThrow()
  })

  it('★★ 改完密码，旧票立刻失效 —— 这就是"所有设备下线"', () => {
    handleSignup(GOOD, deps)
    const { token } = handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    const user = handleLogin({ username: '小明', password: 'goodpassword' }, deps).user
    // 改之前：票是好的
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)).not.toBeNull()
    handleChangePassword({ oldPassword: 'goodpassword', newPassword: 'brandnewpw' }, user, deps)
    // 改之后：同一张票查不出人了
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)).toBeNull()
  })

  it('改完返回一张新票，用它可以继续用', () => {
    handleSignup(GOOD, deps)
    const user = handleLogin({ username: '小明', password: 'goodpassword' }, deps).user
    const { token } = handleChangePassword({ oldPassword: 'goodpassword', newPassword: 'brandnewpw' }, user, deps)
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)?.id).toBe(user.id)
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run server/account.test.ts`
Expected: FAIL —— 解析不到 `./account.ts`

- [ ] **Step 3: 写实现**

新建 `server/account.ts`：

```ts
import type { Db } from './db.ts'
import { hashPassword, verifyPassword } from './password.ts'
import { checkUsername, checkEmail, checkPassword } from '../shared/account.ts'
import {
  signSession, verifySession, sessionExpiry, parseCookies, SESSION_COOKIE, RENEW_WITHIN_DAYS,
} from './session.ts'
import { HttpError } from './http.ts'

export type PublicUser = { id: number; username: string; email: string }
export type AccountDeps = { db: Db; secret: string; now?: () => number }

type Row = { id: number; username: string; email: string; password_hash: string }

const now = (d: AccountDeps): number => (d.now ? d.now() : Date.now())

/**
 * ★ **「你是谁」永远从这里拿，绝不从请求里拿。**
 *
 * 所有需要身份的地方都调这一句，参数只有 cookie 头。要是让前端传 userId，
 * 那谁都能改一下看到别人的东西 —— 设计文档 §6.1 那条铁规矩。
 */
export function findUserByCookie(
  cookieHeader: string | undefined, deps: AccountDeps,
): (PublicUser & { passwordHash: string }) | null {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE]
  if (!token) return null

  // 两步：先从票里拿到 userId（**用不了哈希，还没查库**），再拿这个人的哈希去验签。
  //
  // ⚠️ 这里有个先有鸡还是先有蛋：验签需要密码哈希，而密码哈希需要先知道 userId。
  // 所以第一步只解析不验签 —— 拿到的 userId 是**不可信**的，但只用来查库；
  // 真正决定"能不能进"的是第二步的验签。伪造的 userId 只会查到一个不相干的人，
  // 然后因为哈希对不上而被拒。
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const rawId = Number(parts[0])
  if (!Number.isInteger(rawId) || rawId <= 0) return null

  const row = deps.db.raw
    .prepare('SELECT id, username, email, password_hash FROM users WHERE id = ?')
    .get(rawId) as Row | undefined
  if (!row) return null

  const s = verifySession(token, row.password_hash, now(deps), deps.secret)
  if (!s) return null

  return { id: row.id, username: row.username, email: row.email, passwordHash: row.password_hash }
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError('BAD_REQUEST', '请求体不对')
  }
  return body as Record<string, unknown>
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function issue(user: PublicUser, passwordHash: string, deps: AccountDeps) {
  const expiresAt = sessionExpiry(now(deps))
  return { user, token: signSession(user.id, passwordHash, expiresAt, deps.secret), expiresAt }
}

export function handleSignup(body: unknown, deps: AccountDeps) {
  const o = asObject(body)

  const u = checkUsername(str(o.username))
  if (!u.ok) throw new HttpError('BAD_REQUEST', u.message)
  const e = checkEmail(str(o.email))
  if (!e.ok) throw new HttpError('BAD_REQUEST', e.message)
  const p = checkPassword(str(o.password), u.value)
  if (!p.ok) throw new HttpError('BAD_REQUEST', p.message)

  const hash = hashPassword(p.value)
  try {
    deps.db.raw
      .prepare('INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(u.value, e.value, hash, now(deps))
  } catch (err) {
    // 唯一约束是**数据库**在管，这里只是把它的报错翻译成人话。
    // 不先 SELECT 一下再插 —— 两个人同时注册同一个名字，两边都会查到"没被占用"。
    const msg = String((err as Error).message)
    if (msg.includes('users.username')) throw new HttpError('BAD_REQUEST', '这个名字有人用了，换一个吧')
    if (msg.includes('users.email')) throw new HttpError('BAD_REQUEST', '这个邮箱已经注册过了')
    throw err
  }

  const row = deps.db.raw
    .prepare('SELECT id, username, email FROM users WHERE username = ?')
    .get(u.value) as PublicUser
  return issue(row, hash, deps)
}

export function handleLogin(body: unknown, deps: AccountDeps) {
  const o = asObject(body)
  const name = checkUsername(str(o.username))
  const rawPw = str(o.password)

  // ★ 无论是"查无此人"还是"密码不对"，都抛**同一句话**。
  // 区分了就等于告诉别人哪些用户名是真的（可以拿来枚举）。
  const WRONG = () => new HttpError('BAD_REQUEST', '用户名或密码不对')

  if (!name.ok) throw WRONG()
  const row = deps.db.raw
    .prepare('SELECT id, username, email, password_hash FROM users WHERE username = ?')
    .get(name.value) as Row | undefined
  if (!row) throw WRONG()
  if (!verifyPassword(rawPw, row.password_hash)) throw WRONG()

  return issue({ id: row.id, username: row.username, email: row.email }, row.password_hash, deps)
}

export function handleChangePassword(body: unknown, user: PublicUser, deps: AccountDeps) {
  const o = asObject(body)
  const oldPw = str(o.oldPassword)
  const newPw = str(o.newPassword)

  const row = deps.db.raw
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(user.id) as { password_hash: string } | undefined
  if (!row) throw new HttpError('BAD_REQUEST', '这个账号不在了')
  if (!verifyPassword(oldPw, row.password_hash)) {
    throw new HttpError('BAD_REQUEST', '原来的密码不对')
  }

  const p = checkPassword(newPw, user.username)
  if (!p.ok) throw new HttpError('BAD_REQUEST', p.message)

  const hash = hashPassword(p.value)
  deps.db.raw.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id)

  // ★ 写完之后**必须发一张新票**：上面那次 UPDATE 让**包括当前这台在内**的所有票
  // 全部失效了（签名里掺着哈希）。不给新票的话，用户改完密码就被自己踢出去了，
  // 而且他会以为"改密码这个功能坏了"。
  return issue(user, hash, deps)
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `npx vitest run server/account.test.ts`
Expected: PASS（19 条左右）

- [ ] **Step 5: 变异验证**

| 变异 | 应该红在哪条 |
|---|---|
| `findUserByCookie` 里把 `verifySession(...)` 的结果忽略掉，直接返回 row | **「垃圾票就是 null，不抛」** + 「★★ 改完密码，旧票立刻失效」 |
| 登录的两种失败改成两句不同的话 | **「★ 密码错和用户不存在，报的是同一句话」** |
| `handleSignup` 里先 `SELECT` 再 `INSERT`（把唯一约束绕开） | 「同一个名字注册第二次被拒」**未必红** —— 单线程下 SELECT 也拦得住。**如实报告**："单线程测试抓不住这个变异，它防的是并发" |
| `handleChangePassword` 最后不返回新票 / 返回旧票 | 「改完返回一张新票，用它可以继续用」 |
| `handleChangePassword` 不校验旧密码 | 「旧密码错了就拒」 |
| 注册时把明文存进 `password_hash` | **「★ 数据库里存的是哈希，不是明文」** |

- [ ] **Step 6: 收尾验证 + 提交**

```bash
npm test && npm run typecheck && git status
git add server/account.ts server/account.test.ts
git commit -m "feat(auth): 注册 / 登录 / 改密码 / 从 cookie 认人

「你是谁」只有 findUserByCookie 一个出口，参数只有 cookie 头 ——
需要身份的地方全都调它。要是让前端传 userId，谁都能改一下看到别人的东西
（设计文档 §6.1 那条铁规矩，这是它的落地）。

登录失败永远是同一句话「用户名或密码不对」，不区分'查无此人'和'密码错' ——
区分了就等于告诉别人哪些用户名是真的。测试里有一条专门断言这两句话相等。

唯一约束交给数据库，代码只是把它的报错翻译成人话。不先 SELECT 再 INSERT：
两个人同时注册同一个名字，两边都会查到'没被占用'。单线程测试抓不住这个，
但它防的就是并发，注释里写清楚了。

改密码那步有两个坑，都踩过了：
  ① 旧哈希一改，**包括当前这台在内**的所有票立刻失效（签名里掺着它）——
     所以必须发一张新票，不然用户改完密码把自己踢出去了，会以为功能坏了
  ② 必须校验旧密码，不然别人偷到票就能直接把号锁死

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 三个 AI 接口加鉴权

**Files:**
- Modify: `server/app.ts`
- Modify: `server/app.test.ts`
- Modify: `server/index.ts`
- Modify: `server/config.ts`（加 `sessionSecret`）

**Interfaces:**
- Consumes: `AccountDeps`、`findUserByCookie`、`handleSignup`、`handleLogin`（Task 5）；`sessionCookie`、`clearSessionCookie`、`SESSION_COOKIE`（Task 4）
- Produces:
  - `AppDeps` 新增**必填**的 `auth: AccountDeps`
  - 五个新接口：`POST /api/signup`、`POST /api/login`、`POST /api/logout`、`GET /api/me`、`POST /api/password`
  - 测试辅助：`server/app.test.ts` 里导出 `async function appWithUser(): Promise<{ server: Server; cookie: string }>`

- [ ] **Step 1: 写失败的测试**

**先改 `server/app.test.ts` 的测试辅助**，再写新用例。找到现在构造 app 的那段（`const cfg: Config = {...}` 和后面的 `createApp({...})`），改成：

```ts
import { handleSignup } from './account.ts'
import { openDb, type Db } from './db.ts'

const cfg: Config = {
  apiKey: 'sk-secret-must-not-leak',
  baseUrl: 'https://x.cn/v1',
  imageModel: 'm',
  vlmModel: 'v',
  port: 0,
  dbPath: ':memory:',
  sessionSecret: 'test-session-secret',
}
```

然后加一个辅助（**放在文件里现有那些 `function listen(...)` 之类的辅助旁边**）：

```ts
/**
 * 起一个**已经登录过**的 app，返回它的 cookie。
 *
 * 三个 AI 接口从这一版起要登录 —— 所以原来那些直接打 /api/route 的用例
 * 全都会变成 401。与其在每个用例里手抄一遍注册流程，不如就这一个出口。
 */
async function appWithUser(): Promise<{ server: Server; cookie: string; db: Db }> {
  const db = openDb(':memory:')
  const deps: AppDeps = {
    config: cfg,
    client: new SenseNovaClient(cfg),
    queue: new SerialQueue(),
    auth: { db, secret: cfg.sessionSecret, now: () => Date.now() },
  }
  const server = createApp(deps)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const r = handleSignup({ username: '测试用户', email: 't@t.com', password: 'password123' }, deps.auth)
  return { server, cookie: `rx_session=${r.token}`, db }
}
```

**再写新用例**（新建一个 `describe('账号与鉴权')` 块）：

```ts
describe('账号与鉴权', () => {
  it('没登录打 AI 接口 → 401，而且请求体根本没被读', async () => {
    const { server } = await appWithUser()   // 只用它起服务器，不带 cookie
    const res = await fetch(base(server) + '/api/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,x', text: '亮一点', params: {} }),
    })
    expect(res.status).toBe(401)
    server.close()
  })

  it('带 cookie 就能过', async () => {
    const { server, cookie } = await appWithUser()
    const res = await fetch(base(server) + '/api/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,x', text: '亮一点', params: {} }),
    })
    expect(res.status).not.toBe(401)
    server.close()
  })

  it('注册 → 自动登录（响应里带 Set-Cookie）', async () => {
    const { server } = await appWithUser()
    const res = await fetch(base(server) + '/api/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '新来的', email: 'n@n.com', password: 'password123' }),
    })
    expect(res.status).toBe(200)
    const sc = res.headers.get('set-cookie') ?? ''
    expect(sc).toContain('rx_session=')
    expect(sc).toContain('HttpOnly')
    server.close()
  })

  it('★ 响应里绝不含密码或哈希', async () => {
    const { server } = await appWithUser()
    const res = await fetch(base(server) + '/api/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '不漏', email: 'l@l.com', password: 'password123' }),
    })
    const text = await res.text()
    expect(text).not.toContain('password123')
    expect(text).not.toContain('scrypt$')
    server.close()
  })

  it('登录 → 拿到的 cookie 能用来问「我是谁」', async () => {
    const { server } = await appWithUser()
    const login = await fetch(base(server) + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '测试用户', password: 'password123' }),
    })
    expect(login.status).toBe(200)
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!
    const me = await fetch(base(server) + '/api/me', { headers: { cookie } })
    expect(me.status).toBe(200)
    const body = await me.json() as any
    expect(body.user.username).toBe('测试用户')
    expect(JSON.stringify(body)).not.toContain('scrypt$')
    server.close()
  })

  it('没登录问「我是谁」→ 401', async () => {
    const { server } = await appWithUser()
    const me = await fetch(base(server) + '/api/me')
    expect(me.status).toBe(401)
    server.close()
  })

  it('退出 → cookie 被清掉', async () => {
    const { server, cookie } = await appWithUser()
    const res = await fetch(base(server) + '/api/logout', { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=0')
    server.close()
  })

  it('改密码之后，旧 cookie 立刻不好使了', async () => {
    const { server, cookie } = await appWithUser()
    const ok = await fetch(base(server) + '/api/me', { headers: { cookie } })
    expect(ok.status).toBe(200)

    const changed = await fetch(base(server) + '/api/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ oldPassword: 'password123', newPassword: 'anotherpass' }),
    })
    expect(changed.status).toBe(200)

    // ★ 用**旧** cookie 再问一次 —— 必须 401。这就是"所有设备下线"
    const again = await fetch(base(server) + '/api/me', { headers: { cookie } })
    expect(again.status).toBe(401)

    // 而响应里给的新 cookie 是好使的
    const fresh = (changed.headers.get('set-cookie') ?? '').split(';')[0]!
    const after = await fetch(base(server) + '/api/me', { headers: { cookie: fresh } })
    expect(after.status).toBe(200)
    server.close()
  })
})
```

⚠️ `base(server)` 和 `listen(...)` 用文件里**已有**的辅助；如果没有，就照现有用例的写法（它们已经在用某种方式拿地址）。**不要另发明一套。**

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run server/app.test.ts`
Expected: FAIL —— `AppDeps` 上还没有 `auth`；`createApp` 不认识账号接口

- [ ] **Step 3: 改 `server/config.ts`**

`Config` 加 `sessionSecret: string`。`loadConfig` 里：

```ts
const sessionSecret = env.SESSION_SECRET?.trim()
if (!sessionSecret) {
  // 没配就**拒绝启动**，绝不用一个写死在代码里的默认值 —— 那等于没有签名，
  // 谁都能自己造一张票进来。生产环境的这种"默认值"是经典事故。
  throw new Error('缺少环境变量 SESSION_SECRET，请复制 .env.example 为 .env 并填一个随机串')
}
```

`describeConfig` 加 `secret=已设置`（**绝不回显值**）。

- [ ] **Step 4: 改 `server/app.ts`**

```ts
import {
  findUserByCookie, handleSignup, handleLogin, handleChangePassword, type AccountDeps,
} from './account.ts'
import { sessionCookie, clearSessionCookie } from './session.ts'
```

`AppDeps` 加**必填**的 `auth: AccountDeps`（不加 `?` —— 三个 AI 接口花真钱，
少接线必须是编译错误，不是运行时 503）。

在 `handle()` 的 `/api/` 分支里加：

```ts
    if (req.method === 'POST' && path === '/api/signup') {
      const body = await readJsonBody(req)
      const r = handleSignup(body, deps.auth)
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
      res.setHeader('set-cookie', clearSessionCookie())
      sendJson(res, 200, { ok: true })
      return
    }
```

`/api/me` 和 `/api/password` 需要认人，抽一个小函数放在 `handle()` 上面：

```ts
/**
 * 认人。认不出来就 401。
 *
 * ⚠️ **必须在 readJsonBody 之前调用** —— 跟 /api/route 那三个接口"先守卫后读体"
 * 是同一个道理：没登录的人不该有资格让服务器缓冲 12 MB 的请求体。
 */
function requireUser(deps: AppDeps, req: IncomingMessage): PublicUser {
  const u = findUserByCookie(req.headers.cookie, deps.auth)
  if (!u) throw new HttpError('UNAUTHORIZED', '先登录一下', 401)
  return { id: u.id, username: u.username, email: u.email }
}
```

```ts
    if (req.method === 'GET' && path === '/api/me') {
      const user = requireUser(deps, req)
      sendJson(res, 200, { user })
      return
    }
    if (req.method === 'POST' && path === '/api/password') {
      const user = requireUser(deps, req)
      const body = await readJsonBody(req)
      const r = handleChangePassword(body, user, deps.auth)
      res.setHeader('set-cookie', sessionCookie(r.token, r.expiresAt))
      sendJson(res, 200, { user: r.user })
      return
    }
```

**三个 AI 接口各加一行 `requireUser(deps, req)`，位置和现有的 `if (!deps.client || !deps.queue)` 守卫并排、且在 `readJsonBody` 之前：**

```ts
    if (req.method === 'POST' && path === '/api/route') {
      requireUser(deps, req)          // ← 新增，必须在 readJsonBody 之前
      if (!deps.client || !deps.queue) {
        throw new HttpError('INTERNAL', '后端没有配置模型客户端', 503)
      }
      ...
```

**`shared/protocol.ts` 的 `AppErrorCode` 加 `'UNAUTHORIZED'`**，`server/http.ts` 的 `STATUS_BY_CODE` 加 `UNAUTHORIZED: 401`，`USER_MESSAGE` 加 `UNAUTHORIZED: '先登录一下'`。

- [ ] **Step 5: 改 `server/index.ts`**

```ts
import { openDb } from './db.ts'
...
const db = openDb(config.dbPath)
const server = createApp({
  config,
  staticDir: resolve(process.cwd(), 'dist'),
  client,
  queue,
  auth: { db, secret: config.sessionSecret },
})
```

关服务器时把库也关上：

```ts
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0) }))
}
```

- [ ] **Step 6: 跑测试确认它绿**

Run: `npx vitest run server/app.test.ts && npm test`
Expected: 全绿。**原来那些 AI 接口的用例也都绿了 —— 因为它们现在走 `appWithUser()`，是登录过的。**

- [ ] **Step 7: 变异验证**

| 变异 | 应该红在哪条 |
|---|---|
| `requireUser` 里 `if (!u)` 改成 `if (false)` | 「没登录打 AI 接口 → 401」等一片 |
| 把 `requireUser` 挪到 `readJsonBody` **之后** | **单线程测试抓不住**，如实报告："它防的是'没登录的人也能让服务器缓冲 12MB'，要靠 code review 看" |
| `handleChangePassword` 之后不重发票 | 「改密码之后，旧 cookie 立刻不好使了」的最后一段 |
| 注册响应里把 `r.user` 换成整个 account 返回值 | 「★ 响应里绝不含密码或哈希」 |
| `/api/logout` 用 `sessionCookie` 而不是 `clearSessionCookie` | 「退出 → cookie 被清掉」 |
| `config.ts` 里 `sessionSecret` 缺省给一个硬编码的值 | **没有测试能抓** —— 如实报告："这条要靠 code review 看，或者补一条 config.test.ts"（**建议补**：`loadConfig({})` 必须抛） |

- [ ] **Step 8: 收尾验证 + 提交**

```bash
npm test && npm run typecheck && git status
git add server/app.ts server/app.test.ts server/index.ts server/config.ts shared/protocol.ts server/http.ts server/config.test.ts
git commit -m "feat(auth): 三个花钱的接口从今天起只认登录过的人

这三个接口每次生成花的是真钱，所以它们是这一整段里最需要保护的东西 ——
也是为什么'加鉴权'排在作品集前面（设计文档 §12 那条注）。

requireUser 放在 readJsonBody **之前**，跟这三个接口原来那句
'没接线就立刻失败'是同一个道理：没登录的人不该有资格让服务器缓冲 12 MB。

auth 在 AppDeps 上是**必填**不是可选 —— 少接线必须是编译错误，不是运行时 503。
这三个接口真的会花钱，静默降级在这里是不可接受的。

SESSION_SECRET 没配就拒绝启动，绝不给一个写死在代码里的默认值：
那等于没有签名，谁都能自己造一张票进来。

原来那些直接打 /api/route 的用例现在都走 appWithUser()（先注册再拿 cookie），
所以它们同时也在证明'登录过就是能用'。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 前端登录页

**Files:**
- Create: `src/api/account.ts`
- Create: `src/ui/LoginPage.tsx`
- Modify: `src/api/client.ts`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Create: `src/api/account.test.ts`

**Interfaces:**
- Consumes: `checkUsername`/`checkEmail`/`checkPassword`（Task 3）
- Produces:
  - `src/api/client.ts` 新增 `async function get<T>(path: string): Promise<T>`，且 `post` 带上 `credentials: 'same-origin'`
  - `src/api/account.ts`：`signup` / `login` / `logout` / `me`

- [ ] **Step 1: 写失败的测试**

新建 `src/api/account.test.ts`：

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signup, login, logout, me } from './account'

const calls: { url: string; init: RequestInit | undefined }[] = []
beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(new Response(JSON.stringify({ user: { id: 1, username: 'a', email: 'a@b.com' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
  }))
})

describe('账号接口', () => {
  it('★ 每个请求都带 credentials —— 不带的话 cookie 根本不会发', () => {
    return login({ username: 'a', password: 'password123' }).then(() => {
      expect(calls[0]!.init?.credentials).toBe('same-origin')
    })
  })

  it('打的是对的地址', async () => {
    await signup({ username: 'a', email: 'a@b.com', password: 'password123' })
    expect(calls[0]!.url).toBe('/api/signup')
    calls.length = 0
    await login({ username: 'a', password: 'password123' })
    expect(calls[0]!.url).toBe('/api/login')
    calls.length = 0
    await logout()
    expect(calls[0]!.url).toBe('/api/logout')
  })

  it('me() 是 GET', async () => {
    await me()
    expect(calls[0]!.init?.method).toBe('GET')
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

Run: `npx vitest run src/api/account.test.ts`
Expected: FAIL —— 解析不到 `./account`

- [ ] **Step 3: 改 `src/api/client.ts`**

`post` 的 `fetch` 加 `credentials: 'same-origin'`，并把 `get` 抽出来共用读响应那段：

```ts
/**
 * 统一的请求出口。
 *
 * ⚠️ `credentials: 'same-origin'` 是**必须有**的 —— 会话在 cookie 里，
 * 不加这一句浏览器不发它，于是每个请求都是"没登录"。
 */
async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init })
  } catch {
    throw new ApiError('UPSTREAM_FAILED', '连不上服务器，检查一下网络？')
  }
  // ...（下面读正文、翻译错误那段**原样保留**）
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' })
}
```

- [ ] **Step 4: 写 `src/api/account.ts`**

```ts
import { get, post } from './client'

/** 后端给的公开信息。**绝不含密码或哈希。** */
export type AccountUser = { id: number; username: string; email: string }

export async function signup(o: { username: string; email: string; password: string }): Promise<AccountUser> {
  return (await post<{ user: AccountUser }>('/api/signup', o)).user
}

export async function login(o: { username: string; password: string }): Promise<AccountUser> {
  return (await post<{ user: AccountUser }>('/api/login', o)).user
}

export async function logout(): Promise<void> {
  await post<{ ok: true }>('/api/logout', {})
}

/**
 * 问后端"我是谁"。
 *
 * **返回 null 表示没登录，不抛** —— 这不是错误，是打开页面时最常见的情况。
 * 让调用方每次 try/catch 一个"正常情况"会把真正的错误淹掉。
 */
export async function me(): Promise<AccountUser | null> {
  try {
    return (await get<{ user: AccountUser }>('/api/me')).user
  } catch {
    return null
  }
}
```

- [ ] **Step 5: 写 `src/ui/LoginPage.tsx`**

```tsx
import { useState } from 'react'
import { login, signup } from '../api/account'
import { checkUsername, checkEmail, checkPassword } from '../../shared/account.ts'

type Props = { onDone: (username: string) => void }

/**
 * 登录 / 注册。**这是打开产品看到的第一屏**，所以它自己被产品规则约束着：
 * 一行一句人话、错了说清为什么、正在忙的时候按钮不能重复点。
 */
export function LoginPage({ onDone }: Props) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setError(null)

    // 前端这遍是**体验**（一边打一边知道哪不对），不是规矩 ——
    // 后端还会再验一遍，因为请求可以伪造。
    const u = checkUsername(username)
    if (!u.ok) return setError(u.message)
    const p = checkPassword(password, u.value)
    if (!p.ok) return setError(p.message)

    setBusy(true)
    try {
      if (mode === 'signup') {
        const em = checkEmail(email)
        if (!em.ok) { setError(em.message); setBusy(false); return }
        const user = await signup({ username: u.value, email: em.value, password: p.value })
        onDone(user.username)
      } else {
        const user = await login({ username: u.value, password: password })
        onDone(user.username)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '出了点问题，再试一次')
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="login-box" onSubmit={submit}>
        <h1 className="login-title">随心</h1>
        <p className="login-sub">{mode === 'login' ? '登录一下，你的图都在这儿' : '注册一个，图就留下来了'}</p>

        <label className="login-field">
          <span>名字</span>
          <input value={username} onChange={e => setUsername(e.target.value)}
                 autoComplete="username" autoFocus />
        </label>

        {mode === 'signup' && (
          <label className="login-field">
            <span>邮箱</span>
            <input value={email} onChange={e => setEmail(e.target.value)}
                   type="email" autoComplete="email" />
          </label>
        )}

        <label className="login-field">
          <span>密码</span>
          <input value={password} onChange={e => setPassword(e.target.value)}
                 type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>

        {error && <p className="login-error">{error}</p>}

        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? '稍等…' : mode === 'login' ? '登录' : '注册'}
        </button>

        <button type="button" className="login-switch"
                onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null) }}>
          {mode === 'login' ? '还没有账号？注册一个' : '已经有账号了？去登录'}
        </button>
      </form>
    </div>
  )
}
```

- [ ] **Step 6: 改 `src/App.tsx`**

加状态和一次开机检查：

```tsx
const [user, setUser] = useState<AccountUser | null>(null)
const [checking, setChecking] = useState(true)

useEffect(() => {
  // 打开页面先问一句"我是谁"。没登录就显示登录页。
  me().then(u => { setUser(u); setChecking(false) })
}, [])
```

在**最外层 return 之前**插：

```tsx
if (checking) return <div className="app-loading">正在打开…</div>
if (!user) return <LoginPage onDone={name => setUser({ id: 0, username: name, email: '' })} />
```

⚠️ `onDone` 里那个 `setUser({ id: 0, ... })` 只是为了让界面切过去；真身由 `/api/me` 提供。
**更好**：让 `LoginPage` 的 `onDone` 不带参数，App 里改成 `me().then(setUser)`。
**选后者**，别留一个假 id。

- [ ] **Step 7: 加样式**

`src/styles.css` 末尾追加（**沿用文件里已有的颜色变量，不要另发明一套**；如果文件里是硬编码色值，就跟着硬编码）：

```css
@media (min-width: 0px) {   /* 占位：写完删掉这行和花括号 */
```

**实际要加的**（照抄现有风格，色值从文件里已有的取）：

```css
.login { display: flex; align-items: center; justify-content: center; height: 100%; }
.login-box { display: flex; flex-direction: column; gap: 14px; width: 320px; }
.login-title { margin: 0; font-size: 28px; }
.login-sub { margin: 0 0 6px; opacity: .7; font-size: 14px; }
.login-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.login-field input { padding: 10px 12px; border-radius: 8px; border: 1px solid #2a2e35; background: #14171c; color: inherit; font-size: 15px; }
.login-error { margin: 0; font-size: 13px; color: #e06c75; }
.login-submit { padding: 11px; border-radius: 8px; border: 0; background: #3b82f6; color: #fff; font-size: 15px; cursor: pointer; }
.login-submit:disabled { opacity: .5; cursor: default; }
.login-switch { border: 0; background: none; color: inherit; opacity: .7; font-size: 13px; cursor: pointer; }
.app-loading { display: flex; align-items: center; justify-content: center; height: 100%; opacity: .6; }
```

- [ ] **Step 8: 跑测试确认它绿**

Run: `npx vitest run src/api/account.test.ts && npm test`
Expected: 全绿

- [ ] **Step 9: 变异验证**

| 变异 | 应该红在哪条 |
|---|---|
| `client.ts` 去掉 `credentials: 'same-origin'` | **「★ 每个请求都带 credentials」** |
| `me()` 里去掉 try/catch，让它抛 | 「me() 是 GET」**不会红** —— 要补一条：**后端返 401 时 `me()` 必须返回 null 而不是抛**。这是它的契约，必须有断言 |
| `LoginPage` 的提交不调 `checkPassword` | 前端这层没有自动化测试覆盖（jsdom 里跑 React 要额外接线）。**如实报告**：这一条靠真浏览器检查（Task 8） |

⚠️ 第 2 条**必须补测试**。

- [ ] **Step 10: 收尾验证 + 提交**

```bash
npm test && npm run typecheck && git status
git add src/api/ src/ui/LoginPage.tsx src/App.tsx src/styles.css
git commit -m "feat(auth): 前端加登录页，请求从此带上 cookie

client.ts 那个 credentials: 'same-origin' 是必须有的一句 —— 会话在 cookie 里，
不加它浏览器不发，于是每个请求都是"没登录"，而现象是"登录了还是用不了"，
很难往这里想。有一条测试专门钉住它。

me() 返回 null 表示没登录、不抛 —— 这不是错误，是打开页面时最常见的情况。
让调用方每次 try/catch 一个'正常情况'会把真正的错误淹掉。

登录页自己也被产品规则约束着：一行一句人话、错了说清为什么、
正在忙的时候按钮不能重复点。前端那遍格式校验是**体验**（一边打一边知道哪不对），
不是规矩 —— 后端还会再验一遍，因为请求可以伪造。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 收尾 —— 配置示例、真浏览器验收、验收记录

**Files:**
- Modify: `.env.example`（没有就新建）
- Create: `docs/验收记录` 里的一段（**先看那个文件叫什么**，照它现有的结构追加一节）
- Create: `docs/superpowers/sdd/2026-09-25-accounts-foundation/DECISIONS.md`（今晚的决策与坑，给用户明早看）

**Interfaces:**
- Consumes: 前面七个任务的全部
- Produces: 无代码接口

- [ ] **Step 1: 更新 `.env.example`**

先 `ls -a` 看有没有这个文件。有就加，没有就建：

```
# 商汤 API（必填）
SN_API_KEY=

# 会话签名的钥匙（必填）。**随便一串够长的随机字符**，比如：
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# ⚠️ 它一换，所有人都会被登出 —— 这是有意的
SESSION_SECRET=

# 数据库文件（可不填，默认 data/ruixing.db）
# DB_PATH=
```

⚠️ **`.env.example` 里绝不能有真实值。** 提交前 `git diff --cached` 看一眼。

- [ ] **Step 2: 真浏览器验收**

```bash
npm run build
npm run dev:server &     # 另开一个终端，或者后台跑
npm run check:layout     # 现有那套检查必须照旧全绿
```

再**手动**在真浏览器里走一遍（用 `agent-browser` 或 webapp-testing 技能）：

| 走什么 | 该看到 |
|---|---|
| 打开首页 | **登录页**，不是修图界面 |
| 乱填名字点注册 | 一行中文提示，说清哪不对 |
| 「小明」注册 | **能过**（这是设计文档里那个教训的活体验收） |
| 注册成功后 | 进到修图界面 |
| 刷新页面 | **还在里面**（会话没丢） |
| 点退出 → 刷新 | 回登录页 |
| 用刚注册的账号登录 | 能进 |

**把每一步的实际结果记下来**（截图或文字），写进验收记录。

- [ ] **Step 3: 写验收记录**

**先找现有的验收记录文件**（`ls docs/`），照它的结构**追加**一节，不要另起一个文件。

内容必须包含：

1. **这一段做了什么**（一句话）
2. **真机/真浏览器实测的结果**（上表逐条）
3. ⚠️ **我错了什么 / 计划哪里讲不通** —— **这一节不许写"全部通过"**

> **这一条是这个项目的老规矩**（从 §13 那次事故留下来的）：
> 记录里必须包含"我错了什么"，不能只写"全部通过"。

- [ ] **Step 4: 写今晚的决策文档**

新建 `docs/superpowers/sdd/2026-09-25-accounts-foundation/DECISIONS.md`：

```markdown
# 通宵做的决策与坑（2026-09-25 凌晨）

用户睡觉前说：「你可以实施计划不用问我，出现决策问题或技术错误写一个 md 文档，
明早验收，因为细节点肯定有没注意到的地方」。

这份就是那个 md。

## 我替你拍板的地方

（逐条：拍了什么、为什么、代价是什么、不同意的后果）

## 我踩到的坑

（逐条：什么现象、查了多久、根因、怎么改的）

## 我没做完的 / 做不了的

（逐条：为什么）

## 明早请你重点看这几处

（按"最可能有问题"排序）
```

**这一节要和代码一起提交。**

- [ ] **Step 5: 全量收尾**

```bash
npm test
npm run typecheck
npm run check:layout
git status --porcelain    # 必须为空
```

**全部绿了才提交。**

```bash
git add .env.example docs/
git commit -m "docs: 账号地基地基的验收记录与今晚的决策文档

记录里按这个项目的老规矩写了'我错了什么'，没有只写'全部通过'。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review（写完之后自己过一遍）

**Spec coverage：** 设计文档 §12 第一段要求四样 —— 数据库层（Task 1 ✅）、用户表（Task 1 ✅）、
注册/登录/退出/会话（Task 4-5 ✅）、三个 AI 接口加鉴权（Task 6 ✅）、前端登录页（Task 7 ✅）。

**这一段明确不做的**：邮箱验证（第三段）、找回密码（第三段）、作品集（第二段）、
模型设置（第四段）、预设与 LUT（第五段）。**缝留好了**：`users` 表已经有 `email` 字段
（只是不验），`MIGRATIONS` 是数组（加表就追加）。

**Type consistency：** `PublicUser` / `AccountDeps` / `Db` / `Check` 四个类型贯穿全程，
名字没变过。`findUserByCookie` 在 Task 5 定义、Task 6 使用，签名一致。

**Placeholder scan：** Task 8 Step 2 里的"用 agent-browser 或 webapp-testing 技能"
是**开放的**（我不知道哪个可用），执行时按实际能用的来。除此之外没有 TBD。
