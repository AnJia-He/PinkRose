import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from './db.ts'
import { createStorage, type Storage } from './storage.ts'
import {
  handleDeleteAccount, handleSignup, handleLogin, handleChangePassword, handleChangeUsername,
  handleWxLogin, findUserByCookie, type AccountDeps,
} from './account.ts'
import { createLut } from './luts.ts'
import { SESSION_COOKIE } from './session.ts'
import { HttpError } from './http.ts'

/**
 * 这一份测的是**调用点**，不是规则本身。
 *
 * 规则（名字/邮箱/密码长什么样）在 `shared/account.test.ts` 里一条条钉着；
 * 这里回答的是另一类问题：**把它们接起来之后，规矩还成不成立**。
 * 两者不重叠 —— 最典型的是「密码不能和名字一样」：那条规则能不能生效，
 * 取决于调用方**有没有把名字传进去**，而函数自己对此无能为力（见文件末尾那组）。
 */

let db: Db
let deps: AccountDeps
// 时间钉死。会话是"30 天后过期"，用真实时钟等于让测试的成败跟着日期漂。
let clock = 1_700_000_000_000

beforeEach(() => {
  db = openDb(':memory:')
  clock = 1_700_000_000_000
  deps = { db, secret: 'test-secret', now: () => clock }
})

const GOOD = { username: '小明', email: 'a@b.com', password: 'goodpassword' }

describe('注册', () => {
  it('能注册，回的是用户名（小写）而不是密码', async () => {
    const r = await handleSignup(GOOD, deps)
    expect(r.user.username).toBe('小明')
    expect(r.user.email).toBe('a@b.com')
    expect(JSON.stringify(r)).not.toContain('goodpassword')
  })

  it('★ 数据库里存的是哈希，不是明文', async () => {
    await handleSignup(GOOD, deps)
    const row = db.raw.prepare('SELECT password_hash AS h FROM users WHERE username = ?')
      .get('小明') as { h: string }
    expect(row.h).not.toBe('goodpassword')
    expect(row.h.startsWith('scrypt$')).toBe(true)
  })

  it('同一个名字注册第二次被拒 —— 靠数据库唯一约束', async () => {
    await handleSignup(GOOD, deps)
    await expect(handleSignup({ ...GOOD, email: 'other@b.com' }, deps)).rejects.toThrow(/名字/)
  })

  it('同一个邮箱注册第二次被拒', async () => {
    await handleSignup(GOOD, deps)
    await expect(handleSignup({ ...GOOD, username: '小红' }, deps)).rejects.toThrow(/邮箱/)
  })

  it('格式不对的当场拒，且说得出为什么', async () => {
    await expect(handleSignup({ ...GOOD, username: '!' }, deps)).rejects.toThrow()
    await expect(handleSignup({ ...GOOD, email: 'nope' }, deps)).rejects.toThrow()
    await expect(handleSignup({ ...GOOD, password: '123' }, deps)).rejects.toThrow()
  })

  it('body 不是对象也不炸', async () => {
    // 请求体是从网上来的：`JSON.parse('42')`、`'null'`、`'[]'` 都是合法 JSON。
    // 它们只该变成"这次请求有问题"，不该变成 500（那等于把自己的堆栈送出去）。
    for (const bad of [null, undefined, 42, 'x', []]) {
      await expect(handleSignup(bad, deps)).rejects.toThrow()
    }
  })
})

describe('登录', () => {
  it('密码对就能登进来', async () => {
    await handleSignup(GOOD, deps)
    const r = await handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    expect(r.user.username).toBe('小明')
  })

  it('大小写不敏感 —— 用 小明 注册能用 XIAO... 随便什么大小写登', async () => {
    await handleSignup({ ...GOOD, username: 'Alice' }, deps)
    expect((await handleLogin({ username: 'ALICE', password: 'goodpassword' }, deps)).user.username).toBe('alice')
  })

  // ── 2026-09-25 用户拍板：两种错**分开说**。原来是三种情况共用一句
  //    「用户名或密码不对」，理由是"区分了就等于告诉别人哪些用户名是真的"。
  //    那条理由现在站不住了：**注册接口本来就会告诉你某个名字有没有人用**
  //    （下面「同一个名字注册第二次被拒」那条测的就是它），谁都能拿一张名字表
  //    把存在性筛一遍 —— 登录接口捂着它不换来任何防护，只换来一句用户看不懂、
  //    照着走不下去的话。完整论证在 `server/account.ts` 的 handleLogin 里。
  //
  //    这条改动**代价明确**：登录接口从此是一个"存在性查询接口"了。之所以接受，
  //    是因为那个能力**早就**由注册接口免费提供着（见上）—— 不是这里新开的口子。

  it('★ 查无此人 → 「没有这个账号，去注册一个吧」', async () => {
    // 变异：把 handleLogin 里那两处 throw 合并回一句（原来那个 `WRONG`）→
    //      这一条和下面那条**一起红**（两条各要自己那句话，合并了必然有一条对不上）。
    // 变异②：把「，去注册一个吧」删掉（退回只有诊断、没有出路的那半句）→ 这两条红。
    //      **这句话是用户直接看到的那一句**（前端原样显示），所以它得自己说清下一步；
    //      `src/App.test.tsx` 里那颗「还没有账号？注册一个」按钮还在，那是**用户要的
    //      重复**，不是可以拿来少说半句的理由。
    await handleSignup(GOOD, deps)
    await expect(handleLogin({ username: '查无此人', password: 'goodpassword' }, deps)).rejects.toThrow('没有这个账号，去注册一个吧')
  })

  it('★ 名字不合注册规矩也走同一句 —— 登录这条路不再拿 checkUsername 去筛名字', async () => {
    // 钉的是"登录这条路不跑注册那套规矩"的**服务端那一半**。
    // `a-b` 过不了字符类、`!` 过不了长度下限 —— 它们在库里**必然不存在**，
    // 所以「没有这个账号」那一句对它们是**真的**。而"格式不对"那几句话一旦出现在
    // 登录页上就是答非所问（用户已经有号了，改名字对他没用），
    // 顺带还会把"是哪条格式规矩拦的"漏成一个筛子。
    //
    // 变异：把 handleLogin 里的 `normalizeUsername` 换回 `checkUsername`
    //      （并像原来那样在格式不对时先抛）→ 这一条红（拿到的是「只能用中文、字母…」）。
    await handleSignup(GOOD, deps)
    for (const bad of ['a-b', '!', 'a b']) {
      await expect(handleLogin({ username: bad, password: 'goodpassword' }, deps)).rejects.toThrow('没有这个账号，去注册一个吧')
    }
  })

  it('★ 密码不对 → 「密码不对，再试一次」', async () => {
    // 和上面那条是**两个方向**：这个人知道名字是对的（号就是他注册的），
    // 他要回答的是"要不要接着试密码"。原来那句「用户名或密码不对」把他也推去
    // 怀疑自己的名字，而下一步该做什么没人告诉他。
    //
    // 变异：把这一处也改回「用户名或密码不对」→ 这一条红。
    await handleSignup(GOOD, deps)
    await expect(handleLogin({ username: '小明', password: 'wrongpassword' }, deps)).rejects.toThrow('密码不对，再试一次')
  })
})

describe('会话', () => {
  it('拿登录发的票能查出人来', async () => {
    await handleSignup(GOOD, deps)
    const { token } = await handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    const u = findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)
    expect(u?.username).toBe('小明')
  })

  it('没有 cookie 就是 null', async () => {
    expect(findUserByCookie(undefined, deps)).toBeNull()
    expect(findUserByCookie('', deps)).toBeNull()
    expect(findUserByCookie('other=1', deps)).toBeNull()
  })

  it('垃圾票就是 null，不抛', async () => {
    // 票是从网上来的，形状随便什么都有可能。验不过只该让人变成"没登录"，
    // 不该让接口 500 —— 这也是「查不到用户」和「签名不过」必须**同一种结局**的地方。
    expect(findUserByCookie(`${SESSION_COOKIE}=garbage`, deps)).toBeNull()
  })

  it('★ 票的形状全合法，只有签名是假的 —— 一样查不出人', async () => {
    // ⚠️ 这条不是上面那条的重复，是它的补丁：`garbage` 连"三段、是数字、没过期"
    // 都过不了，**走不到验签那一步**，所以"签名到底有没有被用上"它一句也没问。
    // 而"照着别人的 ID 自己造一张票"正是这套方案唯一要挡的东西 ——
    // 第一步解析出的 userId 是**不可信**的（见 findUserByCookie 的注释），
    // 唯一让它变可信的就是这里。少了这条，把验签结果丢掉也全绿。
    await handleSignup(GOOD, deps)
    const { token, user } = await handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    const [, exp, sig] = token.split('.') as [string, string, string]
    const flip = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')
    for (const forged of [
      `${user.id}.${exp}.${flip}`,          // 真 ID、真过期时间，签名改一个字符
      `${user.id}.${exp}.${'A'.repeat(43)}`, // 真 ID、真过期时间，签名自己编一个
    ]) {
      expect(findUserByCookie(`${SESSION_COOKIE}=${forged}`, deps)).toBeNull()
    }
  })

  it('用户被删了之后，票也查不出人', async () => {
    // 票里写的是 userId 和过期时间，人没了就是没人 —— 不是"还能进，只是名字空着"。
    await handleSignup(GOOD, deps)
    const { token } = await handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    db.raw.prepare('DELETE FROM users').run()
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)).toBeNull()
  })

  it('★ 票过期之后就查不出人了', async () => {
    // ⚠️ 上面几条的票**全是新鲜的** —— `clock` 钉死在某一个时刻，从头到尾没拨动过。
    // 于是"过期"这件事一条都没问过，而 30 天这条线是设计给的硬承诺。
    // 唯一执行它的地方，就是 findUserByCookie 转交给 verifySession 的"现在是几点"：
    // 把它写死成 0，票就**永不过期**，而上面 21 条照样全绿（审查实测）。
    //
    // 这和 Task 2 修掉的那条是**同一个形状** —— 一行没人测的守卫，管的是一个
    // 安全性质：那次是"任意密码能登录空哈希记录"，这次是"过期票永久有效"。
    // 守卫没人守着，就等于没有：它会安安静静地被改坏，而测试全绿。
    await handleSignup(GOOD, deps)
    const { token } = await handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    // 同一个 deps、同一张票，只把"现在"拨过 30 天那条线。
    clock += 30 * 86400_000 + 1
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)).toBeNull()
  })
})

describe('改密码', () => {
  it('改完能用新密码登', async () => {
    await handleSignup(GOOD, deps)
    const user = (await handleLogin({ username: '小明', password: 'goodpassword' }, deps)).user
    await handleChangePassword({ oldPassword: 'goodpassword', newPassword: 'brandnewpw' }, user, deps)
    expect((await handleLogin({ username: '小明', password: 'brandnewpw' }, deps)).user.id).toBe(user.id)
  })

  it('旧密码错了就拒', async () => {
    // 少了这一句，谁捡到一张票（哪怕是别人落下的手机）都能直接把号锁死。
    await handleSignup(GOOD, deps)
    const user = (await handleLogin({ username: '小明', password: 'goodpassword' }, deps)).user
    await expect(handleChangePassword({ oldPassword: 'nope-nope', newPassword: 'brandnewpw' }, user, deps)).rejects.toThrow()
  })

  it('新密码不合规就拒', async () => {
    await handleSignup(GOOD, deps)
    const user = (await handleLogin({ username: '小明', password: 'goodpassword' }, deps)).user
    await expect(handleChangePassword({ oldPassword: 'goodpassword', newPassword: '123' }, user, deps)).rejects.toThrow()
  })

  it('★★ 改完密码，旧票立刻失效 —— 这就是"所有设备下线"', async () => {
    await handleSignup(GOOD, deps)
    const { token } = await handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    const user = (await handleLogin({ username: '小明', password: 'goodpassword' }, deps)).user
    // 改之前：票是好的
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)).not.toBeNull()
    await handleChangePassword({ oldPassword: 'goodpassword', newPassword: 'brandnewpw' }, user, deps)
    // 改之后：同一张票查不出人了
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)).toBeNull()
  })

  it('改完返回一张新票，用它可以继续用', async () => {
    // 上面那次 UPDATE 让**包括当前这台在内**的所有票一起失效了（签名掺着哈希）。
    // 所以这里必须发一张新的 —— 不发的话，用户改完密码就把自己踢出去了，
    // 而他会以为"改密码这个功能坏了"。新票的哈希是**改完之后**那个，才验得过。
    await handleSignup(GOOD, deps)
    const user = (await handleLogin({ username: '小明', password: 'goodpassword' }, deps)).user
    const { token } = await handleChangePassword({ oldPassword: 'goodpassword', newPassword: 'brandnewpw' }, user, deps)
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)?.id).toBe(user.id)
  })
})

/**
 * ★ 2026-10-09：**改用户名**。
 *
 * 来路：用户说「像有些功能对应的增删改查的操作的补充就不要再让我一再强调了，
 * 比如用户名的修改功能」—— 账号能建、能看、能改密码、能注销，名字却只能看。
 */
describe('改用户名', () => {
  it('改完：新名字能登、旧名字登不上了', async () => {
    await handleSignup(GOOD, deps)
    const user = (await handleLogin({ username: '小明', password: 'goodpassword' }, deps)).user
    const next = await handleChangeUsername({ username: '阿宝' }, user, deps)
    expect(next.username).toBe('阿宝')
    expect((await handleLogin({ username: '阿宝', password: 'goodpassword' }, deps)).user.id).toBe(user.id)
    await expect(handleLogin({ username: '小明', password: 'goodpassword' }, deps)).rejects.toThrow()
  })

  it('★★ 改完名字，**同一张票照旧好使** —— 和改密码那一趟正相反', async () => {
    // 票的签名里掺的是**密码哈希**和 userId，没有用户名（`session.ts`）。
    // 这条用例钉的就是"改名不踢人"：`/api/username` 那条路由**故意不发新票**。
    // 变异：照着 `/api/password` 抄一份、或者顺手 `issue()` 一张新的 ——
    //       行为上仍然是对的（新票也好使），所以**不会有别的东西红**；
    //       但"改名要把人踢下线"这个印象会传下去（界面上那句"其他设备要重新登录"
    //       就是照着这个印象写的，而它是假话）。这一条守的是**那句真话**。
    await handleSignup(GOOD, deps)
    const { token } = await handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    const user = (await handleLogin({ username: '小明', password: 'goodpassword' }, deps)).user
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)).not.toBeNull()
    await handleChangeUsername({ username: '阿宝' }, user, deps)
    // 票还是那张票，人还是那个人 —— 只是名字变了
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)?.username).toBe('阿宝')
  })

  it('名字被别人占了就拒（唯一约束由**数据库**判）', async () => {
    await handleSignup(GOOD, deps)
    await handleSignup({ username: '阿宝', email: 'b@b.com', password: 'goodpassword' }, deps)
    const user = (await handleLogin({ username: '小明', password: 'goodpassword' }, deps)).user
    await expect(handleChangeUsername({ username: '阿宝' }, user, deps))
      .rejects.toThrow('这个名字有人用了，换一个吧')
  })

  it('名字不合规就拒（走的是**注册那一套**规则，不是登录那套归一化）', async () => {
    await handleSignup(GOOD, deps)
    const user = (await handleLogin({ username: '小明', password: 'goodpassword' }, deps)).user
    // 太短 / 保留名 —— 两条都在 `checkUsername` 里，改名必须和注册问同一个问题
    await expect(handleChangeUsername({ username: 'a' }, user, deps)).rejects.toThrow()
    await expect(handleChangeUsername({ username: 'admin' }, user, deps)).rejects.toThrow()
  })
})

describe('★ 密码不能和名字一样 —— 在**调用点**上真的生效', () => {
  /**
   * 为什么这组必须存在（而且必须走**完整路径**、不是直接调 `checkPassword`）：
   *
   * `checkPassword(raw, username?)` 的名字参数是**可选**的 —— 这没错，
   * 前端要"边打边提示"，那时候用户还没填名字。代价是：**调用方忘了传，
   * 规则就静默失效**（不报错、不红、看起来一切正常）。签名治不了这个 ——
   * 把参数改成必填，挡掉的正是前端那个合理用法。
   * 所以治"忘传"的唯一位置是**调用点**，也就是下面两条。
   *
   * `shared/account.test.ts` 里那几条只钉住了函数本身 —— 把 `handleSignup`
   * 里的 `u.value` 换成不传，那边一条都不会红。
   */
  it('注册时：密码 == 用户名的折叠形式 → 拒', async () => {
    // ⚠️ 名字压到 8 位以上（密码的下限）**不是为了好看**：短名字会让输入先栽在
    // "密码至少 8 位"那条上，测试就变成一条**看起来在验这条规则、其实什么都没验**
    // 的假绿 —— 这个项目已经被这种测试咬过。
    // 断言写成整句而不是 `/名字/`：换个不合规的名字同样会抛，而那抛的不是这条规则。
    const expectRejected = async (body: unknown) =>
      await expect(handleSignup(body, deps)).rejects.toThrow('密码不能和名字一样')

    // ① 一模一样
    await expectRejected({ username: 'abcdefgh', email: 'a@b.com', password: 'abcdefgh' })
    // ② 只差大小写 —— 库里存的必然是小写，而密码是用户原样敲的，折算在比较那侧做
    expectRejected({ username: 'Abcdefgh', email: 'b@b.com', password: 'ABCDEFGH' })
    // ③ 中点的两种写法看着一模一样（U+00B7 vs U+30FB），不折就等于没这条规则
    expectRejected({ username: '尼格买提·热合曼', email: 'c@b.com', password: '尼格买提・热合曼' })
  })

  it('改密码时也一样 —— 同一个规则在第二个调用点上也生效', async () => {
    // 和注册是两个不同的调用点，各写各的 username 参数，所以各验各的。
    // 改密码这条尤其要紧：它是**随手就能重设**的那一条，
    // 要是能设成和名字一样，等于把"别人看一眼就知道"的密码合法化了。
    await handleSignup({ username: 'abcdefgh', email: 'a@b.com', password: 'goodpassword' }, deps)
    const user = (await handleLogin({ username: 'abcdefgh', password: 'goodpassword' }, deps)).user
    await expect(
      handleChangePassword({ oldPassword: 'goodpassword', newPassword: 'ABCDEFGH' }, user, deps),
    ).rejects.toThrow('密码不能和名字一样')
  })

  it('改用户名时也一样 —— 同一个规则在**第三个**调用点上也生效', async () => {
    // ★ 2026-10-09 加的。这一条尤其要紧，因为它是**最容易被漏掉的那个调用点**：
    //   注册那处能拿明文密码直接比（还折大小写），而改名这一趟手里**只有哈希**，
    //   所以比法不一样（拿新名字去撞哈希，见 `handleChangeUsername`）。
    //   不在这儿守一道的话，这条规矩就变成"只在你注册那一刻成立" ——
    //   用户改个名就绕过去了，而且**一句错都不报**。
    //
    // ⚠️ **已知边界，别当成漏了**：这里只比得出"一模一样"那一种。
    //   注册那处是折过大小写的（`密码折小写 == 名字`），而哈希是单向的 ——
    //   我没法把用户存的密码折成小写。所以"密码是 ABCDEFGH、名字改成 abcdefgh"
    //   这一种**盖不住**。要盖住它得存明文密码，那是拿真窟窿补假窟窿，不做。
    await handleSignup({ username: 'abcdefgh', email: 'a@b.com', password: 'goodpassword' }, deps)
    const user = (await handleLogin({ username: 'abcdefgh', password: 'goodpassword' }, deps)).user
    await expect(handleChangeUsername({ username: 'goodpassword' }, user, deps))
      .rejects.toThrow('名字不能和密码一样')
  })
})

/**
 * ★ 2026-10-12：**微信静默登录**（小程序那侧的身份）。
 *
 * 设计：`docs/superpowers/specs/2026-10-12-miniprogram-outdoor-quick-edit-design.md` §6.1。
 * 小程序的哲学是「开工前不问任何信息」—— 所以它拿到身份的路只有一条：
 * `wx.login()` 拿一个 code → 我们拿 code 去微信换 openid → 找/建账号 → 发**同一套**票。
 *
 * ⚠️ 这一组**不真打微信**：`fetchImpl` 是注入的（照 `probeConnection` 的写法）。
 *    真连那一步挂在 Task 10 的 Step 5（要 AppSecret），不在这份测试里。
 */
describe('微信静默登录', () => {
  /** 假微信：记下每次请求的 URL，回一个像 `jscode2session` 的正文。 */
  function wxStub(body: unknown, status = 200) {
    const urls: string[] = []
    const fetchImpl = (async (url: any) => {
      urls.push(String(url))
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    return { urls, fetchImpl }
  }

  /**
   * ⚠️ 微信那把 key **不许叫 `secret`**：`AccountDeps.secret` 是**签会话票的那把**
   * （`deps` 里那个 `'test-secret'`）。写成 `{ ...deps, secret: wxKey }` 会把签名钥匙
   * 悄悄顶掉，而症状是**票照样发得出来、就是查不出人** —— 第一次就踩了。
   * 所以这里给它自己的名字，和 app.ts 那边（`appid: wx.appid, secret: wx.secret`）
   * 是同一条纪律：**两把钥匙不许同名**。
   */
  const wxDeps = (fetchImpl: typeof fetch) =>
    ({ ...deps, fetchImpl, appid: 'wx-test-appid', wxSecret: 'wx-test-appsecret' })

  it('拿 code 换 openid → 建号 + 发票 + `wechat_openid` 落库', async () => {
    const { urls, fetchImpl } = wxStub({ openid: 'oX1abcdef', session_key: 'sk' })
    const r = await handleWxLogin({ code: 'the-code' }, wxDeps(fetchImpl))

    // ① 发的是**真** jscode2session：appid / secret / code 都得在，grant_type 得对
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('sns/jscode2session')
    expect(urls[0]).toContain('appid=wx-test-appid')
    expect(urls[0]).toContain('js_code=the-code')
    expect(urls[0]).toContain('grant_type=authorization_code')
    expect(urls[0]).toContain('secret=wx-test-appsecret')

    // ② 账号：名字带 openid 后 6 位、邮箱是合成值（永不发信）
    expect(r.user.username).toBe('微信用户_abcdef')
    expect(r.user.email).toBe('wx-oX1abcdef@wechat.local')

    // ③ openid 真的落库了（这一段靠的就是这一列）
    const row = db.raw.prepare('SELECT wechat_openid AS o FROM users WHERE id = ?')
      .get(r.user.id) as { o: string | null }
    expect(row.o).toBe('oX1abcdef')

    // ④ 票是**和电脑版同一套**的 —— 能过 findUserByCookie，不是另一种形状
    //    （用的也是普通 `deps`：签票那把钥匙从头到尾只有一把）
    expect(findUserByCookie(`${SESSION_COOKIE}=${r.token}`, deps)?.id).toBe(r.user.id)
  })

  it('★ 同一个 openid 再来一次 → 还是**同一个账号**，不建第二个', async () => {
    const a = await handleWxLogin({ code: 'c1' }, wxDeps(wxStub({ openid: 'oX1same' }).fetchImpl))
    const b = await handleWxLogin({ code: 'c2' }, wxDeps(wxStub({ openid: 'oX1same' }).fetchImpl))

    expect(b.user.id).toBe(a.user.id)
    // 也不许顺手再建一行出来（"复用"和"建号前先查一下"是两件事）
    const n = (db.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
    expect(n).toBe(1)
  })

  it('★ 微信报错（errcode 非 0）→ UNAUTHORIZED，且**不回显上游原文**', async () => {
    // 真实的 40029 正文里带着 session_key 那种东西 —— 一个字都不许漏出去
    const { fetchImpl } = wxStub({ errcode: 40029, errmsg: 'SENTINEL-WX-UPSTREAM-40029' })
    const p = handleWxLogin({ code: 'bad' }, wxDeps(fetchImpl))
    await expect(p).rejects.toThrow(HttpError)
    await expect(p).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 })
    await expect(p).rejects.not.toThrow(/SENTINEL-WX-UPSTREAM/)
  })

  it('★ 连不上微信 / 上游 5xx / 正文不是 JSON —— 一律 UNAUTHORIZED，不 500', async () => {
    // 这几条的共同点：**都是别人的问题**，而用户看到的必须是我们自己的话
    // （和 findUserByCookie "任何不对都返回 null，绝不抛" 是同一条纪律）。
    const boom = (async () => { throw new Error('SENTINEL-WX-NET') }) as unknown as typeof fetch
    const cases: (typeof fetch)[] = [
      boom,
      wxStub({ errcode: 0, errmsg: 'SENTINEL-WX-5XX' }, 500).fetchImpl,
      wxStub('SENTINEL-WX-NOTJSON').fetchImpl,
      wxStub({ errmsg: 'SENTINEL-WX-NOOPENID' }).fetchImpl,   // 200 但没给 openid
    ]
    for (const fetchImpl of cases) {
      await expect(handleWxLogin({ code: 'c' }, wxDeps(fetchImpl)))
        .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    }
  })

  it('★ openid 后 6 位撞名 → 换一个名字**重试**（数据库才是裁判），不报错', async () => {
    // 撞名的对手由测试**亲手**摆进去：不带尾巴的名字 = 微信用户_ + 6 位
    await handleSignup(
      { username: '微信用户_abcdef', email: 'abc@b.com', password: 'goodpassword' }, deps)
    const { fetchImpl } = wxStub({ openid: 'oX1abcdef' })
    const r = await handleWxLogin({ code: 'c' }, wxDeps(fetchImpl))

    expect(r.user.username).not.toBe('微信用户_abcdef')
    expect(r.user.username.startsWith('微信用户')).toBe(true)
    // 原来那个账号**一个字节都没动**（重试是"换个名字再插一次"，不是"抢名字"）
    const kept = db.raw.prepare('SELECT email FROM users WHERE username = ?')
      .get('微信用户_abcdef') as { email: string }
    expect(kept.email).toBe('abc@b.com')
  })

  it('★ 后 6 位里混进怪字符也不会拼出非法名字（后 6 位取自合法字符）', async () => {
    // openid 是微信给的，但"给的一定是 URL 安全字符"这件事**没有契约保证** ——
    // 拼进来的名字过不了 `checkUsername` 的话，用户会卡在一个没有出口的报错上。
    const { fetchImpl } = wxStub({ openid: 'oX1-!!中文' })
    const r = await handleWxLogin({ code: 'c' }, wxDeps(fetchImpl))
    expect(r.user.username.startsWith('微信用户')).toBe(true)
    // 合法字符滤完还剩 `中文`（openid 尾部那两个字）—— 名字得是能过规矩的那种
    expect(/^微信用户_[\p{Unified_Ideograph}〇a-z0-9_·]+$/u.test(r.user.username)).toBe(true)
  })

  it('★ 微信用户的 `password_hash` 是随机占位 —— 这个身份**不许**走 /api/login', async () => {
    // 票是用密码哈希签的（session.ts），所以这一列必须有东西；但它同时必须
    // **不是一个真密码**：拿空密码、拿 openid、拿用户名去登，一次都不许成功。
    const { fetchImpl } = wxStub({ openid: 'oX1abcdef' })
    const r = await handleWxLogin({ code: 'c' }, wxDeps(fetchImpl))
    const h = (db.raw.prepare('SELECT password_hash AS h FROM users WHERE id = ?')
      .get(r.user.id) as { h: string }).h
    // 随机 32 字节的 hex（64 个字符）—— 不是 scrypt 的那种形状
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h.startsWith('scrypt$')).toBe(false)

    for (const pw of ['', 'oX1abcdef', r.user.username, h]) {
      await expect(handleLogin({ username: r.user.username, password: pw }, deps))
        .rejects.toThrow('密码不对，再试一次')
    }
  })

  it('★ 同一个人**在同一趟里**两次建号不可能：openid 上有唯一索引', async () => {
    // 这一列是这一整段的支点：少了这个索引，同一个微信号每登一次就多一个账号
    // —— 而"复用同一个账号"那条用例**照样绿**（它只呼一次查找就撞上了）。
    // 所以真正在守这件事的是**库**，这条钉的是库。
    const { fetchImpl } = wxStub({ openid: 'oX1abcdef' })
    const r = await handleWxLogin({ code: 'c' }, wxDeps(fetchImpl))
    expect(() => db.raw
      .prepare('INSERT INTO users (username, email, password_hash, created_at, wechat_openid) VALUES (?, ?, ?, ?, ?)')
      .run('另一个人', 'x@b.com', 'h', 1, 'oX1abcdef')).toThrow(/UNIQUE/)
    expect(r.user.id).toBeGreaterThan(0)

    // ★ 反向的那半：**老用户（wechat_openid 是 NULL）不受影响** ——
    //   SQLite 的 UNIQUE 索引允许多个 NULL，不然这条迁移一上去，
    //   库里所有电脑版账号都会变成"重复"。
    await handleSignup({ username: '老甲', email: 'a2@b.com', password: 'goodpassword' }, deps)
    await handleSignup({ username: '老乙', email: 'b2@b.com', password: 'goodpassword' }, deps)
    const nulls = (db.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE wechat_openid IS NULL')
      .get() as { n: number }).n
    expect(nulls).toBe(2)
  })

  it('code 不是字符串 / 是空串 → 400，而且**一个字都不发到微信**', async () => {
    for (const bad of [{}, { code: '' }, { code: 42 }, null, 'x']) {
      const { urls, fetchImpl } = wxStub({ openid: 'oX1' })
      await expect(handleWxLogin(bad, wxDeps(fetchImpl)))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(urls).toHaveLength(0)
    }
  })
})

/**
 * ★ 2026-10-04（spec §5；表里那行是「注销账号 | 作品全删（记录 + 文件）+ 用量记录全删」）。
 *
 * ⚠️ 这一组自己搭一个**真目录**的 storage：要验的正是"盘上的文件也不在了"。
 * ⚠️ 库里那几行**直接插**（不走 handleCreate*）：这一组要的不是"上传怎么建记录"，
 *    而是"注销能不能把它们清干净" —— 插出来的形状反而更接近要防的那种历史数据。
 */
describe('注销账号', () => {
  let dir: string
  let storage: Storage

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ruixing-del-'))
    storage = createStorage(dir)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const putWork = (userId: number, stored: string, thumb: string | null, bytes: number) => {
    db.raw.prepare(
      `INSERT INTO works (user_id, stored_name, thumb_name, bytes, created_at, updated_at, alias, recipe)
       VALUES (?, ?, ?, ?, 1, 1, NULL, '{"params":{},"edits":[]}')`,
    ).run(userId, stored, thumb, bytes)
  }
  const putSession = (userId: number, file: string) => {
    db.raw.prepare(
      `INSERT INTO sessions (user_id, created_at, updated_at, title, original, original_name,
         base, thumb, messages, steps, files, bytes)
       VALUES (?, 1, 1, NULL, ?, NULL, ?, NULL, '[]', '[]', ?, 2)`,
    ).run(userId, file, file, JSON.stringify([file]))
  }

  it('作品和会话的记录 + 文件全清；**别人的东西一个都不动**', async () => {
    const me = await handleSignup(GOOD, deps)
    const other = await handleSignup({ ...GOOD, username: '小红', email: 'b@b.com' }, deps)

    const mine = await storage.save(new Uint8Array([1, 2, 3]), '.jpg')
    const myThumb = await storage.save(new Uint8Array([4]), '.jpg')
    putWork(me.user.id, mine, myThumb, 3)
    const mySessFile = await storage.save(new Uint8Array([5, 6]), '.jpg')
    putSession(me.user.id, mySessFile)
    db.raw.prepare(
      `INSERT INTO model_configs (user_id, kind, provider, base_url, api_key_enc, model_id, alias, created_at)
       VALUES (?, 'chat', 'custom', 'https://x.test/v1', 'enc', 'm', '甲', 1)`,
    ).run(me.user.id)

    const theirs = await storage.save(new Uint8Array([9, 9]), '.jpg')
    putWork(other.user.id, theirs, null, 2)

    expect(await handleDeleteAccount(me.user, { db, storage })).toEqual({ ok: true })

    // 记录全清：works 是手动删的（那一列没写级联），sessions / model_configs 靠级联
    const count = (sql: string, id: number) =>
      (db.raw.prepare(sql).get(id) as { n: number }).n
    expect(count('SELECT COUNT(*) AS n FROM users WHERE id = ?', me.user.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM works WHERE user_id = ?', me.user.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', me.user.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM model_configs WHERE user_id = ?', me.user.id)).toBe(0)
    // 文件全清（作品的 + 缩略图 + 会话的）
    expect(readdirSync(dir)).toEqual([theirs])
    // 别人的东西完好
    expect(count('SELECT COUNT(*) AS n FROM works WHERE user_id = ?', other.user.id)).toBe(1)
  })

  it('★ 滤镜文件跟着一起删（行随 CASCADE，文件得手动收）；别人的滤镜不动', async () => {
    // ★ 2026-10-05：luts 表写了 ON DELETE CASCADE，所以**行**自己会走 ——
    //   但盘上那个 .cube 文件不会：它是注销这条路上"作品 + 会话 + 滤镜"三批文件里的
    //   第三批，漏了就一直躺在盘上没人认领（和曾经的孤儿缩略图同一个形状）。
    const CUBE2 = ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n')
    const me = await handleSignup(GOOD, deps)
    const other = await handleSignup({ ...GOOD, username: '小红', email: 'b@b.com' }, deps)
    const mine = await createLut({ name: '我的', cube: CUBE2 }, me.user, { db, storage })
    const theirs = await createLut({ name: '他的', cube: CUBE2 }, other.user, { db, storage })
    const nameOf = (id: number) =>
      (db.raw.prepare('SELECT stored_name FROM luts WHERE id = ?').get(id) as { stored_name: string }).stored_name
    const myFile = nameOf(mine.lut.id)
    const theirFile = nameOf(theirs.lut.id)
    expect(readdirSync(dir)).toContain(myFile)

    expect(await handleDeleteAccount(me.user, { db, storage })).toEqual({ ok: true })

    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM luts WHERE user_id = ?').get(me.user.id)).toEqual({ n: 0 })
    expect(readdirSync(dir)).not.toContain(myFile)   // 我的文件没了
    expect(readdirSync(dir)).toContain(theirFile)    // ★ 别人的一个都不动
  })
})
