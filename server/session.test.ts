import { describe, it, expect } from 'vitest'
import {
  signSession, verifySession, parseCookies, sessionCookie, clearSessionCookie,
  expiryOf, SESSION_COOKIE, SESSION_DAYS,
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

  it('把过期时间往后挪自己重签也没用 —— 签名覆盖了它', () => {
    // 和上面那条是亲兄弟：签名覆盖的是「谁」和「到什么时候」两件事，
    // 少覆盖哪一件，票都能被持有人自己改成更大的权限 —— 把 ID 改大是冒充别人，
    // 把过期时间往后挪是自己给自己无限续期。
    const t = signSession(7, HASH_A, EXP, SECRET)
    const [id, , sig] = t.split('.')
    const forged = `${id}.${EXP + 86400_000}.${sig}`
    expect(verifySession(forged, HASH_A, NOW, SECRET)).toBeNull()
  })

  it('垃圾输入一律返回 null，不抛', () => {
    const t = signSession(7, HASH_A, EXP, SECRET)
    const [, exp, sig] = t.split('.')
    for (const bad of [
      '', 'a', 'a.b', 'a.b.c', '....', '1.2.3',
      // 下面两条和上面六条走的**不是同一条路**：上面六条连"三段、是数字、没过期"
      // 这几关都过不了，到不了比对签名那一步。而下面这两条结构全合法、过期时间也在
      // 未来，唯一的问题是签名长短不对 —— 那正好是 timingSafeEqual 会**抛**的地方
      // （RangeError: Input buffers must have the same byte length）。
      // 所以真正挡住它们的是比对之前那道长度判断，不是异常兜底（这里也没有兜底）：
      // 少了那行，一张乱填签名的票会把"这个人没登录"变成"接口 500"。
      `7.${EXP}.x`, // 签名太短
      `7.${exp}.${sig}${sig}`, // 签名太长
    ]) {
      expect(verifySession(bad, HASH_A, NOW, SECRET)).toBeNull()
    }
  })

  it('expiryOf 只读票上写的过期时间，**它不验签**', () => {
    // ⚠️ 这条不是"顺手补个覆盖率"，是在钉一个**前提**：滑动续期
    // （server/app.ts 的 renewSessionIfStale）拿到的票，是 findUserByCookie
    // 已经验过签的那一张 —— 而 expiryOf 自己什么都验不了。
    // 谁把它当成"这张票是真的"，就等于把签名那一层整个绕过去。
    expect(expiryOf(signSession(7, HASH_A, EXP, SECRET))).toBe(EXP)
    // 签名是假的、自己编的，照样读得出来 —— 这**正是**它不能用来放行的证据
    expect(expiryOf(`7.${EXP}.${'A'.repeat(43)}`)).toBe(EXP)
    // 形状不对给 null：调用方（续期）据此安静地跳过，而不是拿个 NaN 去比大小
    for (const bad of ['', 'a', 'a.b', '1.2.3.4', '7.abc.x']) {
      expect(expiryOf(bad)).toBeNull()
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
