import type { Db } from './db.ts'
import { hashPassword, verifyPassword } from './password.ts'
import { normalizeUsername, checkUsername, checkEmail, checkPassword } from '../shared/account.ts'
import {
  signSession, verifySession, sessionExpiry, parseCookies, SESSION_COOKIE,
} from './session.ts'
import { HttpError, asObject, str } from './http.ts'

export type PublicUser = { id: number; username: string; email: string }
export type AccountDeps = { db: Db; secret: string; now?: () => number }

type Row = { id: number; username: string; email: string; password_hash: string }

/** 时间从 deps 里取，测试才能把"30 天后过期"钉死，不随真实日期漂。 */
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
  // ⚠️ 「查不到这个人」和「签名不过」必须是**同一个结局**（null = 没登录）。
  // 分开处理等于给了攻击者一个信号：哪张票的 userId 是真的、只是签名不对。
  if (!row) return null

  const s = verifySession(token, row.password_hash, now(deps), deps.secret)
  if (!s) return null

  // 哈希是**从库里查出来的**，不是请求里带来的 —— 上面那句 verifySession 用的也是它。
  // 拿请求里的哈希来验签等于自己造了一把钥匙，谁都能签出任意 userId 的票。
  return { id: row.id, username: row.username, email: row.email, passwordHash: row.password_hash }
}

/** 发一张票。三处成功路径（注册/登录/改密码）共用，免得漏掉某个字段。 */
function issue(user: PublicUser, passwordHash: string, deps: AccountDeps) {
  const expiresAt = sessionExpiry(now(deps))
  return { user, token: signSession(user.id, passwordHash, expiresAt, deps.secret), expiresAt }
}

export function handleSignup(body: unknown, deps: AccountDeps) {
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
  const hash = hashPassword(p.value)
  try {
    deps.db.raw
      .prepare('INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(u.value, e.value, hash, now(deps))
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

export function handleLogin(body: unknown, deps: AccountDeps) {
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
  //     · 查无此人（**也包括名字格式不对** —— 见下面那段）→「没有这个账号」
  //     · 密码不对                                          →「密码不对，再试一次」
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
  const NO_SUCH = () => new HttpError('BAD_REQUEST', '没有这个账号')

  const row = deps.db.raw
    .prepare('SELECT id, username, email, password_hash FROM users WHERE username = ?')
    .get(name) as Row | undefined
  if (!row) throw NO_SUCH()
  if (!verifyPassword(rawPw, row.password_hash)) {
    throw new HttpError('BAD_REQUEST', '密码不对，再试一次')
  }

  return issue({ id: row.id, username: row.username, email: row.email }, row.password_hash, deps)
}

export function handleChangePassword(body: unknown, user: PublicUser, deps: AccountDeps) {
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
  if (!verifyPassword(oldPw, row.password_hash)) {
    throw new HttpError('BAD_REQUEST', '原来的密码不对')
  }

  // ⚠️ 和注册那处是**两个调用点**，各写各的参数，所以各要各的测试。
  const p = checkPassword(newPw, user.username)
  if (!p.ok) throw new HttpError('BAD_REQUEST', p.message)

  const hash = hashPassword(p.value)
  deps.db.raw.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id)

  // ★ 写完之后**必须发一张新票**：上面那次 UPDATE 让**包括当前这台在内**的所有票
  // 全部失效了（签名里掺着哈希）。不给新票的话，用户改完密码就被自己踢出去了，
  // 而且他会以为"改密码这个功能坏了"。
  // 新票签的是**新哈希** —— 用旧哈希签出来的票同样验不过，等于没发。
  return issue(user, hash, deps)
}
