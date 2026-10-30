import { describe, expect, it } from 'vitest'
import {
  formatVideoTime, videoFramePlan, videoOutputSize,
} from './plan'

describe('短片时间轴', () => {
  it('按 fps 出帧，时刻落在 [起点, 终点) 内', () => {
    const plan = videoFramePlan({ startMs: 1000, endMs: 2000 }, 5000, 24)
    expect(plan.times).toHaveLength(24)
    expect(plan.times[0]).toBe(1000)
    expect(plan.times.at(-1)!).toBeLessThan(2000)
    expect(plan.durationMs).toBe(1000)
    expect(plan.fps).toBe(24)
  })

  it('区间被夹进源片长度：起点越界不会出负数时刻', () => {
    const plan = videoFramePlan({ startMs: -500, endMs: 99_000 }, 3000, 12)
    expect(plan.times[0]).toBe(0)
    expect(plan.times.at(-1)!).toBeLessThan(3000)
    expect(plan.times).toHaveLength(36)
  })

  it('太短 / 太长 / 帧率不支持都直接说清楚', () => {
    expect(() => videoFramePlan({ startMs: 0, endMs: 200 }, 3000, 24)).toThrow(/至少留 0.5 秒/)
    expect(() => videoFramePlan({ startMs: 0, endMs: 25_000 }, 60_000, 24))
      .toThrow(/先剪到 20 秒以内/)
    expect(() => videoFramePlan({ startMs: 0, endMs: 3000 }, 3000, 30)).toThrow(/12 或 24/)
    expect(() => videoFramePlan({ startMs: 0, endMs: 3000 }, 0, 24)).toThrow(/读不出时长/)
  })

  it('变速：2× 成片减半、0.5× 加倍，取帧时刻按源片步进', () => {
    const fast = videoFramePlan({ startMs: 0, endMs: 2000 }, 3000, 12, 2)
    expect(fast.durationMs).toBe(1000)
    expect(fast.sourceDurationMs).toBe(2000)
    expect(fast.times).toHaveLength(12)
    expect(fast.times[1]! - fast.times[0]!).toBeCloseTo(2000 / 12)
    const slow = videoFramePlan({ startMs: 0, endMs: 1000 }, 3000, 12, 0.5)
    expect(slow.durationMs).toBe(2000)
    expect(slow.sourceDurationMs).toBe(1000)
    expect(slow.times).toHaveLength(24)
  })
})

describe('短片输出尺寸', () => {
  it('长边限到 1280，宽高都是偶数', () => {
    expect(videoOutputSize(3840, 2160)).toEqual({ width: 1280, height: 720 })
    expect(videoOutputSize(1080, 1920)).toEqual({ width: 720, height: 1280 })
    expect(videoOutputSize(1001, 777)).toEqual({ width: 1002, height: 778 })
  })

  it('比上限小的原样保留（只偶数化）', () => {
    expect(videoOutputSize(641, 481)).toEqual({ width: 642, height: 482 })
  })

  it('社交画幅按中心裁切，且绝不放大', () => {
    expect(videoOutputSize(1920, 1080, 1280, '1:1')).toEqual({ width: 1080, height: 1080 })
    expect(videoOutputSize(1920, 1080, 1280, '9:16')).toEqual({ width: 608, height: 1080 })
    expect(videoOutputSize(1080, 1920, 1280, '16:9')).toEqual({ width: 1080, height: 608 })
    expect(videoOutputSize(640, 360, 1280, '1:1')).toEqual({ width: 360, height: 360 })
    expect(videoOutputSize(3840, 2160, 1280, '4:5')).toEqual({ width: 1024, height: 1280 })
  })
})

describe('时长读数', () => {
  it('分:秒，一位小数', () => {
    expect(formatVideoTime(0)).toBe('0:00.0')
    expect(formatVideoTime(12_400)).toBe('0:12.4')
    expect(formatVideoTime(125_000)).toBe('2:05.0')
  })
})
