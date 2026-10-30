import { describe, expect, it } from 'vitest'
import {
  kenBurnsRect, maxPerPhotoMs, photoMovieTimeline,
} from './plan'

describe('照片电影时间轴', () => {
  it('每张 2.5 秒 × 3 张 = 7.5 秒 / 180 帧', () => {
    const plan = photoMovieTimeline(3, 2500, 24)
    expect(plan.totalMs).toBe(7500)
    expect(plan.totalFrames).toBe(180)
    expect(plan.shots.map(s => s.frames)).toEqual([60, 60, 60])
    expect(plan.shots[2]).toMatchObject({ startMs: 5000, endMs: 7500 })
  })

  it('照片越多，每张分到的时间越短', () => {
    expect(maxPerPhotoMs(1)).toBe(4000)
    expect(maxPerPhotoMs(8)).toBe(2500)
    expect(maxPerPhotoMs(12)).toBe(1666)
    expect(maxPerPhotoMs(0)).toBe(1000)
  })

  it('淡入淡出：相邻两张重叠 0.4 秒，全片相应变短', () => {
    const cut = photoMovieTimeline(2, 1000, 12, 'cut')
    const fade = photoMovieTimeline(2, 1000, 12, 'fade')
    expect(cut.overlapFrames).toBe(0)
    expect(cut.totalFrames).toBe(24)
    expect(fade.overlapFrames).toBe(4)
    expect(fade.totalFrames).toBe(20)
    expect(fade.totalMs).toBe(1667)
    expect(fade.shots[1]!.startMs).toBe(667)
  })

  it('超上限 / 没照片 / 太多照片都直接说清楚', () => {
    expect(() => photoMovieTimeline(0, 2000, 24)).toThrow(/先选照片/)
    expect(() => photoMovieTimeline(13, 1000, 24)).toThrow(/最多 12 张/)
    expect(() => photoMovieTimeline(6, 4000, 24)).toThrow(/超过 20 秒/)
  })
})

describe('推拉镜头', () => {
  const source = { width: 1920, height: 1080 }
  const target = { width: 1080, height: 1080 }

  it('推近：画面从 cover 放大到 1.12 倍，且始终盖住画布', () => {
    const start = kenBurnsRect(source, target, 0, 'in', 0)
    const end = kenBurnsRect(source, target, 1, 'in', 0)
    expect(end.dw).toBeGreaterThan(start.dw)
    for (const rect of [start, end]) {
      expect(rect.dx).toBeLessThanOrEqual(0.001)
      expect(rect.dy).toBeLessThanOrEqual(0.001)
      expect(rect.dx + rect.dw).toBeGreaterThanOrEqual(target.width - 0.001)
      expect(rect.dy + rect.dh).toBeGreaterThanOrEqual(target.height - 0.001)
    }
  })

  it('平移：偶数张向右扫、奇数张向左扫', () => {
    const a0 = kenBurnsRect(source, target, 0, 'pan', 0)
    const a1 = kenBurnsRect(source, target, 1, 'pan', 0)
    const b0 = kenBurnsRect(source, target, 0, 'pan', 1)
    expect(a1.dx).toBeGreaterThan(a0.dx)
    expect(b0.dx).toBeGreaterThanOrEqual(a0.dx)
  })

  it('静止：进度不影响尺寸', () => {
    const a = kenBurnsRect(source, target, 0, 'none', 0)
    const b = kenBurnsRect(source, target, 1, 'none', 0)
    expect(a).toEqual(b)
  })
})
