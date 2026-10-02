/**
 * 一个极小的滑动窗口限流器（按 key 计数）。
 *
 * ★ 2026-10-02 加（安全审计 H2 / S3）。在那之前：
 *   · `/api/login` **一个失败计数都没有** —— 无锁定、无退避，而接口还主动
 *     回答"这个账号存不存在"，于是字典可以慢慢试密码；
 *   · `/api/signup` 完全不限量 —— 批量注册小号去烧我们的额度；
 *   · `/api/models/test` 是登录即可用的网络探测器，不限速、不排队、不留痕。
 *
 * ⚠️ **自己写而不是接 `rate-limiter-flexible`**：这个服务是**单进程**、
 *    状态在内存里就够（多进程/多机才需要共享存储）。真要横向扩的那一天，
 *    把这一份换掉即可 —— 对外只有 `hit` / `reset` / `size` 三个方法。
 *
 * ⚠️ **过期条目只在被碰到时才清**（滑动窗口的常规做法）。所以 key 会累积 ——
 *    这正好给了"拿字典轮着试"一条把限流器自己变成内存漏洞的路
 *    （每个用户名都是一个新 key）。`maxKeys` 就是为这个存在的，见下面。
 */

export type HitResult = { ok: true } | { ok: false; retryAfterMs: number }

export type Limiter = {
  /** 记一次并判断：这次放行吗？ */
  hit(key: string): HitResult
  /** 额度清零（登录成功之后用 —— 别让"打错的几次"攒着） */
  reset(key: string): void
  /** 现在记着多少个 key（测试和排查用） */
  size(): number
}

export type LimiterOptions = {
  /** 窗口内最多几次 */
  max: number
  /** 窗口长度（毫秒） */
  windowMs: number
  /** 最多记多少个 key。默认 10000 */
  maxKeys?: number
  /** 注入时钟 —— 测试要能把时间拨快，不然只能真的 sleep */
  now?: () => number
}

export function createLimiter(opts: LimiterOptions): Limiter {
  const { max, windowMs, maxKeys = 10_000 } = opts
  const now = opts.now ?? (() => Date.now())
  /** key → 这个窗口里那几次的时间戳（升序）。Map 的迭代序即插入序，淘汰要用。 */
  const hits = new Map<string, number[]>()

  return {
    hit(key: string): HitResult {
      const t = now()
      const list = (hits.get(key) ?? []).filter(ts => t - ts < windowMs)

      if (list.length >= max) {
        // 最早那一次滑出窗口就又能用了 —— 所以等待时间按**它**算，
        // 不是"整个窗口重来"（后者会把用户罚得比实际需要的久）。
        hits.set(key, list)
        return { ok: false, retryAfterMs: Math.max(0, windowMs - (t - list[0]!)) }
      }

      list.push(t)
      // 先删再设：删掉能让它在 Map 的迭代序里排到**最后**，
      // 于是"淘汰最老的"就是淘汰真正最久没被碰过的那个。
      hits.delete(key)
      hits.set(key, list)

      // ★ 满了就淘汰**最老的** key，而**不是拒绝新 key**。
      //   拒绝新 key 的话，"轮着试"反而能把所有正常用户一起挡在门外 ——
      //   那是拿攻击者的手段去伤用户。宁可少限，不可误伤。
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value
        if (oldest === undefined) break
        hits.delete(oldest)
      }
      return { ok: true }
    },

    reset(key: string): void {
      hits.delete(key)
    },

    size(): number {
      return hits.size
    },
  }
}
