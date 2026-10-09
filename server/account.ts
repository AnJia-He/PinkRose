import type { Db } from './db.ts'
import { nowMs } from './clock.ts'
import type { Storage } from './storage.ts'
import { hashPassword, verifyPassword } from './password.ts'
import { normalizeUsername, checkUsername, checkEmail, checkPassword } from '../shared/account.ts'
import {
  signSession, verifySession, sessionExpiry, parseCookies, SESSION_COOKIE,
} from './session.ts'
import { HttpError, asObject, str } from './http.ts'

export type PublicUser = { id: number; username: string; email: string }
export type AccountDeps = { db: Db; secret: string; now?: () => number }

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
