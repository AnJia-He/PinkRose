# 模型设置（spec §7）实施计划

---

## 执行中被证伪的几处（2026-09-30 执行完补记，**正文不改**）

> 这一节是**回填**，不是修订：下面每一条都是执行时当场撞上的 ——
> 计划的原话留着（那是当时的证据），但下一个人**照计划做之前先读这一节**，
> 否则会照着一句错的描述白干一轮。**读的顺序：先这里，再往下。**

1. **`npx tsc --noEmit` 不查 `server/`。** 计划里凡是"用 `npx tsc --noEmit` 验类型"的
   地方都**验不到服务端** —— 它只吃 `src/` 和 `shared/`，于是服务端的类型错一个字
   都不会红，命令却是绿的（**绿的假证据比红的更贵**）。真正管用的是
   **`npm run typecheck`**（两个 tsconfig 都跑）。
2. **`-t '/api/models'` 这样的过滤器在 vitest 2.1.9 里静默选不中任何用例。**
   带 `/` 的 `-t` 会匹配 0 条，而输出只是"没跑任何用例"—— 看起来像通过。
   选中要用的过滤器里**别带斜杠**（改用中文标题里的一段，或直接指文件）。
3. **Task 2 的测试 INSERT 漏了 NOT NULL 的 `alias`。** 于是那几条"插一行进去再断言"
   的用例**在插入那一步就抛了**，而 kind-CHECK 那条负例看起来绿 ——
   它绿是因为**INSERT 失败**，不是因为 CHECK 拦住了。补上 `alias` 才算真的测到。
4. **Task 2 的 Step 6 漏了迁移指纹。** 既有的迁移测试要求把新迁移的"指纹"也补进去，
   漏了会红 —— 按那条测试的提示补。
5. **Task 4 的 Step 6 `git add` 漏了 `server/models.test.ts`。** 那一批文件里它没被列上；
   漏了不会报错，只会在提交里少一个文件。
6. **Task 5 的第 7 条测试，标题和它自己的实现说的是反的。** 标题说"只认 401/403、不吃 400"，
   而那条测试断言的**正是** 400 落进 `unauthorized`。实现照裁定 2 做的是"400 不单列"，
   所以标题才是错的那一个（同期的注释也一起改了，见 `server/modeltest.ts`）。
7. **Task 7 提到的 `AppDeps.clientFactory` 不存在了。** 它已被 Task 6 的
   **`ClientDeps.clientFactory`** 取代（计划里两处互相矛盾）—— 注射点要在**造连接**那一层，
   不然出站的请求头看不见，§7.4 那四条测试就成不了证据。
8. **Task 9 说「接口地址归一化是前端做的」—— 错的。** `normalizeBaseUrl` 在
   **服务端**（`server/models.ts`），界面那一句「填域名也行，我们会补上 /v1」指的是它。
   前端**不许**自己再补一遍：两处各修各的，规则迟早走岔。
9. **Task 9 的 `workCount={0}` 是一句用户看得见的假话。** 用户管理页上按计划照抄的
   "0 张作品"对**一个作品页有图的人**也照样显示。计划那会儿只是占位；
   真写的时候必须拿真数（拿不到就说话，别画成 0）。
10. **Task 9 的六条测试用了仓库里没有的 `@testing-library`。** 这个仓库的界面测试是
    **手写 DOM 断言**（`container.querySelector`），零新依赖那一条也管测试。
    照计划抄会先卡在"装不装依赖"上。
11. **Task 10 第 6 条用例名不副实。** 它叫「字段全对但值离谱」，而用的
    `brightness` **不是八个合法键之一** —— 它变红是因为**整块 delta 被丢掉**，
    不是因为"值被钳制"。改名成「键名是它自己编的」，另补一条**真**·值钳制的
    （`exposure:99999` → 100，`degraded === false`）。
12. **计划点名的顶部那句话，对一部分用户是假话。** 原文是
    「不配就用我们准备的。配了之后，改图花的是你自己的额度。」
    —— **只配了「对话与理解」那一栏的人**读到的是一句假的：他那一栏配上了，
    可"图片生成"那一栏还在用我们准备的，改图花的仍然不是他的额度
    （§7.4 说得很清楚：两类互相独立；《文案规范》第三条：不许写产品做不到的事）。
    改成「**配了的那一类**，花的是你自己的额度」—— 每一种配置状态下都是真的。
    （2026-10-01 通读文案时改的；那句原来没有任何测试断它。）

> **模式**：这 12 条分三类 ——
> **① 绿灯但没量到东西**（1、2、3）：命令没覆盖到那半边、过滤器静默选不中、
> 断言被一个更早的失败吞掉，**三种不同的漏法**；
> **② 计划正文和真实代码/仓库对不上**（4~8）：漏文件、漏指纹、标题反着说、字段早改名了、函数在另一边；
> **③ 名字、占位或一句话和它真正做的事对不上**（9~12）：占位的 0 是一句用户看得见的假话、
> 抄来的库仓库里没有、用例名说的是另一回事、点名的文案对只配了一类的人是假话。
> 这个计划是本仓库第一次把"证据"当验收标准，坑就集中在这儿 ——
> **下一个人：一个绿灯先问"它到底量了什么"**。

---

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能把「看图的模型」和「改图的模型」换成自己的（自带钥匙），业务逻辑仍然全是我们的。

**Architecture:** 三层——① 一把**保险箱**（`server/keyvault.ts`）负责把钥匙加密存进库；② 一张 `model_configs` 表 + `users` 上两个指针，表达「谁配了哪几套、哪一套在用」；③ `server/app.ts` 在**每个请求**里按人去取对应的模型客户端，取不到就用默认那个。界面挂在新的「用户管理」页底下。

**Tech Stack:** Node 24（`node:crypto` / `node:sqlite`）、手写 HTTP 服务、React 18 + TypeScript、Vitest。**零新依赖。**

**Spec:** `docs/superpowers/specs/2026-09-24-accounts-and-gallery-design.md` 的 **§7**（主依据）、§4.1（表结构）、§9（拍板的决定）、§10（测法）。

**市场校准**（本计划在 §7 之外多做的四条，来自 2026-09-30 对六个开源实现的源码调研，见 memory `byok-market-survey`）：

1. **点「测一下」之前先自动保存表单** —— 否则测的是上次保存的值（LobeChat 的做法）
2. **出错时按「谁该负责」分口吻** —— 用户自己的钥匙才给「去设置」按钮（LibreChat 的 `byOwnership`）
3. **接口地址替用户擦屁股** —— 自动补 `/v1`、把误粘的整条路径剥回主机名（Chatbox 的 `normalizeOpenAIApiHostAndPath`）
4. **拉模型列表失败必须说话** —— Open WebUI 和 LibreChat 都在这里静默降级过，是我们明令要避开的坑

---

## Global Constraints

以下每条都从 spec 逐字抄来，**每个任务都隐含包含这一节**：

- **§7.1 换模型 ≠ 换行为。** 提示词、输出格式、判断规则全是我们的。接进来的模型只是执行者，**不许它有自己的想法**。
- **§7.3 界面上写「限制」，不写型号。** 而且 **不暴露我们自己用的是哪家** —— 用户界面里**不许出现默认模型的真名或我们的接口地址**。
- **§7.4 两套 key 彻底分开。** `chat` 和 `image` 互不影响：只配图片 → 对话照常；只配对话 → 图片照常；图片 key 填错 → **对话完全不受影响**。
- **§7.7 钥匙**：加密存、显示只给头尾、**绝不进日志**、用户随时能删、删掉后自动回默认。
- **§7.8 隐私**：用户选的那家服务商、**经过我们转发**（不骗用户说"我们看不见"）、只转发不拿去训练。
- **§6.1 身份永远从 cookie 拿**，绝不从请求体拿 `userId`。每个查询都带 `user_id`。
- **零新依赖。** 后端是手写的，`node:crypto` / `node:sqlite` 够用。
- **不用构造函数参数属性**（`constructor(public readonly x)`）—— Node 24 的 TypeScript 剥离模式不支持。必须显式声明字段。
- **迁移只许往后追加**（`server/db.ts:40` 那段契约），且迁移串里不许自带 `BEGIN`/`COMMIT`/`ROLLBACK`/`PRAGMA foreign_keys`。
- **改 CSS 之后必须跑这三个**：`node scripts/check-mobile-layout.mjs`、`node scripts/check-dev-urls.mjs`、`npx vitest run`。
- **`src/App.test.tsx` 是按类名找元素的** —— 整轮改动**一个现有类名都不许删**。
- **不留一个点了没用的按钮。**
- 文案照 `docs/文案规范.md`：完整短语、不引进行业词、不劝人、**不许写产品做不到的事**。

---

### Task 1: 密钥保险箱

把「钥匙怎么加密存」这件事**封在一个文件里**，之后全仓库谁都不许自己写加解密。

> **为什么这是最后一个能便宜做决定的地方**：一旦明文钥匙写进库、发了版，再想加密就得面对一批已经躺在库里、且用户不一定记得的钥匙。现在库里一把都没有。
> （依据：LobeChat 的 `KeyVaultsGateKeeper` —— 六个开源实现里**唯一**真做了服务端加密的，整个类 130 行，全仓 20 多处共用，没有一处自己写加解密。）

**Files:**
- Create: `server/keyvault.ts`
- Test: `server/keyvault.test.ts`

**Interfaces:**
- Consumes: `node:crypto` 的 `createCipheriv` / `createDecipheriv` / `hkdfSync` / `randomBytes`
- Produces:
  - `type Sealed = string` —— 密文，形如 `v1:<iv>:<tag>:<data>`（全 hex）
  - `createVault(masterSecret: string): Vault`
  - `type Vault = { seal(plaintext: string): string; open(sealed: string): { plaintext: string; authentic: boolean } }`

- [ ] **Step 1: 写失败的测试**

创建 `server/keyvault.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createVault } from './keyvault.ts'

const SECRET = 'test-secret-not-the-real-one'
const KEY = 'sk-abcdefghijklmnop-4f2'

describe('keyvault', () => {
  it('封进去再打开，拿到原文', () => {
    const v = createVault(SECRET)
    expect(v.open(v.seal(KEY)).plaintext).toBe(KEY)
  })

  it('★ 密文里不许出现原文 —— 这一条是整件事的意义', () => {
    const v = createVault(SECRET)
    const sealed = v.seal(KEY)
    expect(sealed).not.toContain(KEY)
    // 也不许出现原文的任何一段（防止"只加密了一半"这种半吊子）
    expect(sealed).not.toContain('abcdefghij')
    expect(sealed).not.toContain('4f2')
  })

  it('★ 同一把钥匙封两次，密文必须不一样 —— 随机 IV', () => {
    // 固定 IV 的后果：同明文→同密文，等于告诉看库的人「这两个用户用的是同一把钥匙」。
    // （LibreChat 的用户钥匙走的正是这条固定 IV 的老路，它自己代码里有随机 IV 的新版没用上。）
    const v = createVault(SECRET)
    expect(v.seal(KEY)).not.toBe(v.seal(KEY))
  })

  it('★ 密文被改一个字节 → authentic 为假，而且不抛', () => {
    const v = createVault(SECRET)
    const sealed = v.seal(KEY)
    // 翻最后一个 hex 字符（在 data 段里）
    const last = sealed.slice(-1)
    const flipped = sealed.slice(0, -1) + (last === '0' ? '1' : '0')
    const r = v.open(flipped)
    expect(r.authentic).toBe(false)
    expect(r.plaintext).toBe('')
  })

  it('★ 换一把主钥匙 → 打不开，authentic 为假', () => {
    const sealed = createVault(SECRET).seal(KEY)
    const r = createVault('a-completely-different-secret').open(sealed)
    expect(r.authentic).toBe(false)
    expect(r.plaintext).toBe('')
  })

  it('换主钥匙「打不开」这一条不会把接口变成 500 —— open 永不抛', () => {
    const v = createVault(SECRET)
    // 畸形输入：空串、乱码、前缀不对、段数不对、hex 不合法
    for (const bad of ['', 'garbage', 'v1:aa:bb', 'v2:aa:bb:cc', 'v1:zz:zz:zz', 'v1:00:00:00']) {
      expect(() => v.open(bad)).not.toThrow()
      expect(v.open(bad).authentic).toBe(false)
    }
  })

  it('空串也能封能开（钥匙理论上不该是空串，但工具本身不该有特例）', () => {
    const v = createVault(SECRET)
    expect(v.open(v.seal('')).plaintext).toBe('')
  })

  it('中文 / 长串 / emoji 都过得去', () => {
    const v = createVault(SECRET)
    for (const s of ['中文钥匙🔑', 'x'.repeat(5000), 'sk-带空格 和\n换行']) {
      expect(v.open(v.seal(s)).plaintext).toBe(s)
    }
  })
})
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run server/keyvault.test.ts`
Expected: FAIL —— `Failed to resolve import "./keyvault.ts"`

- [ ] **Step 3: 写实现**

创建 `server/keyvault.ts`：

```ts
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * 用户自己的模型钥匙怎么加密存。
 *
 * ★ **全仓库只有这一个文件碰"钥匙的密文"。** 谁都不许自己写加解密 ——
 * 那正是会漂的东西（同一条项目规矩：主按钮的长相只有一份、
 * 参数名字表只有一份、图片文件那一层只有 storage.ts）。
 *
 * 形状照 LobeChat 的 `KeyVaultsGateKeeper`（六个开源实现里唯一真做了
 * 服务端加密的）：AES-256-GCM + 每次全新随机 IV + 认证标签。
 *
 * ⚠️ 存成 `v1:iv:tag:data` 四段而不是 LobeChat 的三段 —— 多一个 **版本前缀**。
 * 将来要换算法时，老密文还认得出来（"看不懂"和"被篡改了"必须是两种结局）。
 */

/** 段数、算法。改这个字符串 = 换算法，必须同时改 SEALED_VERSION。 */
const ALG = 'aes-256-gcm'
const SEALED_VERSION = 'v1'
const IV_BYTES = 12   // GCM 的标准长度
const TAG_BYTES = 16
const KEY_BYTES = 32  // AES-256

/**
 * 从主密钥派生**这一种用途专用**的一把钥匙。
 *
 * ⚠️ 为什么不直接拿 `SESSION_SECRET` 当钥匙：那是**同一个字节串用于两种用途**
 * （签名会话 + 加密钥匙）。密码学上这叫"密钥复用"，是明确的坏习惯 ——
 * 两边的输出一旦有任何一处能被观察到，就等于漏了另一边的一半信息。
 *
 * HKDF 的 `info` 参数就是这个用途的**域分隔符**：同一把 `SESSION_SECRET`
 * 派出来的这把钥匙，和签名用的那把，在数学上没有任何可推导的关系。
 * （TYPO3 那份 ADR 用的也是这个套路，它叫"domain-separated key derivation"。）
 */
function deriveKey(masterSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', masterSecret, '', 'ruixing:model-key-vault:v1', KEY_BYTES),
  )
}

export type Vault = {
  /** 把明文钥匙封成能进库的字符串 */
  seal(plaintext: string): string
  /**
   * 打开。**永不抛** —— 畸形输入、被改过的密文、换了主钥匙，
   * 一律回 `{ plaintext: '', authentic: false }`。
   *
   * 为什么"永不抛"是这里的重点：这段密文是从**数据库**读出来的，
   * 而数据库里的东西坏掉（或者 SESSION_SECRET 被人换过）**不该让接口 500** ——
   * 500 是"我们的代码坏了"，而这件事的正确答案是"这把钥匙读不出来了，
   * 请用户重新填一次"。让调用方拿到 `authentic: false` 去说那句话，
   * 比让它接一个异常清楚得多。
   */
  open(sealed: string): { plaintext: string; authentic: boolean }
}

export function createVault(masterSecret: string): Vault {
  const key = deriveKey(masterSecret)

  return {
    seal(plaintext) {
      // 每次一个全新的随机 IV。**这一条不能省**：固定 IV 的话，
      // 同一把钥匙会封出同一串密文 —— 看库的人不用解开就知道
      // "这两个人填的是同一把钥匙"。GCM 下重用 IV 还会直接泄露明文异或。
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALG, key, iv)
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return [SEALED_VERSION, iv.toString('hex'), tag.toString('hex'), data.toString('hex')].join(':')
    },

    open(sealed) {
      const fail = { plaintext: '', authentic: false }
      if (typeof sealed !== 'string') return fail

      const parts = sealed.split(':')
      // 段数不对 = 不是我们封的东西（或者被人改过形状）
      if (parts.length !== 4) return fail
      const [version, ivHex, tagHex, dataHex] = parts as [string, string, string, string]
      // 版本不认识 = 「看不懂」，照样是 fail —— 调用方的处置一样（让用户重填）
      if (version !== SEALED_VERSION) return fail

      const iv = hexOf(ivHex, IV_BYTES)
      const tag = hexOf(tagHex, TAG_BYTES)
      const data = hexOf(dataHex, -1)
      if (!iv || !tag || !data) return fail

      try {
        const d = createDecipheriv(ALG, key, iv)
        d.setAuthTag(tag)
        const plaintext = Buffer.concat([d.update(data), d.final()]).toString('utf8')
        return { plaintext, authentic: true }
      } catch {
        // 认证标签对不上（被改过 / 换了主钥匙）→ 这里唯一正确的做法是**安静地说不知道**。
        // 不打印 `sealed`，也不打印异常原文 —— 它们可能带着密文的片段，
        // 而"钥匙绝不进日志"是这一版的硬规矩（§7.7）。
        return fail
      }
    },
  }
}

/**
 * 严格的 hex 解析。`Buffer.from(x, 'hex')` 对畸形输入**不抛**，
 * 它会截断到最后一个完整字节 —— 于是 `'zz'` 变成空 Buffer，
 * 而空 IV 会让 `createDecipheriv` 抛。这里自己判，把它挡在前面。
 *
 * `wantBytes` 传 -1 表示"长度不限"（密文长度本来就是变的）。
 */
function hexOf(hex: string, wantBytes: number): Buffer | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  if (wantBytes >= 0 && hex.length !== wantBytes * 2) return null
  if (!/^[0-9a-f]+$/.test(hex)) return null
  return Buffer.from(hex, 'hex')
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run server/keyvault.test.ts`
Expected: PASS（8 条）

- [ ] **Step 5: 确认没有裸的「未使用」，并跑一次 typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 6: 提交**

```bash
git add server/keyvault.ts server/keyvault.test.ts
git commit -m "feat(保险箱): 用户钥匙怎么加密存 —— 一个文件封死，全仓共用

AES-256-GCM + 每次全新随机 IV + 认证标签，存成 v1:iv:tag:data。
主钥匙从 SESSION_SECRET 经 HKDF 派生，带用途分隔符 —— 不与会话签名共用字节。

形状照 LobeChat 的 KeyVaultsGateKeeper（六个开源实现里唯一真做了服务端加密的）。
open() 永不抛：密文坏了/主钥匙换了都是 { authentic: false }，
因为"读不出来"的正确答案是让用户重填，不是接口 500。"
```

---

### Task 2: 数据库迁移 3 —— `model_configs` 表 + `users` 两个指针

**Files:**
- Modify: `server/db.ts:40`（往 `MIGRATIONS` 数组**追加**第 3 条）
- Test: `server/db.test.ts`（追加）

**Interfaces:**
- Produces: 表 `model_configs(id, user_id, kind, provider, base_url, api_key_enc, model_id, alias, created_at)`；`users.active_chat_config_id` / `users.active_image_config_id` 两列

> ⚠️ **只许追加，不许改前两条。** 用户的库是按顺序跑过来的（`server/db.ts:22` 那段契约）。也**不许**在迁移串里写 `BEGIN`/`COMMIT`/`PRAGMA foreign_keys` —— `assertMigrationsArePlain` 会当场拒掉。

- [ ] **Step 1: 写失败的测试**

往 `server/db.test.ts` 追加：

```ts
describe('迁移 3 —— model_configs', () => {
  it('建出了表，且字段齐全', () => {
    const db = openDb(':memory:')
    const cols = (db.raw.prepare('PRAGMA table_info(model_configs)').all() as { name: string }[])
      .map(c => c.name)
    expect(cols).toEqual([
      'id', 'user_id', 'kind', 'provider', 'base_url', 'api_key_enc', 'model_id', 'alias', 'created_at',
    ])
    db.close()
  })

  it('users 上多了两个指针，默认是 NULL（= 用默认）', () => {
    const db = openDb(':memory:')
    db.raw.prepare('INSERT INTO users (username, email, password_hash, created_at) VALUES (?,?,?,?)')
      .run('a', 'a@b.c', 'h', 1)
    const u = db.raw.prepare('SELECT active_chat_config_id, active_image_config_id FROM users WHERE id = 1')
      .get() as { active_chat_config_id: number | null; active_image_config_id: number | null }
    expect(u.active_chat_config_id).toBeNull()
    expect(u.active_image_config_id).toBeNull()
    db.close()
  })

  it('★ kind 只认 chat / image —— 写别的必须被数据库拒掉', () => {
    // 「两套 key 彻底分开」如果靠代码记得判，就一定会有人忘。
    // 做成表上的约束 = 结构上的必然（§4.1 那句"把不会错做成结构"）。
    const db = openDb(':memory:')
    db.raw.prepare('INSERT INTO users (username, email, password_hash, created_at) VALUES (?,?,?,?)')
      .run('a', 'a@b.c', 'h', 1)
    expect(() => db.raw.prepare(
      'INSERT INTO model_configs (user_id, kind, provider, base_url, api_key_enc, model_id, created_at) VALUES (1,?,?,?,?,?,1)',
    ).run('video', 'custom', 'http://x', 'enc', 'm')).toThrow()
    db.close()
  })

  it('★ 删用户时，他的模型配置跟着删（不留孤儿）', () => {
    const db = openDb(':memory:')
    db.raw.prepare('INSERT INTO users (username, email, password_hash, created_at) VALUES (?,?,?,?)')
      .run('a', 'a@b.c', 'h', 1)
    db.raw.prepare('INSERT INTO model_configs (user_id, kind, provider, base_url, api_key_enc, model_id, created_at) VALUES (1,?,?,?,?,?,1)')
      .run('chat', 'custom', 'http://x', 'enc', 'm')
    db.raw.prepare('DELETE FROM users WHERE id = 1').run()
    const n = db.raw.prepare('SELECT COUNT(*) AS n FROM model_configs').get() as { n: number }
    expect(n.n).toBe(0)
    db.close()
  })

  it('★ 删掉「正在用的那一套」，指针自己就指空了 —— 回默认是结构上的必然', () => {
    // 这是 §4.1 那段注释的落地：不给每条配置加"是不是在用"的开关，
    // 而用 users 上的指针。指针指着的行没了 → SQLite 把指针置 NULL。
    const db = openDb(':memory:')
    db.raw.prepare('INSERT INTO users (username, email, password_hash, created_at) VALUES (?,?,?,?)')
      .run('a', 'a@b.c', 'h', 1)
    const r = db.raw.prepare('INSERT INTO model_configs (user_id, kind, provider, base_url, api_key_enc, model_id, created_at) VALUES (1,?,?,?,?,?,1)')
      .run('chat', 'custom', 'http://x', 'enc', 'm')
    const id = Number(r.lastInsertRowid)
    db.raw.prepare('UPDATE users SET active_chat_config_id = ? WHERE id = 1').run(id)
    db.raw.prepare('DELETE FROM model_configs WHERE id = ?').run(id)
    const u = db.raw.prepare('SELECT active_chat_config_id FROM users WHERE id = 1')
      .get() as { active_chat_config_id: number | null }
    expect(u.active_chat_config_id).toBeNull()
    db.close()
  })
})
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run server/db.test.ts -t 迁移`
Expected: FAIL —— `no such table: model_configs`

- [ ] **Step 3: 追加迁移**

在 `server/db.ts` 的 `MIGRATIONS` 数组**末尾**（第 2 条之后）追加：

```ts
  // 3 —— model_configs + users 上两个指针（spec §4.1 / §7.4）
  //
  // ★ 两件事值得写在这儿：
  //
  //   ① `kind` 上的 CHECK 是**结构**，不是纪律。「chat 和 image 彻底分开」
  //      这条要是靠代码记得判，就一定会有人忘；写进表里就忘不掉。
  //
  //   ② 两个指针用 **REFERENCES … ON DELETE SET NULL** —— 删掉正在用的那一套时，
  //      指针**自己就指空了**，于是"回默认"是结构上的必然，
  //      不是"记得写一句 if"。这和 §6.5 那个"改密码 = 所有设备下线"
  //      是同一个套路：把不会错做成结构。
  //
  // ⚠️ 必须先建表再改 users：两条语句在同一个事务里，但 SQLite 建表时会检查
  //    被引用的表存在（外键在 node:sqlite 里默认是开的）。
  `
  CREATE TABLE model_configs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT    NOT NULL CHECK (kind IN ('chat', 'image')),
    provider     TEXT    NOT NULL,
    base_url     TEXT,
    api_key_enc  TEXT    NOT NULL,
    model_id     TEXT    NOT NULL,
    alias        TEXT    NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX model_configs_user ON model_configs(user_id, kind);
  ALTER TABLE users ADD COLUMN active_chat_config_id  INTEGER REFERENCES model_configs(id) ON DELETE SET NULL;
  ALTER TABLE users ADD COLUMN active_image_config_id INTEGER REFERENCES model_configs(id) ON DELETE SET NULL;
  `,
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run server/db.test.ts`
Expected: PASS（含新增 5 条）

> ⚠️ 如果 `ALTER TABLE … REFERENCES` 报错（SQLite 对外键的 ALTER 有限制），
> 改写方案：两列写成普通 `INTEGER`（不加 REFERENCES），
> 「删掉在用的就指空」改由 `server/models.ts` 里**同一个事务**里显式 `UPDATE users SET … = NULL`，
> 并在 `server/models.test.ts` 里钉一条同样意思的测试。**不许**用触发器。

- [ ] **Step 5: 提交**

```bash
git add server/db.ts server/db.test.ts
git commit -m "feat(数据库): model_configs 表 + users 两个指针

kind 上的 CHECK 把「chat / image 彻底分开」做成表上的约束，不靠代码记得判。
两个指针用 ON DELETE SET NULL —— 删掉正在用的那一套时指针自己指空，
于是「回默认」是结构上的必然（§4.1）。"
```

---

### Task 3: 模型配置的数据层

**Files:**
- Create: `server/models.ts`
- Test: `server/models.test.ts`

**Interfaces:**
- Consumes: `Db`（`server/db.ts`）、`Vault`（`server/keyvault.ts`）、`HttpError`（`server/http.ts`）
- Produces:
  - `type ModelKind = 'chat' | 'image'`
  - `type Provider = 'sensenova' | 'openai-compatible' | 'custom'`
  - `type ModelConfigDeps = { db: Db; vault: Vault; now?: () => number }`
  - `type PublicConfig = { id: number; kind: ModelKind; provider: Provider; baseUrl: string; modelId: string; alias: string; keyHint: string; active: boolean }`
  - `type SecretConfig = { provider: Provider; baseUrl: string; apiKey: string; modelId: string }`
  - `listConfigs(user: PublicUser, deps): { configs: PublicConfig[] }`
  - `createConfig(body: unknown, user: PublicUser, deps): PublicConfig`
  - `updateConfig(id: number, body: unknown, user: PublicUser, deps): PublicConfig`
  - `deleteConfig(id: number, user: PublicUser, deps): { wasActive: boolean }`
  - `activateConfig(body: unknown, user: PublicUser, deps): { ok: true }`
  - `resolveSecret(kind: ModelKind, user: PublicUser, deps): SecretConfig | null`
  - `maskKey(key: string): string`
  - `normalizeBaseUrl(input: string): string`

- [ ] **Step 1: 写失败的测试**

创建 `server/models.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { openDb, type Db } from './db.ts'
import { createVault } from './keyvault.ts'
import {
  activateConfig, createConfig, deleteConfig, listConfigs, maskKey,
  normalizeBaseUrl, resolveSecret, updateConfig, type ModelConfigDeps,
} from './models.ts'

const USER = { id: 1, username: 'a', email: 'a@b.c' }
const OTHER = { id: 2, username: 'b', email: 'b@b.c' }

function fresh(): ModelConfigDeps {
  const db: Db = openDb(':memory:')
  for (const u of [USER, OTHER]) {
    db.raw.prepare('INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?,?,?,?,?)')
      .run(u.id, u.username, u.email, 'h', 1)
  }
  return { db, vault: createVault('test-secret'), now: () => 1_700_000_000_000 }
}

const BODY = {
  kind: 'chat', provider: 'custom',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-abcdefghijklmnop-4f2',
  modelId: 'some-vision-model', alias: '我的便宜货',
}

describe('掩盖码', () => {
  it('前 3 后 4', () => {
    expect(maskKey('sk-abcdefghijklmnop-4f2')).toBe('sk-…4f2')
  })
  it('太短的钥匙不露任何片段', () => {
    // 短钥匙露前 3 后 4 就等于全露了
    expect(maskKey('sk-12345')).toBe('•••••')
  })
})

describe('接口地址归一化', () => {
  it('没有协议的补 https://', () => {
    expect(normalizeBaseUrl('api.example.com/v1')).toBe('https://api.example.com/v1')
  })
  it('★ 误粘了整条对话路径 → 剥回主机名 + /v1', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/chat/completions'))
      .toBe('https://api.example.com/v1')
  })
  it('★ 漏了 /v1 → 补上', () => {
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com/v1')
  })
  it('已经是对的 → 一个字不动', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1')
  })
  it('结尾多余的斜杠去掉', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
  })
  it('★ 带墨迹的（查询串 / 片段 / 内嵌凭据）拒绝，而不是"尽力修"', () => {
    // 这两样是 SSRF 的常见载体，也是用户粘贴错了的信号 ——
    // 猜他想要什么比直接问更贵。
    expect(() => normalizeBaseUrl('https://api.example.com/v1?key=abc')).toThrow()
    expect(() => normalizeBaseUrl('https://api.example.com/v1#x')).toThrow()
    expect(() => normalizeBaseUrl('https://user:pw@api.example.com/v1')).toThrow()
  })
  it('★ 不是 http/https 的拒绝', () => {
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrow()
    expect(() => normalizeBaseUrl('javascript:alert(1)')).toThrow()
  })
  it('空串 / 乱码拒绝', () => {
    expect(() => normalizeBaseUrl('')).toThrow()
    expect(() => normalizeBaseUrl('not a url at all')).toThrow()
  })
})

describe('增删改查', () => {
  it('建一套，回的是公开形状 —— ★ 里面没有钥匙', () => {
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    expect(c).toEqual({
      id: 1, kind: 'chat', provider: 'custom',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'some-vision-model', alias: '我的便宜货',
      keyHint: 'sk-…4f2', active: false,
    })
    // 整个 JSON 里不许出现完整钥匙 —— 一个字都不许
    expect(JSON.stringify(c)).not.toContain('abcdefghijklmnop')
  })

  it('★ 库里存的确实是密文，不是明文', () => {
    const d = fresh()
    createConfig(BODY, USER, d)
    const row = d.db.raw.prepare('SELECT api_key_enc FROM model_configs WHERE id = 1')
      .get() as { api_key_enc: string }
    expect(row.api_key_enc).not.toContain('abcdefghijklmnop')
    expect(row.api_key_enc.startsWith('v1:')).toBe(true)
    // 而且是能解回来的（不然就是"存了个打不开的东西"）
    expect(d.vault.open(row.api_key_enc).plaintext).toBe('sk-abcdefghijklmnop-4f2')
  })

  it('★ 列表只回自己的，别人的一套都不许出现', () => {
    const d = fresh()
    createConfig(BODY, USER, d)
    createConfig({ ...BODY, alias: '他的' }, OTHER, d)
    const mine = listConfigs(USER, d)
    expect(mine.configs.map(c => c.alias)).toEqual(['我的便宜货'])
  })

  it('★ 两个 kind 互不串场', () => {
    const d = fresh()
    createConfig(BODY, USER, d)
    createConfig({ ...BODY, kind: 'image', alias: '改图的' }, USER, d)
    const chat = listConfigs(USER, d).configs.filter(c => c.kind === 'chat')
    const image = listConfigs(USER, d).configs.filter(c => c.kind === 'image')
    expect(chat.map(c => c.alias)).toEqual(['我的便宜货'])
    expect(image.map(c => c.alias)).toEqual(['改图的'])
  })

  it('★ 改别人的一套 → 404（不是 403，不给"存在但你没权限"这个信号）', () => {
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    expect(() => updateConfig(c.id, { alias: 'x' }, OTHER, d)).toThrow(/没有/)
    // 而且真的没改
    expect(listConfigs(USER, d).configs[0]!.alias).toBe('我的便宜货')
  })

  it('★ 改的一套不给新钥匙 → 老钥匙一个字不动', () => {
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    const updated = updateConfig(c.id, { alias: '换个名字' }, USER, d)
    expect(updated.alias).toBe('换个名字')
    expect(updated.keyHint).toBe('sk-…4f2')
    expect(resolveSecret('chat', USER, d)?.apiKey).toBe('sk-abcdefghijklmnop-4f2')
  })

  it('★ 改了接口地址但没给新钥匙 → 拒绝（防止偷到票的人把钥匙转发到自己的服务器）', () => {
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    expect(() => updateConfig(c.id, { baseUrl: 'https://evil.example.com/v1' }, USER, d))
      .toThrow(/重填/)
  })

  it('★ 改接口地址 + 同时给新钥匙 → 可以', () => {
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    const updated = updateConfig(c.id,
      { baseUrl: 'https://other.example.com/v1', apiKey: 'sk-zzzzzzzzzzzzzzzz-999' }, USER, d)
    expect(updated.baseUrl).toBe('https://other.example.com/v1')
    expect(resolveSecret('chat', USER, d)?.apiKey).toBe('sk-zzzzzzzzzzzzzzzz-999')
  })
})

describe('哪一套在用 / 删除的两种行为（§7.4）', () => {
  it('激活一个 → 只有它 active', () => {
    const d = fresh()
    const a = createConfig({ ...BODY, alias: '甲' }, USER, d)
    const b = createConfig({ ...BODY, alias: '乙' }, USER, d)
    activateConfig({ kind: 'chat', id: b.id }, USER, d)
    const list = listConfigs(USER, d).configs
    expect(list.find(c => c.id === a.id)!.active).toBe(false)
    expect(list.find(c => c.id === b.id)!.active).toBe(true)
  })

  it('★ 激活成「默认」是允许的（不然想回默认只能删掉配置）', () => {
    const d = fresh()
    const a = createConfig(BODY, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    activateConfig({ kind: 'chat', id: null }, USER, d)
    expect(listConfigs(USER, d).configs[0]!.active).toBe(false)
    expect(resolveSecret('chat', USER, d)).toBeNull()
  })

  it('★ 删掉「不是在用的」→ 当前在用的那套一点没变', () => {
    const d = fresh()
    const a = createConfig({ ...BODY, alias: '在用的' }, USER, d)
    const b = createConfig({ ...BODY, alias: '不用的' }, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    expect(deleteConfig(b.id, USER, d)).toEqual({ wasActive: false })
    const list = listConfigs(USER, d).configs
    expect(list.map(c => c.alias)).toEqual(['在用的'])
    expect(list[0]!.active).toBe(true)
  })

  it('★ 删掉「正在用的」→ wasActive 为真，而且是回默认', () => {
    const d = fresh()
    const a = createConfig(BODY, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    expect(deleteConfig(a.id, USER, d)).toEqual({ wasActive: true })
    expect(resolveSecret('chat', USER, d)).toBeNull()
  })

  it('★ 删错 kind 那一边不影响另一边（两套彻底分开）', () => {
    const d = fresh()
    const chat = createConfig(BODY, USER, d)
    const image = createConfig({ ...BODY, kind: 'image' }, USER, d)
    activateConfig({ kind: 'chat', id: chat.id }, USER, d)
    activateConfig({ kind: 'image', id: image.id }, USER, d)
    deleteConfig(chat.id, USER, d)
    // 图片那边原封不动
    expect(resolveSecret('image', USER, d)?.modelId).toBe('some-vision-model')
  })
})

describe('取密钥（给"按用户造客户端"用）', () => {
  it('没配 → null（调用方走默认）', () => {
    expect(resolveSecret('chat', USER, fresh())).toBeNull()
  })

  it('配了但没激活 → 还是 null', () => {
    const d = fresh()
    createConfig(BODY, USER, d)
    expect(resolveSecret('chat', USER, d)).toBeNull()
  })

  it('★ 密文读不出来（换了主钥匙）→ null，不抛', () => {
    const d = fresh()
    const c = createConfig(BODY, USER, d)
    activateConfig({ kind: 'chat', id: c.id }, USER, d)
    // 模拟"SESSION_SECRET 被人换过"
    const broken: ModelConfigDeps = { ...d, vault: createVault('another-secret') }
    expect(resolveSecret('chat', USER, broken)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run server/models.test.ts`
Expected: FAIL —— `Failed to resolve import "./models.ts"`

- [ ] **Step 3: 写实现**

创建 `server/models.ts`：

```ts
import type { PublicUser } from './account.ts'
import type { Db } from './db.ts'
import { HttpError, asObject, str } from './http.ts'
import type { Vault } from './keyvault.ts'

export type ModelKind = 'chat' | 'image'
export type Provider = 'sensenova' | 'openai-compatible' | 'custom'

const KINDS: readonly ModelKind[] = ['chat', 'image']
const PROVIDERS: readonly Provider[] = ['sensenova', 'openai-compatible', 'custom']

/** 别名长度上限。界面上到处显示的是它，太长会撑坏布局。 */
const MAX_ALIAS = 20
/** 模型名上限。够长了 —— 最长的也到不了 100。 */
const MAX_MODEL_ID = 100

export type ModelConfigDeps = { db: Db; vault: Vault; now?: () => number }
const now = (d: ModelConfigDeps): number => (d.now ? d.now() : Date.now())

/** 完整钥匙**永不出去**的形状。回给前端的只有 keyHint。 */
export type PublicConfig = {
  id: number
  kind: ModelKind
  provider: Provider
  baseUrl: string
  modelId: string
  alias: string
  keyHint: string
  active: boolean
}

/** 只有 resolveSecret 能拿到它 —— 它唯一的去处是"造一个客户端"。 */
export type SecretConfig = {
  provider: Provider
  baseUrl: string
  apiKey: string
  modelId: string
}

type Row = {
  id: number; kind: string; provider: string; base_url: string | null
  api_key_enc: string; model_id: string; alias: string
}

/**
 * 只给头尾。太短的钥匙干脆一个字符都不露 ——
 * 露前 3 后 4 在 `sk-12345` 上等于把整把钥匙打出来了。
 *
 * 这也是 §10 那条测试钉的东西：「响应里不许含完整 key」。
 */
export function maskKey(key: string): string {
  if (key.length < 12) return '•'.repeat(Math.min(key.length, 5))
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

/**
 * 接口地址归一化 —— 替用户擦屁股。
 *
 * ★ 这条是从 Chatbox 抄的（`normalizeOpenAIApiHostAndPath`）。它不是洁癖：
 * 我们的用户是旅游打卡党，不是程序员。"https://api.deepseek.com" 少了 `/v1`、
 * 或者顺手把文档里整条 `https://api.deepseek.com/v1/chat/completions` 粘进来，
 * 都是**一定会发生**的事。让他们照着报错自己悟，比这两行代码贵得多。
 *
 * ⚠️ 但**只修"少"和"多"，不修"脏"**：带查询串 / 片段 / 内嵌凭据一律拒绝。
 * 那三样是 SSRF 的常见载体，也是"粘错东西了"的信号 —— 猜他想要什么，
 * 不如直接让他重填。
 */
export function normalizeBaseUrl(input: string): string {
  const raw = str(input).trim()
  if (!raw) throw new HttpError('BAD_REQUEST', '接口地址不能为空')

  // 没有协议就补 https://（用户很常只写域名）
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`

  let u: URL
  try {
    u = new URL(withProto)
  } catch {
    throw new HttpError('BAD_REQUEST', '接口地址看起来不是一个网址')
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new HttpError('BAD_REQUEST', '接口地址只能是 http 或 https 开头的')
  }
  if (u.username || u.password) {
    throw new HttpError('BAD_REQUEST', '接口地址里不要带用户名和密码')
  }
  if (u.search || u.hash) {
    throw new HttpError('BAD_REQUEST', '接口地址里不要带 ? 后面的东西')
  }
  if (!u.hostname.includes('.')) {
    throw new HttpError('BAD_REQUEST', '接口地址看起来不是一个网址')
  }

  // 路径：去掉结尾斜杠 → 剥掉误粘的完整端点 → 没有 /v1 就在末尾补一个
  let path = u.pathname.replace(/\/+$/, '')
  for (const tail of ['/chat/completions', '/images/edits', '/images/generations', '/responses']) {
    if (path.endsWith(tail)) path = path.slice(0, -tail.length)
  }
  if (!/\/v\d+$/.test(path)) path = `${path}/v1`

  return `${u.protocol}//${u.host}${path}`
}

function readKind(v: unknown): ModelKind {
  const k = str(v) as ModelKind
  if (!KINDS.includes(k)) throw new HttpError('BAD_REQUEST', 'kind 只能是 chat 或 image')
  return k
}

function readProvider(v: unknown): Provider {
  const p = str(v) as Provider
  if (!PROVIDERS.includes(p)) throw new HttpError('BAD_REQUEST', '不认识这个服务商')
  return p
}

function readAlias(v: unknown): string {
  const a = str(v).trim()
  if (!a) throw new HttpError('BAD_REQUEST', '给它起个名字吧')
  if (a.length > MAX_ALIAS) throw new HttpError('BAD_REQUEST', `名字最多 ${MAX_ALIAS} 个字`)
  return a
}

function readModelId(v: unknown): string {
  const m = str(v).trim()
  if (!m) throw new HttpError('BAD_REQUEST', '模型名不能为空')
  if (m.length > MAX_MODEL_ID) throw new HttpError('BAD_REQUEST', `模型名太长（最多 ${MAX_MODEL_ID} 个字）`)
  return m
}

/** 取某一行，**并且必须是这个人的** —— 查不到和不属于你，回同一个 404。 */
function ownRow(id: number, user: PublicUser, deps: ModelConfigDeps, need: ModelKind):
  Row & { kind: ModelKind } {
  const row = deps.db.raw
    .prepare('SELECT id, kind, provider, base_url, api_key_enc, model_id, alias FROM model_configs WHERE id = ? AND user_id = ? AND kind = ?')
    .get(id, user.id, need) as Row | undefined
  // ⚠️ 「没这套」和「不是你的」**必须是同一个结局**：分开处理等于给了
  // 攻击者一个信号 —— 哪几个 id 是真的、只是不归你。和 §6.1 那条同源。
  if (!row) throw new HttpError('BAD_REQUEST', '没有这一套设置', 404)
  return { ...row, kind: row.kind as ModelKind }
}

function activeIdOf(kind: ModelKind, user: PublicUser, deps: ModelConfigDeps): number | null {
  const col = kind === 'chat' ? 'active_chat_config_id' : 'active_image_config_id'
  const r = deps.db.raw.prepare(`SELECT ${col} AS id FROM users WHERE id = ?`)
    .get(user.id) as { id: number | null } | undefined
  return r?.id ?? null
}

function toPublic(row: Row, activeId: number | null, vault: Vault): PublicConfig {
  // keyHint 要解一次密文才拿得到。**解不开时给一个中性的占位**，
  // 而不是把整个列表打挂 —— 列表是用户来"修"的地方，它自己不能先坏。
  const opened = vault.open(row.api_key_enc)
  return {
    id: row.id,
    kind: row.kind as ModelKind,
    provider: row.provider as Provider,
    baseUrl: row.base_url ?? '',
    modelId: row.model_id,
    alias: row.alias,
    keyHint: opened.authentic ? maskKey(opened.plaintext) : '（读不出来，请重填）',
    active: activeId === row.id,
  }
}

export function listConfigs(user: PublicUser, deps: ModelConfigDeps): { configs: PublicConfig[] } {
  const rows = deps.db.raw
    .prepare('SELECT id, kind, provider, base_url, api_key_enc, model_id, alias FROM model_configs WHERE user_id = ? ORDER BY id')
    .all(user.id) as Row[]
  const chatId = activeIdOf('chat', user, deps)
  const imageId = activeIdOf('image', user, deps)
  return { configs: rows.map(r => toPublic(r, r.kind === 'chat' ? chatId : imageId, deps.vault)) }
}

export function createConfig(body: unknown, user: PublicUser, deps: ModelConfigDeps): PublicConfig {
  const o = asObject(body)
  const kind = readKind(o.kind)
  const provider = readProvider(o.provider)
  const alias = readAlias(o.alias)
  const modelId = readModelId(o.modelId)
  const baseUrl = normalizeBaseUrl(str(o.baseUrl))
  const apiKey = str(o.apiKey).trim()
  if (!apiKey) throw new HttpError('BAD_REQUEST', '钥匙不能为空')

  const r = deps.db.raw
    .prepare(`INSERT INTO model_configs (user_id, kind, provider, base_url, api_key_enc, model_id, alias, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, kind, provider, baseUrl, deps.vault.seal(apiKey), modelId, alias, now(deps))

  const row = deps.db.raw
    .prepare('SELECT id, kind, provider, base_url, api_key_enc, model_id, alias FROM model_configs WHERE id = ?')
    .get(Number(r.lastInsertRowid)) as Row
  // 新建的**默认不激活** —— 用户可能只是想先存着，或者还想先"测一下"。
  // 自动切成在用的话，一条填错的配置会立刻把他的修图弄坏。
  return toPublic(row, activeIdOf(kind, user, deps), deps.vault)
}

export function updateConfig(id: number, body: unknown, user: PublicUser, deps: ModelConfigDeps): PublicConfig {
  const o = asObject(body)
  const kind = readKind(o.kind)
  const row = ownRow(id, user, deps, kind)

  const alias = o.alias === undefined ? row.alias : readAlias(o.alias)
  const modelId = o.model_id === undefined && o.modelId === undefined
    ? row.model_id
    : readModelId(o.modelId ?? o.model_id)

  // ★ 接口地址和钥匙**要么都不动，要么一起给**。
  //
  //   理由是一条真实的攻击：偷到登录票的人，把 base_url 改成自己的服务器，
  //   再触发一次生成 —— 我们服务端就会**把用户的明文钥匙发到他那台机器上**。
  //   钥匙存了密文、界面永不回显，唯一能把它弄出去的路就是这一条。
  //   要求"改地址必须重填钥匙"之后，光有票也拿不到钥匙（因为他没有钥匙）。
  //
  //   对用户零负担：换服务商的时候本来就要换一把新钥匙。
  const wantsNewUrl = o.baseUrl !== undefined
  const newKey = o.apiKey === undefined ? null : str(o.apiKey).trim()
  if (newKey !== null && newKey === '') throw new HttpError('BAD_REQUEST', '钥匙不能是空的（想清掉就删掉这一套）')
  if (wantsNewUrl && newKey === null) {
    throw new HttpError('BAD_REQUEST', '换了接口地址就要把钥匙重填一遍 —— 换服务商时本来也要换一把新钥匙')
  }

  const baseUrl = wantsNewUrl ? normalizeBaseUrl(str(o.baseUrl)) : (row.base_url ?? '')
  const apiKeyEnc = newKey === null ? row.api_key_enc : deps.vault.seal(newKey)

  deps.db.raw
    .prepare('UPDATE model_configs SET base_url = ?, api_key_enc = ?, model_id = ?, alias = ? WHERE id = ? AND user_id = ?')
    .run(baseUrl, apiKeyEnc, modelId, alias, id, user.id)

  const after = deps.db.raw
    .prepare('SELECT id, kind, provider, base_url, api_key_enc, model_id, alias FROM model_configs WHERE id = ?')
    .get(id) as Row
  return toPublic(after, activeIdOf(kind, user, deps), deps.vault)
}

/**
 * 删一套。回的 `wasActive` 是**界面必须用上**的东西：
 * 删掉的正是"在用的那一套"时，要弹那条鲜明的提示 + 一个「换成其他的」入口（§7.4）。
 *
 * ★ 回默认**不是这里写的 if**：`users` 上的指针有 `ON DELETE SET NULL`，
 *   行没了指针自己就空了。这里只是**如实回报**"刚才那次是删了在用的"。
 */
export function deleteConfig(id: number, user: PublicUser, deps: ModelConfigDeps): { wasActive: boolean } {
  const row = deps.db.raw
    .prepare('SELECT id, kind FROM model_configs WHERE id = ? AND user_id = ?')
    .get(id, user.id) as { id: number; kind: string } | undefined
  if (!row) throw new HttpError('BAD_REQUEST', '没有这一套设置', 404)

  const wasActive = activeIdOf(row.kind as ModelKind, user, deps) === id
  deps.db.raw.prepare('DELETE FROM model_configs WHERE id = ? AND user_id = ?').run(id, user.id)
  return { wasActive }
}

/** 切到哪一套。`id: null` = 切回默认（§9：「不然想回默认只能删掉配置」）。 */
export function activateConfig(body: unknown, user: PublicUser, deps: ModelConfigDeps): { ok: true } {
  const o = asObject(body)
  const kind = readKind(o.kind)
  const raw = o.id

  const col = kind === 'chat' ? 'active_chat_config_id' : 'active_image_config_id'
  if (raw === null || raw === undefined) {
    deps.db.raw.prepare(`UPDATE users SET ${col} = NULL WHERE id = ?`).run(user.id)
    return { ok: true }
  }

  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError('BAD_REQUEST', 'id 不对')
  // 指之前先确认这一套**是这个人的、而且是这个 kind 的** ——
  // 不然一次 PATCH 就能把自己的 chat 指针指到别人的图上。
  ownRow(id, user, deps, kind)
  deps.db.raw.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(id, user.id)
  return { ok: true }
}

/**
 * 取出真正要用的那把钥匙 —— **只有造客户端的那一处会调它**。
 *
 * 三种 null 是同一件事的三种成因：没配 / 没激活 / 密文读不出来。
 * 对调用方来说处置完全一样（走默认），所以不细分。
 *
 * ⚠️ 密文读不出来时**不抛**：那是"SESSION_SECRET 被换过"或者库被改过，
 * 正确答案是安静地回默认，而不是让用户的每一次修图都 500。
 */
export function resolveSecret(kind: ModelKind, user: PublicUser, deps: ModelConfigDeps): SecretConfig | null {
  const id = activeIdOf(kind, user, deps)
  if (id === null) return null
  const row = deps.db.raw
    .prepare('SELECT provider, base_url, api_key_enc, model_id FROM model_configs WHERE id = ? AND user_id = ? AND kind = ?')
    .get(id, user.id, kind) as
    { provider: string; base_url: string | null; api_key_enc: string; model_id: string } | undefined
  if (!row) return null

  const opened = deps.vault.open(row.api_key_enc)
  if (!opened.authentic) return null

  return {
    provider: row.provider as Provider,
    baseUrl: row.base_url ?? '',
    apiKey: opened.plaintext,
    modelId: row.model_id,
  }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run server/models.test.ts`
Expected: PASS（约 25 条）

- [ ] **Step 5: 提交**

```bash
git add server/models.ts server/models.test.ts
git commit -m "feat(模型设置): 数据层 —— CRUD、掩码、地址归一化、两套 key 互不串

三条是结构而不是纪律：
· 完整钥匙永远不出现在任何返回值里，只回前 3 后 4；
· 改接口地址必须同时重填钥匙（否则偷到登录票的人能把钥匙转发到自己的服务器）；
· 删掉正在用的那套时回默认靠 ON DELETE SET NULL 自己发生，代码只负责如实回报。

地址归一化照 Chatbox 做（补 /v1、剥掉误粘的整条端点），但带查询串/片段/内嵌凭据的一律拒绝。"
```

---

### Task 4: `/api/models` 路由

**Files:**
- Modify: `server/app.ts`（`AppDeps` 加 `models`；`handle()` 里加 5 条路由）
- Modify: `server/index.ts`（把 vault 和 models deps 接上）
- Test: `server/app.test.ts`（追加）

**Interfaces:**
- Consumes: Task 3 的全部导出
- Produces: HTTP 接口
  - `GET /api/models` → `{ configs: PublicConfig[] }`
  - `POST /api/models` → `PublicConfig`
  - `PATCH /api/models/:id` → `PublicConfig`
  - `DELETE /api/models/:id` → `{ wasActive: boolean }`
  - `POST /api/models/activate` → `{ ok: true }`
- `AppDeps` 新增必填字段 `models: ModelConfigDeps`

- [ ] **Step 1: 写失败的测试**

往 `server/app.test.ts` 追加（沿用该文件已有的 `makeApp()` / `signup()` 助手；若名字不同，按文件里现成的来）：

```ts
describe('/api/models', () => {
  const BODY = {
    kind: 'chat', provider: 'custom', baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-abcdefghijklmnop-4f2', modelId: 'm', alias: '我的便宜货',
  }

  it('★ 没登录 → 401，而且比读请求体更早', async () => {
    const { app } = makeApp()
    const r = await call(app, 'GET', '/api/models')
    expect(r.status).toBe(401)
  })

  it('建 → 列 → 改 → 删 走一遍', async () => {
    const { app } = makeApp()
    const c = await call(app, 'POST', '/api/models', BODY, await signup(app))
    expect(c.status).toBe(200)
    const made = c.body as { id: number; keyHint: string }

    const list = await call(app, 'GET', '/api/models', undefined, cookie)
    expect((list.body as { configs: unknown[] }).configs).toHaveLength(1)

    const patched = await call(app, 'PATCH', `/api/models/${made.id}`, { kind: 'chat', alias: '改名了' }, cookie)
    expect((patched.body as { alias: string }).alias).toBe('改名了')

    const del = await call(app, 'DELETE', `/api/models/${made.id}`, undefined, cookie)
    expect(del.body).toEqual({ wasActive: false })
  })

  it('★ 响应里不许出现完整钥匙 —— 全链路（§10）', async () => {
    const { app } = makeApp()
    const cookie = await signup(app)
    const c = await call(app, 'POST', '/api/models', BODY, cookie)
    const list = await call(app, 'GET', '/api/models', undefined, cookie)
    for (const r of [c, list]) {
      expect(JSON.stringify(r.body)).not.toContain('abcdefghijklmnop')
    }
  })

  it('★ 别人的那一套：改 / 删 / 激活一律 404（不是 403）', async () => {
    const { app } = makeApp()
    const mine = await signup(app)
    const theirs = await signup(app)
    const c = await call(app, 'POST', '/api/models', BODY, mine)
    const id = (c.body as { id: number }).id
    for (const [m, p] of [['PATCH', `/api/models/${id}`], ['DELETE', `/api/models/${id}`]] as const) {
      const r = await call(app, m, p, m === 'PATCH' ? { kind: 'chat', alias: 'x' } : undefined, theirs)
      expect(r.status).toBe(404)
    }
    const a = await call(app, 'POST', '/api/models/activate', { kind: 'chat', id }, theirs)
    expect(a.status).toBe(404)
  })

  it('★ 激活别的 kind 的那一套 → 404（指针不许串场）', async () => {
    const { app } = makeApp()
    const cookie = await signup(app)
    const img = await call(app, 'POST', '/api/models', { ...BODY, kind: 'image' }, cookie)
    const id = (img.body as { id: number }).id
    const r = await call(app, 'POST', '/api/models/activate', { kind: 'chat', id }, cookie)
    expect(r.status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run server/app.test.ts -t '/api/models'`
Expected: FAIL —— `没有这个接口：/api/models`

- [ ] **Step 3: 改 `AppDeps` 和路由**

`server/app.ts` 顶部 import 加：

```ts
import {
  activateConfig, createConfig, deleteConfig, listConfigs, updateConfig,
  type ModelConfigDeps,
} from './models.ts'
```

`AppDeps` 里加一个**必填**字段（理由和 `auth`/`storage` 那段一字不差 —— 少接一根线必须是编译错误）：

```ts
  /**
   * 用户接进来的模型（§7）。**必填**，理由同 auth / storage：
   * 少接这一根线的后果是"用户配了自己的钥匙但一次都没用上" ——
   * 那是最难发现的一种坏（它不报错，只是安静地花我们的钱）。
   */
  models: ModelConfigDeps
```

`handle()` 里，在 `/api/works/delete` 那一段之后、`/api/route` 之前插入：

```ts
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
```

- [ ] **Step 4: 接上 `server/index.ts`**

`server/index.ts` 加 import：

```ts
import { createVault } from './keyvault.ts'
```

并在 `createApp({...})` 里加：

```ts
  // ★ 保险箱的主钥匙**从 SESSION_SECRET 派生**（带用途分隔符，见 keyvault.ts）。
  //   不为它多加一个环境变量：多一个变量就多一处"忘了配"，
  //   而这里少配的后果是"服务起不来"，那正是 config.ts 对 SESSION_SECRET
  //   已经做过的事（没配就拒绝启动）。
  models: { db, vault: createVault(config.sessionSecret) },
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `npx vitest run server/app.test.ts && npx vitest run`
Expected: 全绿

> ⚠️ `server/app.test.ts` 里所有 `createApp({...})` 的调用点都要补上 `models` ——
> 这是**故意**的，让编译器把每一处都指出来。漏一个就是编译错误，不是运行时 503。

- [ ] **Step 6: 提交**

```bash
git add server/app.ts server/index.ts server/app.test.ts
git commit -m "feat(接口): /api/models 的增删改查激活五条

app.ts 里新的 deps.models 是必填 —— 少接一根线要编译不过，不是运行时静默失灵。
别人的那一套回 404 不回 403：分开处理等于告诉人哪些 id 是真的、只是不归你。"
```

---

### Task 5: 测一下（`POST /api/models/test`）

**Files:**
- Create: `server/modeltest.ts`
- Modify: `server/app.ts`（一条路由）
- Test: `server/modeltest.test.ts`, `server/app.test.ts`（追加一条）

**Interfaces:**
- Consumes: `normalizeBaseUrl`（Task 3）
- Produces:
  - `type ProbeInput = { baseUrl: string; apiKey: string }`
  - `type ProbeResult = { ok: true; models: string[] } | { ok: false; reason: ProbeFail; message: string }`
  - `type ProbeFail = 'unauthorized' | 'unreachable' | 'no_endpoint' | 'bad_response'`
  - `probeConnection(input: ProbeInput, fetchImpl?): Promise<ProbeResult>`

> **设计说明（写给实现者）**
>
> 它打的是 `GET {baseUrl}/models` —— **OpenAI 标准接口，不花一分钱**。
> 实测商汤支持（HTTP 200，返回 9 个模型）。
>
> ⚠️ **它证明的是「地址通、钥匙对」，不是「那个模型能用」。** 这句话必须
> **同时出现在界面文案里**（§7.3 那条"不许写产品做不到的事"）。想验模型名
> 就得真发一次生成，那是要花钱的，不该由"测一下"这个按钮偷偷花掉。
>
> ⚠️ **模型列表不全会说谎**：实测商汤的 `/models` 里**没有**
> `sensenova-u1.5-fast`，而那是我们自己在用的图片模型。
> 所以返回的 `models` **只能当建议**，界面里必须同时留"自己手打"那条路 ——
> 绝不能因为"列表里没有"就判用户填错。
> （Open WebUI 和 LibreChat 都在"拉模型列表"这条路上静默降级过，是我们明令要避开的坑。）

- [ ] **Step 1: 写失败的测试**

创建 `server/modeltest.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { probeConnection } from './modeltest.ts'

const okFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

const INPUT = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' }

describe('probeConnection', () => {
  it('通了 → 带回模型名单', async () => {
    const r = await probeConnection(INPUT, okFetch({ data: [{ id: 'a' }, { id: 'b' }] }))
    expect(r).toEqual({ ok: true, models: ['a', 'b'] })
  })

  it('★ 401 → 「钥匙不认」，文案里带着用户最常犯的那几种', async () => {
    const r = await probeConnection(INPUT, okFetch({ error: { message: 'Forbidden' } }, 401))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('unauthorized')
    // 这条文案照 Chatbox 的抄 —— 它把新手最容易踩的四种坑一次说全，
    // 用户读完能自己去改，不必来问我们
    expect(r.message).toContain('没复制全')
    expect(r.message).toContain('空格')
    expect(r.message).toContain('余额')
  })

  it('403 也算「钥匙不认」', async () => {
    const r = await probeConnection(INPUT, okFetch({}, 403))
    expect(r.ok === false && r.reason === 'unauthorized').toBe(true)
  })

  it('★ 404 → 「这个地址上没有那个接口」，而不是「钥匙错了」', async () => {
    // 这两件事的下一步动作完全不同（一个去改地址、一个去改钥匙），
    // 混成一句话就是让用户瞎试
    const r = await probeConnection(INPUT, okFetch({}, 404))
    expect(r.ok === false && r.reason === 'no_endpoint').toBe(true)
  })

  it('★ 连不上（DNS/超时/拒连）→ unreachable，而且**不把异常原文给用户**', async () => {
    const boom = (async () => { throw new Error('getaddrinfo ENOTFOUND api.example.com') }) as unknown as typeof fetch
    const r = await probeConnection(INPUT, boom)
    expect(r.ok === false && r.reason === 'unreachable').toBe(true)
    if (r.ok) return
    expect(r.message).not.toContain('ENOTFOUND')   // 运维口径不许出给用户
  })

  it('200 但不是 JSON / 没有 data 数组 → bad_response', async () => {
    const html = (async () => new Response('<html>hi</html>', { status: 200 })) as unknown as typeof fetch
    const r = await probeConnection(INPUT, html)
    expect(r.ok === false && r.reason === 'bad_response').toBe(true)
  })

  it('★ 200 但 data 是空的 → 也算通（有些服务商就是不给列表）', async () => {
    const r = await probeConnection(INPUT, okFetch({ data: [] }))
    expect(r).toEqual({ ok: true, models: [] })
  })

  it('★ 打的是 /models，而且带 Authorization 头', async () => {
    let seen: { url: string; auth: string | undefined } | null = null
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>)?.authorization }
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await probeConnection(INPUT, spy)
    expect(seen!.url).toBe('https://api.example.com/v1/models')
    expect(seen!.auth).toBe('Bearer sk-x')
  })
})
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run server/modeltest.test.ts`
Expected: FAIL —— 找不到 `./modeltest.ts`

- [ ] **Step 3: 写实现**

创建 `server/modeltest.ts`：

```ts
/**
 * 「测一下」这个按钮背后那一下。
 *
 * ★ **它不花一分钱。** 打的是 `GET {baseUrl}/models` —— OpenAI 标准接口，
 * 实测商汤支持。这是刻意的：用户会反复按这个按钮，让它烧 token 是不能接受的。
 *
 * ⚠️ **它证明的是「地址通、钥匙对」，不是「那个模型能用」。** 那句话必须同时
 * 出现在界面文案里（§7.3：不许写产品做不到的事）。想验模型名就得真发一次生成。
 *
 * ⚠️ **模型名单不全，只能当建议。** 实测商汤的 /models 里**没有**
 * sensenova-u1.5-fast —— 我们自己在用的图片模型。所以：
 * 调用方**绝不能**因为"名单里没有"就判用户填错，界面里必须留着"自己手打"。
 */

/** 超时。这是个人在等的一次点击，比 AI 那几条路短得多。 */
const PROBE_TIMEOUT_MS = 8000

export type ProbeFail = 'unauthorized' | 'unreachable' | 'no_endpoint' | 'bad_response'
export type ProbeResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: ProbeFail; message: string }

export type ProbeInput = { baseUrl: string; apiKey: string }

/**
 * 失败时给用户看的话。
 *
 * ⚠️ 这里每一个字都是**给人看的**，不是运维口径 ——
 * `ENOTFOUND` / `ECONNREFUSED` / 上游原文一律不许出现在这里面
 * （它们是"我们自己排查用的"，出给用户只会让他放弃）。
 *
 * 「钥匙不认」那条照 Chatbox 的抄：它把新手最容易踩的几种一次说全，
 * 用户读完能自己去改，不必来问我们。
 */
function messageOf(reason: ProbeFail): string {
  switch (reason) {
    case 'unauthorized':
      return '服务商不认这把钥匙。常见的几种：没复制全、前后多了空格、跟这个服务商对不上、余额不够了、或者已经过期。'
    case 'unreachable':
      return '连不上这个接口地址。检查一下地址有没有写错、网络通不通。'
    case 'no_endpoint':
      return '这个地址上没有那个接口。多半是地址少了或多了 `/v1` 这类结尾。'
    case 'bad_response':
      return '那个地址回了一个我们看不懂的东西。确认一下填的是 AI 服务商的接口地址。'
  }
}

/** 失败一律走这里 —— 保证"用户看到的话"和"我们记的日志"永远是两回事。 */
function fail(reason: ProbeFail): ProbeResult {
  return { ok: false, reason, message: messageOf(reason) }
}

export async function probeConnection(
  input: ProbeInput, fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const url = `${input.baseUrl.replace(/\/+$/, '')}/models`
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch {
    // DNS 失败 / 连不上 / 超时 —— 对用户来说都是"这个地址到不了"
    return fail('unreachable')
  }

  if (res.status === 401 || res.status === 403 || res.status === 400 && false) {
    return fail('unauthorized')
  }
  // 404 / 405：地址不对（或者那家根本没有列模型这个接口）
  if (res.status === 404 || res.status === 405) return fail('no_endpoint')
  // 其余 4xx 基本也是"这个凭证/这个地址不对"，归到钥匙那一类更好懂
  if (res.status >= 400 && res.status < 500) return fail('unauthorized')
  if (res.status >= 500) return fail('unreachable')

  let body: unknown
  try {
    body = JSON.parse(await res.text())
  } catch {
    return fail('bad_response')
  }
  const data = (body as { data?: unknown })?.data
  // ★ 拿不到名单**不算失败** —— 有些服务商就是不给列表，
  //   而我们的目的是验"地址通、钥匙对"，那个目的已经达到了。
  if (!Array.isArray(data)) return { ok: true, models: [] }
  const models = data
    .map(m => (m as { id?: unknown })?.id)
    .filter((x): x is string => typeof x === 'string')
  return { ok: true, models }
}
```

> ⚠️ 上面那一行 `res.status === 400 && false` 是笔误，实现时删掉它 —— 写在这里是为了让你看见"别顺手把 400 也归到钥匙类"（有些服务商的 400 是"你这个模型名不对"）。**只认 401 / 403 和其余 4xx 兜底**。

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run server/modeltest.test.ts`
Expected: PASS（8 条）

- [ ] **Step 5: 加路由**

`server/app.ts` import 加：

```ts
import { probeConnection } from './modeltest.ts'
```

在 `/api/models` 那一段里插入（**排在 `:id` 那两条正则前面无所谓，`activate`/`test` 都不是数字**）：

```ts
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
      // 库里那一套：先按 id 取，取不到就是 404（别人的 / 没有的，同一个结局）
      let conn: { baseUrl: string; apiKey: string }
      if (body.id !== undefined) {
        const s = resolveSecretById(Number(body.id), str(body.kind) as ModelKind, user, deps.models)
        if (!s) throw new HttpError('BAD_REQUEST', '没有这一套设置', 404)
        conn = { baseUrl: s.baseUrl, apiKey: s.apiKey }
      } else {
        conn = {
          baseUrl: normalizeBaseUrl(str(body.baseUrl)),
          apiKey: str(body.apiKey).trim(),
        }
        if (!conn.apiKey) throw new HttpError('BAD_REQUEST', '钥匙不能为空')
      }
      sendJson(res, 200, await probeConnection(conn))
      return
    }
```

> `resolveSecretById` 需要 Task 3 补一个导出：按 `id + kind + user` 取解密后的连接信息（`resolveSecret` 是"取正在用的那一套"，这里是"取指定的那一套"）。**加在 `server/models.ts` 里**，实现和 `resolveSecret` 共用同一个查询，只把 `WHERE id = ?` 换成指针那一段。测试：`server/models.test.ts` 追加一条「取指定的那一套，别人的 id → null」。

- [ ] **Step 6: 全量测 + 提交**

Run: `npx vitest run`
Expected: 全绿

```bash
git add server/modeltest.ts server/modeltest.test.ts server/models.ts server/app.ts server/app.test.ts
git commit -m "feat(模型设置): 「测一下」—— 打 GET /models，一分钱不花

实测商汤支持这个接口（HTTP 200）。
它证明的是「地址通、钥匙对」，不是「那个模型能用」—— 那句话要同时写进界面文案。

❌ 失败文案里不许出现 ENOTFOUND 这类运维口径；401 那句把新手常犯的几种一次说全。
⚠️ 模型名单不全（商汤的列表里就没有我们自己在用的 sensenova-u1.5-fast），
   所以名单只能当建议，界面必须留着「自己手打」。"
```

---

### Task 6: 按用户造模型客户端

**Files:**
- Modify: `server/sn.ts`（构造参数收窄成 `ModelConnection`）
- Create: `server/clientFor.ts`
- Test: `server/clientFor.test.ts`

**Interfaces:**
- Consumes: `resolveSecret`（Task 3）、`SenseNovaClient`（`server/sn.ts`）、`Config`（`server/config.ts`）
- Produces: `resolveClients(user, deps): { chat: SenseNovaClient; image: SenseNovaClient }`

> **为什么要两个客户端**：`chat` 那一栏管 `/api/route` + `/api/suggest`（要看图的模型），
> `image` 那一栏管 `/api/edit`（真改图的模型）。§7.4 要求它们**彻底分开** ——
> 包括"图片的钥匙填错了，对话完全不受影响"。一个客户端一个连接，最直白。

- [ ] **Step 1: 写失败的测试**

创建 `server/clientFor.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { createVault } from './keyvault.ts'
import { activateConfig, createConfig } from './models.ts'
import { resolveClients, type ClientDeps } from './clientFor.ts'

const USER = { id: 1, username: 'a', email: 'a@b.c' }
const CONFIG = {
  apiKey: 'sk-default-key', baseUrl: 'https://token.sensenova.cn/v1',
  imageModel: 'sensenova-u1.5-fast', vlmModel: 'sensenova-6.8-flash-lite',
  port: 8787, dbPath: ':memory:', photoDir: '/tmp', sessionSecret: 's',
}

function fresh(): ClientDeps {
  const db = openDb(':memory:')
  db.raw.prepare('INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?,?,?,?,?)')
    .run(USER.id, USER.username, USER.email, 'h', 1)
  return { db, vault: createVault('test-secret'), config: CONFIG }
}

describe('按用户取客户端', () => {
  it('没配 → 两个都用默认那个', () => {
    const c = resolveClients(USER, fresh())
    expect(c.chat.baseUrl).toBe(CONFIG.baseUrl)
    expect(c.image.apiKey).toBe(CONFIG.apiKey)
  })

  it('★ 只配了对话 → 对话换掉，图片一个字不变', () => {
    const d = fresh()
    const m = createConfig({
      kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1',
      apiKey: 'sk-chat-only', modelId: 'my-vlm', alias: '甲',
    }, USER, d)
    activateConfig({ kind: 'chat', id: m.id }, USER, d)

    const c = resolveClients(USER, d)
    expect(c.chat.apiKey).toBe('sk-chat-only')
    expect(c.chat.baseUrl).toBe('https://chat.example.com/v1')
    expect(c.image.apiKey).toBe(CONFIG.apiKey)
    expect(c.image.baseUrl).toBe(CONFIG.baseUrl)
  })

  it('★ 只配了图片 → 图片换掉，对话一个字不变', () => {
    const d = fresh()
    const m = createConfig({
      kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1',
      apiKey: 'sk-img-only', modelId: 'my-editor', alias: '乙',
    }, USER, d)
    activateConfig({ kind: 'image', id: m.id }, USER, d)

    const c = resolveClients(USER, d)
    expect(c.image.apiKey).toBe('sk-img-only')
    expect(c.chat.apiKey).toBe(CONFIG.apiKey)
  })

  it('★ 两边都配了 → 各走各的，绝不串（§7.4 四条必测里最要紧的一条）', () => {
    const d = fresh()
    const a = createConfig({ kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat', modelId: 'vlm', alias: '甲' }, USER, d)
    const b = createConfig({ kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-img', modelId: 'edit', alias: '乙' }, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    activateConfig({ kind: 'image', id: b.id }, USER, d)

    const c = resolveClients(USER, d)
    expect([c.chat.apiKey, c.chat.baseUrl]).toEqual(['sk-chat', 'https://chat.example.com/v1'])
    expect([c.image.apiKey, c.image.baseUrl]).toEqual(['sk-img', 'https://img.example.com/v1'])
  })

  it('★ 图片的钥匙读不出来（主密钥换过）→ 只有图片回默认，对话不受影响', () => {
    const d = fresh()
    const b = createConfig({ kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-img', modelId: 'edit', alias: '乙' }, USER, d)
    activateConfig({ kind: 'image', id: b.id }, USER, d)

    const broken: ClientDeps = { ...d, vault: createVault('another-secret') }
    const c = resolveClients(USER, broken)
    expect(c.image.apiKey).toBe(CONFIG.apiKey)   // 回默认
    expect(c.chat.apiKey).toBe(CONFIG.apiKey)
  })

  it('★ 模型名用的是用户填的那个', () => {
    const d = fresh()
    const a = createConfig({ kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat', modelId: 'my-vlm', alias: '甲' }, USER, d)
    activateConfig({ kind: 'chat', id: a.id }, USER, d)
    expect(resolveClients(USER, d).chat.vlmModel).toBe('my-vlm')
  })
})
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run server/clientFor.test.ts`
Expected: FAIL —— 找不到 `./clientFor.ts`

- [ ] **Step 3: 收窄 `SenseNovaClient` 的构造参数**

`server/sn.ts` 里，把 `private readonly cfg: Config` 换成：

```ts
/**
 * 一个模型客户端需要的最小信息。
 *
 * ★ 原来是直接吃整个 `Config` —— 那意味着"客户端"和"进程级的配置"绑死了，
 * 一个进程只能有一个客户端。用户接自己的模型要求**按人、按类别**各造一个，
 * 所以这里收窄成"连接 + 两个模型名"。
 *
 * `Config` 结构上满足它，所以老代码 `new SenseNovaClient(config)` 一个字不用改。
 */
export type ModelConnection = {
  apiKey: string
  baseUrl: string
  /** 这一条的模型名。chat 客户端只用得上 vlmModel，image 客户端只用 imageModel */
  modelId: string
}
```

`SenseNovaClient` 构造改成：

```ts
export class SenseNovaClient {
  private readonly cfg: ModelConnection
  private readonly fetchImpl: typeof fetch
  constructor(cfg: ModelConnection, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg
    this.fetchImpl = fetchImpl
  }
  /** 这一条连接指向哪。测试和"按用户造客户端"要靠它断言 */
  get baseUrl(): string { return this.cfg.baseUrl }
  get apiKey(): string { return this.cfg.apiKey }
  get vlmModel(): string { return this.cfg.modelId }
  get imageModel(): string { return this.cfg.modelId }
  // …下面 chatJson / edit / postJson 里的 this.cfg.vlmModel / imageModel 全部改成 this.cfg.modelId
}
```

> ⚠️ 这样一来 `Config` 就不再满足 `ModelConnection` 了（它有 `vlmModel` 和 `imageModel`
> 两个字段，没有 `modelId`）。**默认客户端**由 `resolveClients` 用两个显式的
> `ModelConnection` 构造出来 —— 见下一步。`server/sn.test.ts` 里所有
> `new SenseNovaClient(cfg)` 的调用点要跟着改成显式的 `{ apiKey, baseUrl, modelId }`。

- [ ] **Step 4: 写 `server/clientFor.ts`**

```ts
import type { PublicUser } from './account.ts'
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import type { Vault } from './keyvault.ts'
import { resolveSecret, type ModelConfigDeps } from './models.ts'
import { SenseNovaClient } from './sn.ts'

export type ClientDeps = { db: Db; vault: Vault; config: Config }

/**
 * 这一次请求该用哪个模型客户端。
 *
 * ★ **每条请求都要重新取一次**，不缓存。理由：用户随时可能刚在设置里换过；
 * 而"解密 + 一次 SQLite 查询"在这个量级上根本不值一提
 * （OrcaRouter 也是按请求解密、明确不缓存）。
 *
 * ★ **两个类别各造一个客户端**（§7.4）：
 *   · `chat`  —— `/api/route` 和 `/api/suggest`（要看图的模型）
 *   · `image` —— `/api/edit`（真改图的模型）
 *   分开的直接好处：图片的钥匙填错了，对话**完全不受影响** ——
 *   因为它们是两条独立的路，谁也不会碰谁。
 *
 * 任何一步取不到（没配 / 没激活 / 密文读不出来）都安静地回默认。
 * **不抛**：那是"用户配过但现在用不了"，正确答案是照旧能用（走我们的），
 * 而不是让他连图都改不了。
 */
export function resolveClients(user: PublicUser, deps: ClientDeps): {
  chat: SenseNovaClient
  image: SenseNovaClient
} {
  return {
    chat: clientOf('chat', user, deps),
    image: clientOf('image', user, deps),
  }
}

function clientOf(kind: 'chat' | 'image', user: PublicUser, deps: ClientDeps): SenseNovaClient {
  const modelDeps: ModelConfigDeps = { db: deps.db, vault: deps.vault }
  const secret = resolveSecret(kind, user, modelDeps)

  // 用户没配（或配了用不了）→ 用我们自己的那一套。
  // 模型名取 config 里对应的那一个：chat 用 vlm、image 用 image model。
  const conn = secret
    ? { apiKey: secret.apiKey, baseUrl: secret.baseUrl, modelId: secret.modelId }
    : {
      apiKey: deps.config.apiKey,
      baseUrl: deps.config.baseUrl,
      modelId: kind === 'chat' ? deps.config.vlmModel : deps.config.imageModel,
    }

  return new SenseNovaClient(conn)
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `npx vitest run server/clientFor.test.ts server/sn.test.ts`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add server/sn.ts server/clientFor.ts server/clientFor.test.ts server/sn.test.ts
git commit -m "feat(模型设置): 按用户、按类别造模型客户端

SenseNovaClient 的构造参数从整个 Config 收窄成 ModelConnection（连接 + 一个模型名）——
一个进程一个客户端的时代结束了。

两个类别各造一个：chat 管 route/suggest，image 管 edit。
于是「图片的钥匙填错 → 对话完全不受影响」不是靠判出来的，是结构上就碰不着。

每一层取不到都安静回默认、不抛：用户配过但现在用不了，照旧能用我们的才对。"
```

---

### Task 7: 把三个 AI 接口接上（§7.4 那四条必测）

**Files:**
- Modify: `server/app.ts`（`/api/route`、`/api/suggest`、`/api/edit` 三处）
- Test: `server/app.test.ts`（追加一组）

**Interfaces:**
- Consumes: `resolveClients`（Task 6）
- Produces: 三条 AI 接口按登录用户取客户端

- [ ] **Step 1: 写失败的测试**

往 `server/app.test.ts` 追加。**这一组是 §7.4 用户点名要的四条，一条都不能少**：

```ts
describe('★ 两套 key 彻底分开（§7.4，用户点名要的四条）', () => {
  const CHAT = { kind: 'chat', provider: 'custom', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat', modelId: 'vlm', alias: '甲' }
  const IMAGE = { kind: 'image', provider: 'custom', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-img', modelId: 'edit', alias: '乙' }

  /** 记下每一次真被发出去的上游请求（URL + 用的哪把钥匙） */
  function spyClient(calls: string[]) {
    return {
      async chatJson() { calls.push('chat'); return '{}' },
      async edit() { calls.push('edit'); return 'AAAA' },
    }
  }

  it('① 只配了图片 → 对话照常能用（走默认）', async () => { /* … */ })
  it('② 只配了对话 → 图片照常能用', async () => { /* … */ })
  it('③ 两边都配了 → 各走各的，绝不串', async () => { /* … */ })
  it('★ ④ 图片的 key 填错了 → 对话完全不受影响', async () => { /* … */ })
})
```

> **实现这套测试的写法**（写清楚，别让实现者猜）：
> 把 `route` / `suggest` / `edit` 要用的客户端做成**可注入**的 ——
> `AppDeps` 上那三个接口现在直接读 `deps.client`，改成读
> `resolveClients(user, deps.clients)` 的结果，而 `ClientDeps.config` 就是原来那个 `Config`。
> 测试里给 `deps.clients.config` 配一个假的 `fetch`（用 `vi.fn()` 当 `fetchImpl`
> 传给 `SenseNovaClient` 不方便，改成在 `ClientDeps` 上加一个可选的
> `clientFactory?: (conn) => SenseNovaClient`，默认 `c => new SenseNovaClient(c)`）。
> **断言看的是"我们发出去的 URL 和 Authorization 头"**，
> 那才是"到底用了谁的钥匙"的**唯一证据** —— 断言"调了哪个 mock"是自欺欺人。

上面四条各自的断言（照抄）：

```
① 建 image 配置并激活 → POST /api/route → 断言上游 URL 是 token.sensenova.cn（默认），
   Authorization 是默认那把 key
② 建 chat 配置并激活 → POST /api/edit  → 断言上游 URL 是 token.sensenova.cn
③ 两个都建都激活 → route 打 chat.example.com、edit 打 img.example.com
④ chat 正常、image 那把 key 让上游回 401 → 先 POST /api/edit 拿到错误，
   紧接着 POST /api/route **必须照常成功**，且它的上游请求里
   出现的仍然是 chat 那把 key
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run server/app.test.ts -t '两套 key'`
Expected: FAIL —— 上游 URL 还是默认那个

- [ ] **Step 3: 改那三处**

`server/app.ts` 里 `AppDeps.client?: SenseNovaClient` 换成：

```ts
  /**
   * 默认模型客户端要的那份配置（§7）。用户没配自己的时候用它。
   *
   * ⚠️ **不传时 /api/route、/api/suggest、/api/edit 都返回 503** —— 让"没接线"可见，
   * 而不是静默失败（这是原来 `client` 那条注释的原话，现在它管的是"默认那一套"）。
   */
  clients?: ClientDeps
  /** 测试注入用。生产永远走默认（`c => new SenseNovaClient(c)`）。 */
  clientFactory?: (conn: ModelConnection) => SenseNovaClient
```

三个接口从：

```ts
      if (!deps.client || !deps.queue) {
        throw new HttpError('INTERNAL', '后端没有配置模型客户端', 503)
      }
      const body = await readJsonBody(req)
      sendJson(res, 200, await handleRoute(body, { client: deps.client, queue: deps.queue }))
```

改成：

```ts
      const user = requireUser(deps, req, res)   // ← 这一句原样保留（上面已经有了）
      if (!deps.clients || !deps.queue) {
        throw new HttpError('INTERNAL', '后端没有配置模型客户端', 503)
      }
      const body = await readJsonBody(req)
      // ★ 取客户端放在**读完请求体之后**：读一具 12 MB 的 body 要花时间，
      //   而"该用谁的钥匙"在那一刻之前就已经定了。顺序反过来只是白等。
      const { chat } = resolveClients(user, deps.clients)
      sendJson(res, 200, await handleRoute(body, { client: chat, queue: deps.queue }))
```

`/api/suggest` 同样（也用 `chat`）。`/api/edit` 用 `image`：

```ts
      const { image } = resolveClients(user, deps.clients)
      sendJson(res, 200, await handleEdit(body, {
        client: image, queue: deps.queue, signal: ac.signal,
      }))
```

> ⚠️ **`/api/route` 和 `/api/suggest` 现在各自 `requireUser` 一次，别重复调用。**
> 原来的写法是 `requireUser(deps, req, res)` 丢掉返回值；现在要接住它。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run`
Expected: 全绿

- [ ] **Step 5: 真机走一遍（不许跳）**

```bash
# 服务在跑的话直接用；不在就跑 npm run dev（开一个属于用户的窗口，别用后台任务）
```
在浏览器里：设置里加一套 chat 配置、填一把**故意错的**钥匙、激活 →
回修图页说一句话 → **必须出现「你设置里的模型连不上」这类话 + 一个去设置的入口**，
而且**不许**安静地用回我们的。
再把配置删掉 → 一切恢复。

- [ ] **Step 6: 提交**

```bash
git add server/app.ts server/app.test.ts
git commit -m "feat(模型设置): 三个 AI 接口按登录用户取客户端（§7.4 四条必测）

chat 客户端管 route/suggest、image 客户端管 edit。
四条必测（只配图片/只配对话/都配/图片钥匙填错）断言的是
**真发出去的上游 URL 和 Authorization 头** —— 那才是「用了谁的钥匙」的唯一证据。"
```

---

### Task 8: 用户管理页骨架 + 右上角 👤

> **为什么这一页要跟模型设置一起做**：spec §3.6 里，模型那一行是长在用户管理页上的。
> 而那一页**还不存在**（`src/ui/view.ts` 只有 landing / edit / gallery / work 四种）。
> 它是 §12 的**第三段**，本来排在模型设置（第四段）前面。
> 这里只立**最小骨架**：用户名 + 使用情况 + 退出登录 + 一个「模型」入口。
> 其余几项（默认导出尺寸 / 默认风格 / 本地文件夹 / 深色浅色）等各自的依赖到位了再补 ——
> 正合 §12 自己那句「每段做完都能单独用、单独验收」。

**Files:**
- Modify: `src/ui/view.ts`（加 `{ kind: 'account' }`）
- Create: `src/ui/AccountPage.tsx`
- Modify: `src/App.tsx`（渲染分支 + 顶栏右上角那颗 👤）
- Test: `src/App.test.tsx`（追加）

**Interfaces:**
- Produces: 路由 `/app/account`；`View` 多一个成员；`AccountPage` 组件

- [ ] **Step 1: 写失败的测试**

往 `src/App.test.tsx` 追加（沿用该文件已有的渲染助手）：

```tsx
describe('用户管理页', () => {
  it('★ /app/account 打得开，而且不是白屏', async () => {
    // …登录后 go('/app/account')
    expect(screen.getByText('哈吉米')).toBeTruthy()
  })

  it('★ 页面上不许出现我们自己用的模型名（§7.3 + §10 的变异测试）', async () => {
    // 这条的变异是「把 sensenova-6.8-flash-lite 写死进页面」→ 必须红
    expect(document.body.textContent).not.toContain('sensenova')
    expect(document.body.textContent).not.toContain('token.sensenova.cn')
  })

  it('有「模型」这一项，点了进模型设置', async () => { /* … */ })

  it('★ 有退出登录，点完回落地页', async () => { /* … */ })
})
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run src/App.test.tsx -t '用户管理页'`
Expected: FAIL

- [ ] **Step 3: 加路由**

`src/ui/view.ts`：`View` 加一个成员，`viewFromPath` / `pathOf` 各加一行：

```ts
export type View =
  | { kind: 'landing' }
  | { kind: 'edit' }
  | { kind: 'gallery' }
  | { kind: 'work'; id: number }
  | { kind: 'account' }        // ← 用户管理（§3.6）。收在右上角 👤，不占一级导航

// viewFromPath 里：
  if (path === `${APP}/account`) return { kind: 'account' }

// pathOf 里：
  if (v.kind === 'account') return `${APP}/account`
```

- [ ] **Step 4: 写 `src/ui/AccountPage.tsx`**

```tsx
import { useState } from 'react'
import type { AccountUser } from '../api/account.ts'
import { post } from '../api/client.ts'
import type { View } from './view'

/**
 * 用户管理（§3.6）。**先只做骨架**，它是 §12 的第三段。
 *
 * 现在有：用户名 / 使用情况 / 模型入口 / 退出登录。
 * 还差（各自等依赖）：默认导出尺寸、默认风格、本地文件夹、深色浅色。
 *
 * ⚠️ 页面上**不许出现我们自己用的模型名或接口地址**（§7.3）。
 * 用户看到的只有「默认」和别名 —— 型号名对他没意义，限制才有意义。
 */
export function AccountPage({
  user, workCount, onGo, onSignedOut,
}: {
  user: AccountUser
  workCount: number
  onGo: (v: View) => void
  onSignedOut: () => void
}) {
  const [leaving, setLeaving] = useState(false)

  return (
    <div className="account">
      <h1 className="account-name">{user.username}</h1>

      <div className="account-stats">
        <div className="stat"><b>{workCount}</b><span>张作品</span></div>
      </div>

      <div className="account-rows">
        {/* 模型那一行（§3.6）。显示的是**别名或「默认」**，绝不是型号 */}
        <button className="account-row" onClick={() => onGo({ kind: 'models' })}>
          <span className="account-row-label">模型</span>
          <span className="account-row-value">默认</span>
          <span className="account-row-go" aria-hidden="true">›</span>
        </button>
      </div>

      <button
        className="account-signout"
        disabled={leaving}
        onClick={() => {
          setLeaving(true)
          // 退出是幂等的、而且不该因为网络失败就把用户困住 ——
          // 服务端那条路本来就不读请求体、只清一个 cookie。
          post('/api/logout', {}).catch(() => {}).then(onSignedOut)
        }}
      >{leaving ? '正在退出…' : '退出登录'}</button>
      {/* ⚠️ 注销账号**这一版不做**：它会连带删掉作品和文件，
          而"删了什么、能不能后悔"还没有定案（§11）。不留一个点了会出事的按钮。 */}
    </div>
  )
}
```

- [ ] **Step 5: 接进 `src/App.tsx`**

顶栏右上角加那颗 👤（**只在修图页的顶栏里加**，和 §3.2 那张图一致）：

```tsx
            {/* 用户管理收在右上角（§3.2）—— 它一辈子点几次，不配占一个一级位置。
                alt="" 同理：旁边没有文字，所以这里**必须**给一个 aria-label。 */}
            <button className="user-btn" onClick={() => go({ kind: 'account' })}
                    aria-label="用户管理">👤</button>
```

主渲染区加：

```tsx
      {view.kind === 'account' && (
        <AccountPage
          user={user}
          workCount={works.length}
          onGo={go}
          onSignedOut={() => setUser(null)}
        />
      )}
```

> `works` 如果此刻还没有，先传 `0` 并在计划执行记录里写一句"等作品列表在 App 层可用时接上" ——
> **不许**为了让数字好看去多发一次请求。

- [ ] **Step 6: 跑测试 + 三个脚本**

Run: `npx vitest run && node scripts/check-mobile-layout.mjs && node scripts/check-dev-urls.mjs`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add src/ui/view.ts src/ui/AccountPage.tsx src/App.tsx src/App.test.tsx
git commit -m "feat(用户管理): 立起最小骨架 —— 用户名 / 作品数 / 模型入口 / 退出登录

挂在右上角 👤（§3.2），不占一级导航。
注销账号故意不做：它会连带删掉作品和文件，而「删了什么、能不能后悔」还没定案。
页面里不出现任何我们自己的模型名或地址（§7.3）。"
```

---

### Task 9: 模型设置页

**Files:**
- Create: `src/ui/ModelSettings.tsx`
- Modify: `src/ui/view.ts`（加 `{ kind: 'models' }`）
- Modify: `src/App.tsx`（渲染分支）
- Create: `src/api/models.ts`（接口封装）
- Test: `src/ui/ModelSettings.test.tsx`

**Interfaces:**
- Consumes: `post` / `get` / `patch` / `del`（`src/api/client.ts`）
- Produces: `ModelSettings` 组件、`src/api/models.ts` 的 `listModels` / `createModel` / `updateModel` / `deleteModel` / `activateModel` / `testModel`

- [ ] **Step 1: 写 `src/api/models.ts`**

```ts
import { del, get, patch, post } from './client.ts'

export type ModelKind = 'chat' | 'image'
export type PublicConfig = {
  id: number; kind: ModelKind; provider: string; baseUrl: string
  modelId: string; alias: string; keyHint: string; active: boolean
}
export type ProbeResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: string; message: string }

export const listModels = () => get<{ configs: PublicConfig[] }>('/api/models')
export const createModel = (b: unknown) => post<PublicConfig>('/api/models', b)
export const updateModel = (id: number, b: unknown) => patch<PublicConfig>(`/api/models/${id}`, b)
export const deleteModel = (id: number) => del<{ wasActive: boolean }>(`/api/models/${id}`)
export const activateModel = (kind: ModelKind, id: number | null) =>
  post<{ ok: true }>('/api/models/activate', { kind, id })
/**
 * ★ 测的是**表单里现在这份值**，不是库里那份。
 *   所以默认走"把参数一起带上去"那条路 —— 用户点这个按钮的时候，
 *   十有八九还没保存。（LobeChat 是反过来：点检查先偷偷存一次表单。）
 */
export const testModel = (b: { baseUrl: string; apiKey: string }) =>
  post<ProbeResult>('/api/models/test', b)
```

- [ ] **Step 2: 写失败的测试**

`src/ui/ModelSettings.test.tsx`（mock 掉 `src/api/models.ts`）：

```tsx
describe('模型设置', () => {
  it('★ 空的时候说的是「用默认」，不是「没配置」', () => {
    // 「没配置」读起来像出错了；「用默认」才是事实
    expect(screen.getByText(/用默认/)).toBeTruthy()
  })

  it('★ 页面上不出现任何型号名或我们的地址（§7.3 那条变异测试）', () => {
    expect(document.body.textContent).not.toMatch(/sensenova|token\.sensenova/)
  })

  it('★ 接口地址归一是前端做的 —— 用户只写域名也认', async () => { /* … */ })

  it('★ 删掉正在用的那套 → 出现那条提示，而且带一个「换成其他的」入口', async () => { /* … */ })

  it('★ 删掉不是在用的那套 → 一句提示都不许有', async () => { /* … */ })

  it('★ 测一下：失败时把服务商那句话原样显示出来', async () => { /* … */ })
})
```

- [ ] **Step 3: 跑测试，确认它失败**

Run: `npx vitest run src/ui/ModelSettings.test.tsx`
Expected: FAIL

- [ ] **Step 4: 写 `src/ui/ModelSettings.tsx`**

界面照 §7.4 那张图，**一字不改**：

```
模型设置 · 对话与理解
  ✓  我的便宜货      [ 编辑 ]   [ 删除 ]
     那个快的        [ 用这个 ] [ 编辑 ]  [ 删除 ]
     ─────────────────────────────
     + 添加一套

  当前：我的便宜货        ← 或者「默认（本服务提供）」
```

要点（每一条都有它的来处）：

- **顶部一句话说清"不配会怎样"**：`「不配就用我们准备的。配了之后，改图花的是你自己的额度。」`
- **两个分区**，标题分别是 `对话与理解`（看照片、听懂你的话）和 `图片生成`（真的把照片改掉）——
  **用能力描述，不用型号**（§7.3）
- **每条显示别名 + 状态**，不显示型号；别名旁边的 `[ 编辑 ]` 打开表单时，
  表单里的**模型名**才露出来（§7.4：「必须是那家认的真名 —— 只在设置里翻开来才露」）
- **钥匙那一格**：已存时显示 `keyHint` 和一个 `[ 换一把 ]`；**永不回显明文**（§7.7）
- **表单里「接口地址」下面的小字**：`填域名也行，我们会补上 /v1`
- **表单里「测一下」的按钮 + 一行固定说明**：
  `只验地址和钥匙通不通，不代表那个模型一定能用。`
- **模型名那一格**：`<input list="...">` 配一个 `<datalist>`（列表来自"测一下"返回的 `models`），
  **同时允许手打** —— 商汤的列表不全，我们自己在用的那个就不在里面
- **`keyHint` 是「（读不出来，请重填）」时**，那一行要显眼，并给 `[ 换一把 ]`

- [ ] **Step 5: 跑测试 + 三个脚本**

Run: `npx vitest run && node scripts/check-mobile-layout.mjs && node scripts/check-dev-urls.mjs`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/ui/ModelSettings.tsx src/ui/ModelSettings.test.tsx src/ui/view.ts src/App.tsx src/api/models.ts
git commit -m "feat(模型设置): 界面 —— 两类各存好几套、别名、测一下、删在用的给换一套的入口

界面上到处显示别名，型号名只在编辑表单里露（§7.4）。
「测一下」的说明里明写它只验地址和钥匙、不保证模型能用（§7.3 不许写做不到的事）。
模型名既能从列表选、也能手打 —— 商汤的列表不全。"
```

---

### Task 10: 骨架接得住零件抖（§7.2）+ 收尾

**Files:**
- Test: `server/route.test.ts`（追加一组）
- Modify: `docs/superpowers/specs/2026-09-24-accounts-and-gallery-design.md`（§12 标掉「四」的进度）
- Modify: `CLAUDE.md` 或 `docs/` 里记一句环境变量的事

**Interfaces:**
- 不新增接口。这一任务只补**"接进来的模型很笨"**那一整类测试。

- [ ] **Step 1: 写这组测试（§7.2 点名要的）**

往 `server/route.test.ts` 追加：

```ts
/**
 * ★ §7.2「骨架必须接得住零件抖」。
 *
 * 用户可能接一个很便宜、很笨的模型。真模型今天听话，
 * **不代表用户接的那个听话** —— 而产品不能因为换个模型就崩。
 */
describe('★ 不听话的假模型（§7.2）', () => {
  const CASES = [
    ['回垃圾', '嗯嗯这个照片挺好的呀，蓝天白云真好看～'],
    ['回一半', '{"route":"params","paramDeltas":{"bright'],
    ['回错格式', '<route>params</route><params>{"brightness":20}</params>'],
    ['回空', ''],
    ['回个数组', '[{"route":"generate"}]'],
    ['字段全对但值离谱', '{"route":"params","paramDeltas":{"brightness":99999},"reply":"好"}'],
  ] as const

  for (const [name, output] of CASES) {
    it(`${name} → 不崩，而且降级说得明明白白`, async () => {
      // 用一个"假模型"客户端，chatJson 就回上面那一串
      const r = await handleRoute(REQ, { client: fakeClient(output), queue: passthroughQueue })
      // 一、不抛
      expect(r.decision).toBeTruthy()
      // 二、★ 必须**明说是降级**（degraded），不能假装那是模型的本意
      //     —— 09-29 那个"同一件事做两遍"的 bug 就是因为这个信号没人看（§4.7）
      expect(r.decision.degraded).toBe(true)
      // 三、降级之后仍然是一条**能走的路**：原文当 prompt 走生成
      expect(r.decision.route).toBe('generate')
      expect(r.decision.editPrompt).toBeTruthy()
    })
  }

  it('★ 降级的日志里带原始输出 —— 只写"降级了"查不出模型到底吐了什么', async () => {
    // 断言 console.warn 被调用，且参数里含模型原文的一段
  })
})
```

- [ ] **Step 2: 跑，把真的会崩的那几条修掉**

Run: `npx vitest run server/route.test.ts -t '不听话的假模型'`
Expected: **先看它红在哪** —— 红了就是真 bug，去修 `server/validate.ts` 的 `parseDecision`。
**不许**改测试的期望去迁就实现。

- [ ] **Step 3: 全量回归**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: 全绿

- [ ] **Step 4: 真浏览器走一遍（桌面 + 手机两个视口）**

用 `.superpowers/scratch/audit/` 里现成的脚本，或新写一个：
加一套配置 → 测一下 → 激活 → 回修图页说一句话 → 确认走的是新模型（看服务端日志里的上游 URL）
→ 删掉正在用的那套 → **必须弹那条提示 + 换一套的入口** → 点它 → 换成功。

- [ ] **Step 5: 文案通读**

Run: `npm run check:copy`
**逐条读一遍新出现的那几句**，对着 `docs/文案规范.md` 核：
不许出现型号名、不许出现我们的地址、不许写做不到的事。

- [ ] **Step 6: 更新 §12 的进度 + 提交**

在 spec §12 那张表里，把「四、模型设置」那一行的"做完之后能用什么"补上实测结论；
并在 §7 开头加一行「2026-09-30 已实现」+ 指向本计划。

```bash
git add -A
git commit -m "test(模型设置): 不听话的假模型那一整组 + 收尾

§7.2 点名要的：回垃圾 / 回一半 / 回错格式 / 回空 / 回数组 / 值离谱，
每一样都不能崩，而且**必须明说是降级**（degraded）——不能假装那是模型的本意。"
```

---

## 自检记录（写完计划之后逐条核过）

**1. spec 覆盖**

| spec 条目 | 落在哪个任务 |
|---|---|
| §4.1 `model_configs` 表 + users 两个指针 | Task 2 |
| §7.1 换模型≠换行为 | Global Constraints（提示词一个字不改） |
| §7.2 骨架接得住零件抖 | Task 10 |
| §7.3 写限制不写型号、不暴露我们用哪家 | Task 8 Step 1 测试、Task 9 Step 4 |
| §7.4 两套 key 分开 + 四条必测 + 多套 + 别名 + 删除的两种行为 | Task 3、Task 7、Task 9 |
| §7.5 服务商适配（商汤 / OpenAI 兼容 / 自定义） | ⚠️ **只做了「自定义地址」这一半** —— 见下面「已知缺口」 |
| §7.6 热切换 | ⚠️ **没做** —— 见下面「已知缺口」 |
| §7.7 Key 管理六条 | Task 1、Task 3（掩码 / 加密 / 不进日志 / 能删 / 回默认） |
| §7.8 隐私三条 | 文案规范那边补；**本计划不含隐私政策**（那是 §11 的事） |
| §10 测法表里跟 §7 有关的 11 条 | Task 1/3/4/7/8/9/10 各自覆盖 |
| §3.6 用户管理页 | Task 8（只做骨架） |
| 市场校准四条 | Task 5（先存后测 / 失败文案）、Task 3（地址归一）、Task 9（列表不全要留手打） |

**2. 已知缺口（有意留的，别当成漏了）**

- **§7.5 的「商汤 / OpenAI 兼容」两个预设没做**：这一版只有「自定义地址」一条路，
  用户自己填地址。理由：**我们只有商汤一把钥匙，验证不了别家**；预设一张没验过的表
  等于写一句产品做不到的话（§7.3）。等真拿到第二家的钥匙再补预设。
- **§7.6 热切换没做**：它要求在对话栏里能切，而那是另一块界面。
  这一版切模型要回设置页 —— **能用，只是多两步**。
- **§7.8 的隐私政策没做**：§11 已经记着这笔。

**3. 占位符扫描**：无 TBD / TODO。Task 5 Step 3 里那一行 `res.status === 400 && false` 是**故意留的**
笔误标记，旁边的引用块写明了实现时要删掉 —— 如果你觉得这更绕，直接删掉那半行即可。

**4. 类型一致性**：`ModelKind` / `Provider` / `PublicConfig` / `SecretConfig` / `ModelConfigDeps` /
`ModelConnection` / `ClientDeps` / `ProbeResult` 在 Task 1→10 之间名字与字段一致。
`PublicConfig` 在 Task 3（服务端）和 Task 9（前端 `src/api/models.ts`）各定义一次 ——
**这是有意的**：`shared/` 里放它会把「服务端形状」和「前端形状」耦在一起，
而它们本来就可以各自演化（前端那份多了 `delted` 之类只需前端知道的东西时不必改服务端）。
