import { randomBytes } from 'node:crypto'
import type { Db } from './db.ts'
import { nowMs } from './clock.ts'
import type { Storage } from './storage.ts'
import { hashPassword, verifyPassword } from './password.ts'
import { normalizeUsername, checkUsername, checkEmail, checkPassword } from '../shared/account.ts'
import {
  signSession, verifySession, sessionExpiry, parseCookies, SESSION_COOKIE,
} from './session.ts'
import { HttpError, asObject, readTextCapped, str } from './http.ts'

export type PublicUser = { id: number; username: string; email: string }
/**
 * `fetchImpl` 是**给测试留的缝**（默认就是全局 fetch）：微信登录那条路要验的
 * 行为（换 openid、建号、撞名重试、上游报错怎么翻译）全都不该真去出网 ——
 * 和 `probeConnection(input, fetchImpl = fetch)` 是同一个形状。
 */
export type AccountDeps = {
  db: Db
  secret: string
  now?: () => number
  fetchImpl?: typeof fetch
}

type Row = { id: number; username: string; email: string; password_hash: string }

/** 时间从 deps 里取，测试才能把"30 天后过期"钉死，不随真实日期漂 ——
 *  那一个钟现在全服务端共用（`clock.ts` 的 `nowMs`）。 */

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
  // ⚠️ 「查不到这个人」和「签名不过」必须是**同一个结局**（null = 没登录）。
  // 分开处理等于给了攻击者一个信号：哪张票的 userId 是真的、只是签名不对。
  if (!row) return null

  const s = verifySession(token, row.password_hash, nowMs(deps), deps.secret)
  if (!s) return null

  // 哈希是**从库里查出来的**，不是请求里带来的 —— 上面那句 verifySession 用的也是它。
  // 拿请求里的哈希来验签等于自己造了一把钥匙，谁都能签出任意 userId 的票。
  return { id: row.id, username: row.username, email: row.email, passwordHash: row.password_hash }
}

/** 发一张票。三处成功路径（注册/登录/改密码）共用，免得漏掉某个字段。 */
function issue(user: PublicUser, passwordHash: string, deps: AccountDeps) {
  const expiresAt = sessionExpiry(nowMs(deps))
  return { user, token: signSession(user.id, passwordHash, expiresAt, deps.secret), expiresAt }
}

export async function handleSignup(body: unknown, deps: AccountDeps) {
  const o = asObject(body)

  // 前端那边也验一遍 —— 但那是体验，这遍才是规矩：请求可以伪造。
  const u = checkUsername(str(o.username))
  if (!u.ok) throw new HttpError('BAD_REQUEST', u.message)
  const e = checkEmail(str(o.email))
  if (!e.ok) throw new HttpError('BAD_REQUEST', e.message)
  // ⚠️ `u.value` 必须传进去 —— 这是"密码不能和名字一样"唯一的落地处。
  // 那个参数是**可选**的（前端要"边打边提示"，那时候用户还没填名字），
  // 所以忘了传不会报错、不会红，只会让这条规则**静默失效** ——
  // 而静默失效比大声挂掉难查得多，因为看起来一切正常。
  // `server/account.test.ts` 末尾那组端到端断言，钉的就是这一行。
  const p = checkPassword(str(o.password), u.value)
  if (!p.ok) throw new HttpError('BAD_REQUEST', p.message)

  // 哈希只在这里算一次，存库和签票用的是同一个 —— 两边不一致的话，
  // 刚注册完的人会立刻"登录态无效"。
  const hash = await hashPassword(p.value)
  try {
    deps.db.raw
      .prepare('INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(u.value, e.value, hash, nowMs(deps))
  } catch (err) {
    // 唯一约束是**数据库**在管，这里只是把它的报错翻译成人话。
    // 不先 SELECT 一下再插 —— 两个人同时注册同一个名字，两边都会查到"没被占用"，
    // 然后一个成功一个炸在插入上，而那个才是对的（数据库是唯一的裁判）。
    const msg = String((err as Error).message)
    if (msg.includes('users.username')) throw new HttpError('BAD_REQUEST', '这个名字有人用了，换一个吧')
    if (msg.includes('users.email')) throw new HttpError('BAD_REQUEST', '这个邮箱已经注册过了')
    // 认不出来的错误原样抛：它不是"你填得不对"，是我们的问题，不该伪装成 400
    throw err
  }

  // 回读一次而不是拿 `u.value` 拼：存进去的是什么，回来的就是什么 ——
  // 中间没有一层"我以为我存的是什么"。
  const row = deps.db.raw
    .prepare('SELECT id, username, email FROM users WHERE username = ?')
    .get(u.value) as PublicUser
  return issue(row, hash, deps)
}

export async function handleLogin(body: unknown, deps: AccountDeps) {
  const o = asObject(body)
  // ⚠️ 归一化用 `normalizeUsername`，**不是** `checkUsername` —— 后者还带着一整串
  // 「能不能拿这个名字注册」的规矩（长度、字符类、保留名），而登录问的是另一件事：
  // 用户已经有一个号了，他要问的是「我能不能进去」。
  // 用 checkUsername 的代价是**答非所问**，而它真的发生过：一个叫 `admin` 的人
  // （库里本来就有这个号）在登录页被告知「这个名字是留给官方账号的，换一个吧」，
  // 他读完问的是「是已经有这个账户了吗？」（2026-09-25）。
  const name = normalizeUsername(str(o.username))
  const rawPw = str(o.password)

  // ★ 两种错，两句话（2026-09-25 用户拍板改；原来三种情况共用一句
  //   「用户名或密码不对」）：
  //     · 查无此人（**也包括名字格式不对** —— 见下面那段）→「没有这个账号，去注册一个吧」
  //     · 密码不对                                          →「密码不对，再试一次」
  //
  // ⚠️ 「去注册一个吧」这半句是 2026-09-25 **用户后来又要的**（他的原话是
  //   「如果没有这个账户现在的提示后面加一个请前去注册」）。诊断说了、出路没说，
  //   用户还得自己往下找一步。他那句「请前去注册」是公文腔，落地成现在这句人话。
  //   ⚠️ 它和登录页下面那颗「还没有账号？注册一个」按钮**在意思上是重复的** ——
  //   那是**用户要的重复**：一句话在截图里、在他回头想的时候、在那颗按钮被别的
  //   状态挤掉的时候，仍然说得清下一步。（`server/account.test.ts` 和
  //   `src/App.test.tsx` 各有一条钉着这句话、和那颗按钮还在。）
  //
  // ⚠️ 为什么"分开说"现在是**安全的** —— 这条论证必须写在这里，因为它推翻的
  // 正是原来那段注释的道理（「区分了就等于告诉别人哪些用户名是真的」）：
  //
  //   **注册接口本来就会告诉你某个名字有没有人用** —— `handleSignup` 撞上数据库
  //   唯一约束时抛的「这个名字有人用了，换一个吧」（就在上面几十行处）。
  //   也就是说，"某个用户名存不存在"这件事**任何人早已经能一趟一趟试出来**，
  //   登录接口这里是捂着它**不换来任何防护**，只换来一句用户看不懂、照着走不
  //   下去的话（他拿到的是"密码不对"还是"没这个人"，决定他下一步去试密码还是
  //   去注册 —— 而这个方向本来就摆在注册按钮上，不是秘密）。
  //
  // 「格式不对」为什么也并进这一句，而不是单独给一句更精确的：
  //   ① 这句话对它是**真的** —— 过不了格式的名字在库里必然不存在；
  //   ② "格式不对"四个字单独出现，就重新变成一个筛子（用户会开始猜是哪条格式
  //      规矩拦的），而上面那半句已经说明存在性本来就可探测 —— 所以这里选的
  //      不是"少说一点"，是**只说真话、不说废话**。
  const NO_SUCH = () => new HttpError('BAD_REQUEST', '没有这个账号，去注册一个吧')

  const row = deps.db.raw
    .prepare('SELECT id, username, email, password_hash FROM users WHERE username = ?')
    .get(name) as Row | undefined
  if (!row) throw NO_SUCH()
  if (!(await verifyPassword(rawPw, row.password_hash))) {
    throw new HttpError('BAD_REQUEST', '密码不对，再试一次')
  }

  return issue({ id: row.id, username: row.username, email: row.email }, row.password_hash, deps)
}

/**
 * 微信登录那两把钥匙 + 一个换 openid 的出口。`appid`/`wxSecret` 从 Config 来
 * （`.env` 的 `WX_APPID` / `WX_SECRET`），**不放进 AppDeps** —— 它们只属于这一条路，
 * 而别的路拿不到它们，是因为压根没人把它们递过去。
 *
 * ⚠️ **微信那把 key 不叫 `secret`，是故意的**：`AccountDeps.secret` 是**签会话票
 *    那把**。两个都叫 `secret` 的话，调用方任何一次
 *    `{ ...accountDeps, secret: <微信的> }` 都会把签名钥匙**悄悄顶掉** ——
 *    症状是"票照发、就是查不出人"（写这条时就踩了一次）。
 *    两把钥匙不许同名，这一条对调用方（app.ts 那条路由）也成立。
 *
 * ⚠️ **没配 AppID/AppSecret 时不是这个函数管**（那是 app.ts 那条路由的事，
 *    它回 503，见那段注释）：走到这里说明"有没有配"已经判过了。
 *    这里只认一件事 —— **你带没带 code**。
 */
export type WxLoginDeps = AccountDeps & { appid: string; wxSecret: string }

/**
 * `code2session` 的等时上限。
 *
 * 这是**用户按了之后在等**的一次请求（和 chat 那条路同一个量级），不是后台任务 ——
 * 微信那边没响应时，用户该看到一句"再试一次"，而不是一个无限转的圈。
 */
const WX_TIMEOUT_MS = 10_000

/**
 * code → openid。**任何不对都抛 UNAUTHORIZED，绝不回显上游原文。**
 *
 * ⚠️ 这里的 URL 里带着 **AppSecret**（微信的接口就是收 GET 参数的）。所以：
 *   · 上游的报错正文、URL、状态码**一个字都不许进给用户的响应**（它们可能回显密钥）；
 *   · 日志那边也不打这个 URL —— 这个函数干脆一句话都不打（见下面那句注释）。
 *
 * ⚠️ 响应正文**带上限读**（`readTextCapped`）：地址虽然是我们写死的
 *    （不是用户填的），但"对面回多少"从来不归我们管。
 *
 * ⚠️ 只取 openid，**`session_key` 一律不碰**：它是拿来解小程序加密数据的，
 *    这一版没有那种需求；收下一个用不上的密钥只会多一处要保管的东西。
 */
async function codeToOpenid(code: string, deps: WxLoginDeps): Promise<string> {
  const fail = () => new HttpError('UNAUTHORIZED', '微信登录没成功，再试一次', 401)

  // URLSearchParams：code 是**从外面来的**，直接拼字符串的话里面一个 `&`
  // 就能把 secret 那一段顶掉（参数注入）。
  const url = 'https://api.weixin.qq.com/sns/jscode2session?' + new URLSearchParams({
    appid: deps.appid,
    secret: deps.wxSecret,
    js_code: code,
    grant_type: 'authorization_code',
  }).toString()

  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(WX_TIMEOUT_MS) })
  } catch {
    // 连不上 / 超时 / DNS —— 对用户都是"这次没登成，再试一次"
    throw fail()
  }

  let body: unknown
  try {
    body = JSON.parse(await readTextCapped(res, 1 << 20))
  } catch {
    // 不是 JSON、或者一大坨（含上游 5xx 的 HTML 错误页）—— 同一句
    throw fail()
  }
  if (!res.ok) throw fail()

  const openid = (body as { openid?: unknown } | null)?.openid
  // ⚠️ **失败只在这里判**（和"正文不是 JSON"分开，但结局一样）：
  //    微信成功时回 `{openid, session_key}`，失败时回 `{errcode, errmsg}`（40029 那些）。
  //    所以"有没有 openid"这一个判据同时盖住两件事：微信报错了、以及回了个看不懂的东西。
  if (typeof openid !== 'string' || openid.length === 0) throw fail()
  return openid
}

/**
 * openid → 一个**合规矩**的显示名：`微信用户_` + 后 6 位。
 *
 * ⚠️ 分隔符是**下划线**、不是空格 —— `checkUsername` 的字符类里没有空格
 *    （它只收中文/字母/数字/下划线/中点），用空格拼出来的名字连注册规矩都过不了，
 *    而那是我们**自己**拼的，用户没有任何办法解决。
 *
 * ⚠️ 那 6 位是从 openid 里**先滤出合法字符再取**的，不是直接 `slice(-6)`：
 *    openid 里出现一个过不了字符类的字符，拼出来的名字同样会让整个登录抛
 *    「只能用中文、字母…」—— 用户卡在一个自己没有任何办法解决的报错上。
 *    滤完取不出东西时退回 `user`。
 *
 * 名字只是**给人看的**：认人从头到尾靠 `wechat_openid`（`handleWxLogin` 里那段），
 * 所以这个名字多怪都不影响"还是不是同一个人"。也正因为它只是个展示名，
 * 撞名时**换一个**是对的（用户可以自己去改）。
 */
function wxSuffix(openid: string): string {
  const legal = openid.replace(/[^\p{Unified_Ideograph}〇a-z0-9_]/gu, '')
  return legal.slice(-6) || 'user'
}

/** 撞名重试时的尾巴。4 位十六进制 = 65536 种，重试 20 次还撞等于天塌了。 */
const wxTail = (): string => randomBytes(2).toString('hex')

/**
 * ★ 2026-10-12：**微信静默登录**（小程序那侧的身份）。
 *
 * 设计：docs/superpowers/specs/2026-10-12-miniprogram-outdoor-quick-edit-design.md §6.1。
 * 小程序的哲学是「开工前不问任何信息」：没有登录页、没有授权弹窗，
 * `wx.login()` 拿 code → 这张票就是那个人的全部身份（§6.2）。
 *
 * 三条纪律，和 `handleLogin` 是同一条：
 *   · **认人只认库里那一列** —— 请求里带的只有 code，openid 是我们自己去换的。
 *   · **上游的一切失败都是 UNAUTHORIZED**，且**不回显上游原文**
 *     （那句 URL 里躺着 AppSecret，见 `codeToOpenid`）。
 *   · **发票走 `issue()`** —— 小程序拿到的票和电脑版是**同一套**签名和寿命
 *     （§6.2 那句"以后小程序的一切都站在这套账号上"）。
 *
 * ⚠️ **`password_hash` 存随机 32 字节 hex 占位**，这不是偷懒：
 *    票是用「密码哈希」签的（`session.ts` 顶上那段），所以这一列必须有东西；
 *    同时它必须**不是任何真密码** —— 存随机 hex 等于把"这个身份走不了
 *    `/api/login`"做成一个**事实**而不是一句纪律：`verifyPassword` 只认
 *    `scrypt$…` 那种形状，拿到 hex 直接判"对不上"（单测里拿空密码/openid/
 *    用户名各撞了一遍）。
 *
 * ⚠️ 建号这里**没有事务**：中途失败（比如 email 撞了）会留下一行没被任何人
 *    引用的 users —— 它登不进来（没人知道它的密码），也占不了别人的坑。
 *    为它包一层事务要把 `openDb` 的迁移契约（迁移里不许自带事务控制语句）
 *    以外的数据库写法搬进来，代价大于收益（最简原则）。
 *
 * 建号规则（和 brief 一致，别自创）：名字 `微信用户_` + openid 后 6 位、
 * 邮箱 `wx-<openid>@wechat.local`（合成值，永不发信）。
 */
export async function handleWxLogin(body: unknown, deps: WxLoginDeps) {
  const o = asObject(body)
  const code = str(o.code).trim()
  if (!code) throw new HttpError('BAD_REQUEST', '缺少 code')

  const openid = await codeToOpenid(code, deps)

  // ── 找：这个微信号已经有账号了吗 ────────────────────────────────────────
  const found = deps.db.raw
    .prepare('SELECT id, username, email FROM users WHERE wechat_openid = ?')
    .get(openid) as PublicUser | undefined
  if (found) {
    // 老账号：直接发新票。哈希从**库里**取 —— 上面那个 SELECT 没带它，
    // 而且 PublicUser 本来就**不该**有它（那是要送出去的形状）。
    const h = (deps.db.raw.prepare('SELECT password_hash AS h FROM users WHERE id = ?')
      .get(found.id) as { h: string }).h
    return issue(found, h, deps)
  }

  // ── 建：带尾巴的名字重试，**唯一裁判是数据库** ─────────────────────────────
  // 不先 SELECT 一遍"这个名字有没有人用"：两个人同时抢一个名字时，两边都会
  // 查到"没人用"，然后一个成功一个炸在插入上 —— 而那个才是对的（和 handleSignup 同一套说法）。
  const base = `微信用户_${wxSuffix(openid)}`
  // 占位哈希**每建一个人算一次**：不共用一个常量，免得哪天有人把它当成
  // "所有微信用户共享的密码"。它永远验不过（见上面那段），随机只是多一层确定。
  const hash = randomBytes(32).toString('hex')
  const email = `wx-${openid}@wechat.local`

  let lastErr: unknown
  for (let i = 0; i < 20; i++) {
    const name = i === 0 ? base : `${base}_${wxTail()}`
    try {
      const r = deps.db.raw.prepare(
        'INSERT INTO users (username, email, password_hash, created_at, wechat_openid) VALUES (?, ?, ?, ?, ?)',
      ).run(name, email, hash, nowMs(deps), openid)
      // 回读一次而不是拿拼出来的 `name`：和 handleSignup 一样 —— 存进去的是什么，
      // 回来的就是什么，中间没有一层"我以为我存的是什么"。
      //
      // ⚠️ `lastInsertRowid` 是 **BigInt**（node:sqlite 就是这么回的），
      //    直接拿它当 id 的话有两个都不会报错的症状：`1n !== 1`（票查不出人），
      //    以及响应里 `JSON.stringify` 把它变成 `"1"` —— 字符串的 id。
      //    转成 Number 再进 PublicUser：它上面写的就是 `id: number`。
      const row = deps.db.raw
        .prepare('SELECT id, username, email FROM users WHERE id = ?')
        .get(Number(r.lastInsertRowid)) as PublicUser
      return issue(row, hash, deps)
    } catch (err) {
      lastErr = err
      const msg = String((err as Error).message)
      // 只认**名字**那一种撞车，换个尾巴重试。
      // ⚠️ 别的错误一律原样抛（认不出来的错误不是"你填得不对"）：
      //    邮箱撞了 = 库里有一条脏数据（这个合成邮箱只可能由这里写），
      //    openid 撞了 = 有人用别的身份占了这个号，两种都该进日志、不该被吞成"再试一次"。
      // ⚠️ 匹配串写 `users.username`（点）**不是** `users_wechat`：后者会撞上
      //    上面那条 openid 唯一索引的全名（`users_wechat_openid`）。
      if (!msg.includes('users.username')) throw err
      console.error(`微信建号撞名，换一个重试（第 ${i + 1} 次）：${name}`)
    }
  }
  // 20 次全撞 —— 不是"用户运气不好"，是这里出问题了，别伪装成登录失败
  throw lastErr
}

export async function handleChangePassword(body: unknown, user: PublicUser, deps: AccountDeps) {
  const o = asObject(body)
  const oldPw = str(o.oldPassword)
  const newPw = str(o.newPassword)

  // 旧哈希从**库里**取，不是从传进来的 user 上取：调用方拿到的 PublicUser 里
  // 本来也不该有哈希（那是要送出去的形状），这是 PublicUser/passwordHash 分开的理由。
  const row = deps.db.raw
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(user.id) as { password_hash: string } | undefined
  // 票是好使的、人却没了 —— 只在"刚被删号"那一个窗口里发生。
  // 当成"登录态不成立"，不是"这次请求有问题"。
  if (!row) throw new HttpError('BAD_REQUEST', '这个账号不在了')
  // 不验旧密码的话，谁捡到一张票（别人落下的手机、被复制走的 cookie）
  // 都能直接把号锁死 —— 把人关在门外比偷看更狠。
  if (!(await verifyPassword(oldPw, row.password_hash))) {
    throw new HttpError('BAD_REQUEST', '原来的密码不对')
  }

  // ⚠️ 和注册那处是**两个调用点**，各写各的参数，所以各要各的测试。
  const p = checkPassword(newPw, user.username)
  if (!p.ok) throw new HttpError('BAD_REQUEST', p.message)

  const hash = await hashPassword(p.value)
  deps.db.raw.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id)

  // ★ 写完之后**必须发一张新票**：上面那次 UPDATE 让**包括当前这台在内**的所有票
  // 全部失效了（签名里掺着哈希）。不给新票的话，用户改完密码就被自己踢出去了，
  // 而且他会以为"改密码这个功能坏了"。
  // 新票签的是**新哈希** —— 用旧哈希签出来的票同样验不过，等于没发。
  return issue(user, hash, deps)
}

/**
 * 改用户名（★ 2026-10-09）。
 *
 * 来路：用户说「就像有些功能对应的增删改查的操作的补充，不要再让我一再强调，
 * 比如用户名的修改功能」—— 账号能建、能看、能改密码、能注销，**唯独名字改不了**。
 *
 * ⚠️ 和 `handleChangePassword` 有三处**正好相反**，别照着它抄：
 *   ① **不发新票**。票的签名里掺的是 `password_hash` 和 userId，**没有用户名**
 *      （见 `session.ts` 的 `signSession`）—— 改名不动哈希，所以这张票照旧好使，
 *      别的设备也不会被踢。发一张新票是无害但多余的动作，而"多余"在这里会误导
 *      下一个人以为改名也要踢人。
 *   ② 签名里没有用户名，所以**登录限流那个 key（按名字记）也不受影响** ——
 *      改名之后用新名字登录会从零开始计数。这是可接受的（换个名字就是个新身份），
 *      但要**知道**这件事，别哪天看到"改名能把限流清零"当成 bug。
 *   ③ 读的是**新名字**、验的是**老哈希**（改密码那一趟反过来：读老密码、验老哈希）。
 *
 * ⚠️ 两条老规矩在这一趟**同样要守住**（守不住就是"规矩只在注册那一次成立"）：
 *   · **唯一** —— 交给数据库判（不先 SELECT 再 UPDATE：两个人同时抢一个名字，
 *     都查到"没人用"，然后一个成功一个炸在写入上，**而那个才是对的**。
 *     和 `handleSignup` 同一套说法）。
 *   · **密码不能和名字一样** —— 见下面那段。
 */
export async function handleChangeUsername(
  body: unknown, user: PublicUser, deps: AccountDeps,
): Promise<PublicUser> {
  const o = asObject(body)
  // 用的是 `checkUsername`（注册那一套：长度、字符类、保留名、归一化）——
  // 改名走的就是"这个名字能不能拿来当账号"，和注册问的是**同一个问题**。
  // （登录问的是另一个问题，所以那一处用的是 `normalizeUsername` —— 见它的注释。）
  const u = checkUsername(str(o.username))
  if (!u.ok) throw new HttpError('BAD_REQUEST', u.message)

  const row = deps.db.raw
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(user.id) as { password_hash: string } | undefined
  if (!row) throw new HttpError('BAD_REQUEST', '这个账号不在了')

  // ★ 「密码不能和名字一样」这条规矩，注册和改密码那两处各写了一遍
  //   （各传各的参数），**改名是第三个能改动名字的地方** —— 不在这儿也守一道，
  //   这条规矩就变成了"只在你注册那一刻成立"，用户改个名就绕过去了。
  //   注册那处的注释写着它"唯一的落地处"是 `checkPassword` 的第二个参数；
  //   这里没有明文密码可比，只能拿**新名字**去撞那把哈希（`verifyPassword`
  //   正是干这个的：拿一个明文和一个哈希对）。
  //
  //   ⚠️ **已知边界**：注册那处的比较是**折过大小写**的（密码折小写再比名字），
  //      而这里只比得出**一模一样**那一种 —— 哈希是单向的，我没法把密码折成小写。
  //      所以"密码是 XiaoMing、名字改成 xiaoming"这一种**盖不住**。
  //      要盖住它就得存明文密码，那是拿一个真窟窿去补一个假窟窿，不做。
  //      这一条写在 `server/account.test.ts` 的用例名里，别当成漏了。
  if (await verifyPassword(u.value, row.password_hash)) {
    throw new HttpError('BAD_REQUEST', '名字不能和密码一样')
  }

  try {
    deps.db.raw.prepare('UPDATE users SET username = ? WHERE id = ?').run(u.value, user.id)
  } catch (err) {
    // 和注册那处同一套翻译：唯一约束是**数据库**在管，这里只把它的报错说成人话。
    // ⚠️ 措辞和 `checkUsername` 里那句「留给官方账号的」**不一样，也别统一** ——
    //    「有人用了」在"真的撞了唯一约束"这个场景下是准确的（那段注释在
    //    `shared/account.ts`，2026-09-25 用户读错过一次，两条别混）。
    const msg = String((err as Error).message)
    if (msg.includes('users.username')) throw new HttpError('BAD_REQUEST', '这个名字有人用了，换一个吧')
    throw err
  }

  // 回给前端的是**改完之后**的那份 —— 调用方拿它更新屏幕上那一行，
  // 别让页面继续写着旧名字（那正是"改了没反应"的样子）。
  return { id: user.id, username: u.value, email: user.email }
}

/**
 * 注销账号（spec §5；表里那行是「注销账号 | 作品全删（记录 + 文件）+ 用量记录全删」）。
 *
 * ⚠️ **顺序：先删记录、再删文件。** 反过来（先删文件）中途炸掉，留下的是
 *    "记录指向一张不存在的图" —— 那种坏比"盘上多几个没人认领的文件"贵得多：
 *    用户点开是坏图，而且没有任何线索说明为什么。
 *
 * ⚠️ 会话和模型配置随 `users` 行**级联删**（那两张表写了 ON DELETE CASCADE），
 *    但 **`works` 没写级联** —— 所以它必须手动先删，别以为删用户就都带走了。
 *
 * ⚠️ **滤镜（luts）是第三种**（2026-10-05）：行写了级联、会自己走，
 *    但盘上那些 `.cube` 文件不会 —— 所以下面第三批名字要手动收
 *    （和会话的 `files` 名单同一条规矩：记录删了，文件不能留在盘上没人认领）。
 *
 * ⚠️ 调用方（app.ts 那条路由）负责把 cookie 清掉 —— 这里只管数据。
 */
export async function handleDeleteAccount(
  user: PublicUser, deps: { db: Db; storage: Storage },
): Promise<{ ok: true }> {
  const works = deps.db.raw
    .prepare('SELECT stored_name, thumb_name FROM works WHERE user_id = ?')
    .all(user.id) as { stored_name: string; thumb_name: string | null }[]
  const sessions = deps.db.raw
    .prepare('SELECT files FROM sessions WHERE user_id = ?')
    .all(user.id) as { files: string }[]
  // ★ 2026-10-05：滤镜文件跟着走（行随 `ON DELETE CASCADE`，文件得自己收）
  const luts = deps.db.raw
    .prepare('SELECT stored_name FROM luts WHERE user_id = ?')
    .all(user.id) as { stored_name: string }[]

  const names = [
    ...works.flatMap((w) => [w.stored_name, w.thumb_name]),
    ...sessions.flatMap((s) => JSON.parse(s.files) as string[]),
    ...luts.map((l) => l.stored_name),
  ].filter((n): n is string => typeof n === 'string' && n.length > 0)

  deps.db.raw.prepare('DELETE FROM works WHERE user_id = ?').run(user.id)
  deps.db.raw.prepare('DELETE FROM users WHERE id = ?').run(user.id)

  // 到这儿号已经没了 —— 这一步失败只会留下没人认领的文件。记一笔，**不能静默**。
  let failed = 0
  for (const n of names) {
    await deps.storage.remove(n).catch(() => { failed++ })
  }
  if (failed > 0) console.error(`注销：${failed} 个文件没删掉（记录已清，成了孤儿）`)
  return { ok: true }
}
