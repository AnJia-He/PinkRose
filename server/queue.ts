import { HttpError } from './http.ts'
import { SnError } from './sn.ts'

export type QueueOptions = {
  /** 总尝试次数（含第一次）。 */
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /**
   * 最多允许多少个任务**排在队里**（含正在跑的那个）。默认 30。
   * ★ 2026-10-04（审计 F2）：原来**没有上限** —— 每个排队的人，他的请求体都
   *   整份留在内存里等着（readJsonBody 已经把 body 读进来了），几百个请求就能
   *   把内存吃光；而它们串行，等的人其实什么也等不到。满了就明说，别假装能接。
   */
  maxPending?: number
  /** 注入用，测试里换成不真等的实现。 */
  sleep?: (ms: number) => Promise<void>
  onRetry?: (info: { label: string; attempt: number; delayMs: number; error: unknown }) => void
}

const DEFAULTS = {
  attempts: 4,
  baseDelayMs: 800,
  maxDelayMs: 8000,
  maxPending: 30,
}

/**
 * 全局串行队列。
 *
 * 账户有 RPM/TPM 限制（实测 kimi-k3 连续 3 次请求里 2 次被打回
 * ModelAccountTpmRateLimitExceeded）。**并发轰炸只会让限流更容易触发**，
 * 所以所有出站请求排成一队逐个走。
 *
 * 串行还顺带保证了对话的因果顺序：用户连说三句话，处理顺序必然是说的顺序。
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly attempts: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly maxPending: number
  private pending = 0
  private readonly sleep: (ms: number) => Promise<void>
  private readonly onRetry?: QueueOptions['onRetry']

  constructor(opts: QueueOptions = {}) {
    this.attempts = opts.attempts ?? DEFAULTS.attempts
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs
    this.maxPending = opts.maxPending ?? DEFAULTS.maxPending
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    this.onRetry = opts.onRetry
  }

  run<T>(task: () => Promise<T>, label = 'task'): Promise<T> {
    // ★ 2026-10-04（审计 F2）：排队有上限（理由见 QueueOptions.maxPending）。
    //   立刻拒绝，别收下——收下就意味着那份 body 要在内存里一直等。
    if (this.pending >= this.maxPending) {
      return Promise.reject(new HttpError('INTERNAL', '现在人有点多，等一会儿再试。', 503))
    }
    this.pending++
    // 关键：用 .then(fn, fn) 而不是 .then(fn).catch()——
    // 前者无论上一个任务成功还是失败都会继续排，后者会在失败后断链。
    const result = this.tail.then(() => this.withRetry(task, label),
                                  () => this.withRetry(task, label))
    // tail 不能带 reject，否则一个失败会让后续所有 .then 都走拒绝分支
    this.tail = result.catch(() => undefined)
    // 名额在**这一趟有结果时**才还（成功/失败都一样）—— 这一条本身不产生未处理拒绝
    result.then(() => { this.pending-- }, () => { this.pending-- })
    return result
  }

  private async withRetry<T>(task: () => Promise<T>, label: string): Promise<T> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        return await task()
      } catch (e) {
        lastError = e
        // 只有 SnError 且标了 retryable 才重试。
        // 我们自己代码里的 TypeError 重试一百次也还是 TypeError。
        const retryable = e instanceof SnError && e.retryable
        if (!retryable || attempt === this.attempts) break
        const delayMs = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs)
        this.onRetry?.({ label, attempt, delayMs, error: e })
        await this.sleep(delayMs)
      }
    }
    throw lastError
  }
}
