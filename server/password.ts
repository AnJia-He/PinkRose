import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** scrypt 参数。N=2^15 在 2026 年的机器上约几十毫秒，够慢也够快。 */
const N = 32768
const R = 8
const P = 1
const KEY_LEN = 64
const SALT_LEN = 16

/**
 * scrypt 单次允许申请的内存上限，**必须显式传**。
 *
 * scrypt 真正要占的内存是 128·N·r ≈ 32 MiB，而 OpenSSL 3 的默认上限正好也是 32 MiB ——
 * 卡在边界上，于是这组 N/r 用默认参数**一次都算不出来**，直接报
 * `memory limit exceeded`（实测 Node 24 / OpenSSL 3.5.5：下限是
 * 128·r·(N+2) + 128·r·p = 33557504 字节，比默认的 33554432 多出 3072）。
 * 所以这不是"调优"，是这组参数能不能跑的前提。
 *
 * 取 2 倍而不是"贴着下限再加一点"：各版本 OpenSSL 对上限的口径不完全一样，
 * 贴边等于把版本差异变成上线后的偶发失败，留一倍余量便宜得多。
 *
 * 也**不能**按存储里的 n、r 现算 —— 那串是数据库里的，被改坏时上限会跟着一起涨。
 * 钉成常量之后，超纲的参数会在 0ms 内抛错、一分钱内存都不申请（实测），
 * 于是它和别的坏输入走同一条路："抛了 → 当对不上"，而不是把进程拖垮。
 * ⚠️ 它**跟着 N、R 一起动**（下一行就是 `128·N·r` 的两倍，现算出来的），
 * 所以以后调大 N 时**不用记得回来改它**。真正不受影响的是**老哈希**：
 * 它们存着自己的 n、r，比新参数小，这个上限对它们只会更宽松。
 */
const MAXMEM = 128 * N * R * 2

/**
 * 把明文密码变成可以进数据库的字符串。
 *
 * **每次调用的盐都不一样** —— 同一个密码在两个用户那里哈希也不同，
 * 于是"撞库"（拿别人的哈希表来试）在这个库里没有意义。
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_LEN)
  const key = scryptSync(plain, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAXMEM })
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
  // 签名上的 `stored: string` 只在编译期成立 —— Node 的 TS 剥离模式运行时不设防，
  // 而它真正被调用的地方（把 password_hash 从数据库读出来）正好是个无类型的边界。
  // null / undefined 进来时，下一行的 split 会直接抛，那就把"一个人有问题"
  // 放大成"所有人都登不了"，正是上面那段注释要避免的事。
  // 所以这道判断是契约的一部分，不是多余的防御。
  if (typeof stored !== 'string') return false

  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (n <= 0 || r <= 0 || p <= 0) return false

  // 这里**不能**用 try/catch 兜底：`Buffer.from(x, 'base64')` 对垃圾输入根本不抛 ——
  // 它会悄悄忽略非法字符、返回一个可能很短的 buffer。所以真正挡住坏数据的是下一行的
  // 长度判断，不是异常。
  const salt = Buffer.from(parts[4]!, 'base64')
  const expected = Buffer.from(parts[5]!, 'base64')
  if (salt.length === 0 || expected.length === 0) return false

  let actual: Buffer
  try {
    actual = scryptSync(plain, salt, expected.length, { N: n, r, p, maxmem: MAXMEM })
  } catch {
    // 参数大到内存扛不住时 scryptSync 会抛。当成"对不上"，不是"服务器坏了"
    return false
  }
  // 长度不同的 timingSafeEqual 会抛，先挡掉
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
