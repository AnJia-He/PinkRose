import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from './db.ts'
import {
  handleSignup, handleLogin, handleChangePassword, findUserByCookie, type AccountDeps,
} from './account.ts'
import { SESSION_COOKIE } from './session.ts'

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
    // 请求体是从网上来的：`JSON.parse('42')`、`'null'`、`'[]'` 都是合法 JSON。
    // 它们只该变成"这次请求有问题"，不该变成 500（那等于把自己的堆栈送出去）。
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
    // 两句必须**一模一样**。区分了就等于发了一张"这个用户名存在"的查询接口，
    // 谁都能拿一个名字表来筛出哪些是真的 —— 后面的撞库就有了目标。
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
    // 票是从网上来的，形状随便什么都有可能。验不过只该让人变成"没登录"，
    // 不该让接口 500 —— 这也是「查不到用户」和「签名不过」必须**同一种结局**的地方。
    expect(findUserByCookie(`${SESSION_COOKIE}=garbage`, deps)).toBeNull()
  })

  it('★ 票的形状全合法，只有签名是假的 —— 一样查不出人', () => {
    // ⚠️ 这条不是上面那条的重复，是它的补丁：`garbage` 连"三段、是数字、没过期"
    // 都过不了，**走不到验签那一步**，所以"签名到底有没有被用上"它一句也没问。
    // 而"照着别人的 ID 自己造一张票"正是这套方案唯一要挡的东西 ——
    // 第一步解析出的 userId 是**不可信**的（见 findUserByCookie 的注释），
    // 唯一让它变可信的就是这里。少了这条，把验签结果丢掉也全绿。
    handleSignup(GOOD, deps)
    const { token, user } = handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    const [, exp, sig] = token.split('.') as [string, string, string]
    const flip = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')
    for (const forged of [
      `${user.id}.${exp}.${flip}`,          // 真 ID、真过期时间，签名改一个字符
      `${user.id}.${exp}.${'A'.repeat(43)}`, // 真 ID、真过期时间，签名自己编一个
    ]) {
      expect(findUserByCookie(`${SESSION_COOKIE}=${forged}`, deps)).toBeNull()
    }
  })

  it('用户被删了之后，票也查不出人', () => {
    // 票里写的是 userId 和过期时间，人没了就是没人 —— 不是"还能进，只是名字空着"。
    handleSignup(GOOD, deps)
    const { token } = handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    db.raw.prepare('DELETE FROM users').run()
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)).toBeNull()
  })

  it('★ 票过期之后就查不出人了', () => {
    // ⚠️ 上面几条的票**全是新鲜的** —— `clock` 钉死在某一个时刻，从头到尾没拨动过。
    // 于是"过期"这件事一条都没问过，而 30 天这条线是设计给的硬承诺。
    // 唯一执行它的地方，就是 findUserByCookie 转交给 verifySession 的"现在是几点"：
    // 把它写死成 0，票就**永不过期**，而上面 21 条照样全绿（审查实测）。
    //
    // 这和 Task 2 修掉的那条是**同一个形状** —— 一行没人测的守卫，管的是一个
    // 安全性质：那次是"任意密码能登录空哈希记录"，这次是"过期票永久有效"。
    // 守卫没人守着，就等于没有：它会安安静静地被改坏，而测试全绿。
    handleSignup(GOOD, deps)
    const { token } = handleLogin({ username: '小明', password: 'goodpassword' }, deps)
    // 同一个 deps、同一张票，只把"现在"拨过 30 天那条线。
    clock += 30 * 86400_000 + 1
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
    // 少了这一句，谁捡到一张票（哪怕是别人落下的手机）都能直接把号锁死。
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
    // 上面那次 UPDATE 让**包括当前这台在内**的所有票一起失效了（签名掺着哈希）。
    // 所以这里必须发一张新的 —— 不发的话，用户改完密码就把自己踢出去了，
    // 而他会以为"改密码这个功能坏了"。新票的哈希是**改完之后**那个，才验得过。
    handleSignup(GOOD, deps)
    const user = handleLogin({ username: '小明', password: 'goodpassword' }, deps).user
    const { token } = handleChangePassword({ oldPassword: 'goodpassword', newPassword: 'brandnewpw' }, user, deps)
    expect(findUserByCookie(`${SESSION_COOKIE}=${token}`, deps)?.id).toBe(user.id)
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
  it('注册时：密码 == 用户名的折叠形式 → 拒', () => {
    // ⚠️ 名字压到 8 位以上（密码的下限）**不是为了好看**：短名字会让输入先栽在
    // "密码至少 8 位"那条上，测试就变成一条**看起来在验这条规则、其实什么都没验**
    // 的假绿 —— 这个项目已经被这种测试咬过。
    // 断言写成整句而不是 `/名字/`：换个不合规的名字同样会抛，而那抛的不是这条规则。
    const expectRejected = (body: unknown) =>
      expect(() => handleSignup(body, deps)).toThrow('密码不能和名字一样')

    // ① 一模一样
    expectRejected({ username: 'abcdefgh', email: 'a@b.com', password: 'abcdefgh' })
    // ② 只差大小写 —— 库里存的必然是小写，而密码是用户原样敲的，折算在比较那侧做
    expectRejected({ username: 'Abcdefgh', email: 'b@b.com', password: 'ABCDEFGH' })
    // ③ 中点的两种写法看着一模一样（U+00B7 vs U+30FB），不折就等于没这条规则
    expectRejected({ username: '尼格买提·热合曼', email: 'c@b.com', password: '尼格买提・热合曼' })
  })

  it('改密码时也一样 —— 同一个规则在第二个调用点上也生效', () => {
    // 和注册是两个不同的调用点，各写各的 username 参数，所以各验各的。
    // 改密码这条尤其要紧：它是**随手就能重设**的那一条，
    // 要是能设成和名字一样，等于把"别人看一眼就知道"的密码合法化了。
    handleSignup({ username: 'abcdefgh', email: 'a@b.com', password: 'goodpassword' }, deps)
    const user = handleLogin({ username: 'abcdefgh', password: 'goodpassword' }, deps).user
    expect(() =>
      handleChangePassword({ oldPassword: 'goodpassword', newPassword: 'ABCDEFGH' }, user, deps),
    ).toThrow('密码不能和名字一样')
  })
})
