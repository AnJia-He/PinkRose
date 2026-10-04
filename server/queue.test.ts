import { describe, it, expect } from 'vitest'
import { SerialQueue } from './queue.ts'
import { SnError } from './sn.ts'

/** 假 sleep：不真的等，记录每次要求等了多久。 */
function fakeSleep() {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => { waits.push(ms) } }
}

const ok = <T,>(v: T) => async () => v
const boom = (e: unknown) => async () => { throw e }

describe('SerialQueue 串行性', () => {
  it('后提交的任务必须等前一个 resolve 之后才开始', async () => {
    const q = new SerialQueue()
    const order: string[] = []
    const a = q.run(async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 20)); order.push('a-end') })
    const b = q.run(async () => { order.push('b-start'); order.push('b-end') })
    await Promise.all([a, b])
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('一个任务失败不会卡死后面排队的任务', async () => {
    const q = new SerialQueue({ attempts: 1 })
    const failed = q.run(boom(new SnError('UPSTREAM_FAILED', 'x', false))).catch(() => 'caught')
    const after = q.run(ok('done'))
    await expect(failed).resolves.toBe('caught')
    await expect(after).resolves.toBe('done')
  })

  it('返回值透传', async () => {
    const q = new SerialQueue()
    await expect(q.run(ok(42))).resolves.toBe(42)
  })
})

describe('SerialQueue 重试', () => {
  it('可重试的错误会重试，成功即止', async () => {
    const { waits, sleep } = fakeSleep()
    const q = new SerialQueue({ sleep, baseDelayMs: 100, attempts: 4 })
    let n = 0
    const out = await q.run(async () => {
      n++
      if (n < 3) throw new SnError('UPSTREAM_LIMIT', '限流', true)
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(n).toBe(3)
    expect(waits).toEqual([100, 200])   // 指数递增
  })

  it('不可重试的错误立刻抛出，一次都不重试', async () => {
    const { waits, sleep } = fakeSleep()
    const q = new SerialQueue({ sleep, attempts: 4 })
    let n = 0
    await expect(q.run(async () => { n++; throw new SnError('UPSTREAM_FAILED', '400', false) }))
      .rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
    expect(n).toBe(1)
    expect(waits).toEqual([])
  })

  it('重试用尽后抛出最后一个错误', async () => {
    const { sleep } = fakeSleep()
    const q = new SerialQueue({ sleep, attempts: 3, baseDelayMs: 1 })
    let n = 0
    await expect(q.run(async () => { n++; throw new SnError('UPSTREAM_LIMIT', 'still limited', true) }))
      .rejects.toMatchObject({ code: 'UPSTREAM_LIMIT' })
    expect(n).toBe(3)
  })

  it('退避有上限，不会无限翻倍', async () => {
    const { waits, sleep } = fakeSleep()
    const q = new SerialQueue({ sleep, attempts: 5, baseDelayMs: 100, maxDelayMs: 300 })
    await q.run(boom(new SnError('UPSTREAM_LIMIT', 'x', true))).catch(() => {})
    expect(waits).toEqual([100, 200, 300, 300])
  })

  it('非 SnError 的异常不可重试 —— 只有上游问题值得重试', async () => {
    const { sleep } = fakeSleep()
    const q = new SerialQueue({ sleep, attempts: 3 })
    let n = 0
    await expect(q.run(async () => { n++; throw new TypeError('我自己的 bug') })).rejects.toBeInstanceOf(TypeError)
    expect(n).toBe(1)
  })

  it('onRetry 被调用，带上第几次和等多久', async () => {
    const { sleep } = fakeSleep()
    const seen: { attempt: number; delayMs: number }[] = []
    const q = new SerialQueue({ sleep, attempts: 3, baseDelayMs: 50, onRetry: i => seen.push({ attempt: i.attempt, delayMs: i.delayMs }) })
    await q.run(boom(new SnError('UPSTREAM_LIMIT', 'x', true))).catch(() => {})
    expect(seen).toEqual([{ attempt: 1, delayMs: 50 }, { attempt: 2, delayMs: 100 }])
  })
})

/**
 * ★ 2026-10-04（审计 F2）。原来队列**没有长度上限**：每个排队的人，他的请求体
 * 都整份留在内存里等着（`readJsonBody` 已经把 body 读进来了），几百个请求就能
 * 把内存吃光；而它们串行，等的人其实什么也等不到。满了就明说，别假装能接。
 */
describe('★ 队列长度上限', () => {
  it('满了立刻拒绝（503 的人话），跑完又收得下新的', async () => {
    const q = new SerialQueue({ sleep: async () => {}, maxPending: 1 })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const running = q.run(async () => { await gate; return 1 })

    // 1 个在跑 = 已经到上限
    await expect(q.run(async () => 2)).rejects.toThrow(/人有点多/)

    release()
    expect(await running).toBe(1)
    // 名额还回来了：新的收得下
    expect(await q.run(async () => 3)).toBe(3)
  })
})
