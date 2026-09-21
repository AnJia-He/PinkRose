import { describe, it, expect } from 'vitest'
import { ZERO, toUnit } from './adjustments'
import { applyTone, srgbToLinear, linearToSrgb } from './tone'

const mid: [number, number, number] = [0.5, 0.5, 0.5]
const U = toUnit(ZERO)

describe('sRGB 线性化往返', () => {
  it('往返后基本还原', () => {
    for (const v of [0, 0.04, 0.2, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 5)
    }
  })
})

describe('applyTone', () => {
  it('全零参数不改变颜色', () => {
    const out = applyTone([0.3, 0.6, 0.9], U)
    expect(out[0]).toBeCloseTo(0.3, 3)
    expect(out[1]).toBeCloseTo(0.6, 3)
    expect(out[2]).toBeCloseTo(0.9, 3)
  })

  it('曝光 +100 让中灰明显变亮', () => {
    const out = applyTone(mid, toUnit({ ...ZERO, exposure: 100 }))
    expect(out[0]).toBeGreaterThan(0.6)
  })

  it('曝光 -100 让中灰明显变暗', () => {
    const out = applyTone(mid, toUnit({ ...ZERO, exposure: -100 }))
    expect(out[0]).toBeLessThan(0.4)
  })

  it('对比度 +100 把亮部推更亮、暗部推更暗', () => {
    const dark = applyTone([0.25, 0.25, 0.25], toUnit({ ...ZERO, contrast: 100 }))
    const light = applyTone([0.75, 0.75, 0.75], toUnit({ ...ZERO, contrast: 100 }))
    expect(dark[0]).toBeLessThan(0.25)
    expect(light[0]).toBeGreaterThan(0.75)
  })

  it('对比度 +100 时中灰不动（支点在中灰）', () => {
    const out = applyTone(mid, toUnit({ ...ZERO, contrast: 100 }))
    expect(out[0]).toBeCloseTo(0.5, 2)
  })

  it('饱和度 -100 把颜色压成灰（三通道相等）', () => {
    const out = applyTone([0.9, 0.3, 0.1], toUnit({ ...ZERO, saturation: -100 }))
    expect(out[0]).toBeCloseTo(out[1], 3)
    expect(out[1]).toBeCloseTo(out[2], 3)
  })

  it('饱和度 +50 让原本就鲜艳的颜色更鲜艳', () => {
    const before = [0.8, 0.4, 0.2] as [number, number, number]
    const out = applyTone(before, toUnit({ ...ZERO, saturation: 50 }))
    const spreadBefore = Math.max(...before) - Math.min(...before)
    const spreadAfter = Math.max(...out) - Math.min(...out)
    expect(spreadAfter).toBeGreaterThan(spreadBefore)
  })

  it('色温 +100 让画面偏暖（红升蓝降）', () => {
    const out = applyTone(mid, toUnit({ ...ZERO, temperature: 100 }))
    expect(out[0]).toBeGreaterThan(out[2])
  })

  it('色温 -100 让画面偏冷（蓝升红降）', () => {
    const out = applyTone(mid, toUnit({ ...ZERO, temperature: -100 }))
    expect(out[2]).toBeGreaterThan(out[0])
  })

  it('高光 +100 主要提亮亮部，暗部几乎不动', () => {
    const light = applyTone([0.85, 0.85, 0.85], toUnit({ ...ZERO, highlights: 100 }))
    const dark = applyTone([0.2, 0.2, 0.2], toUnit({ ...ZERO, highlights: 100 }))
    expect(light[0] - 0.85).toBeGreaterThan(0.05)
    expect(Math.abs(dark[0] - 0.2)).toBeLessThan(0.02)
  })

  it('阴影 +100 主要提亮暗部，亮部几乎不动', () => {
    const dark = applyTone([0.2, 0.2, 0.2], toUnit({ ...ZERO, shadows: 100 }))
    const light = applyTone([0.85, 0.85, 0.85], toUnit({ ...ZERO, shadows: 100 }))
    expect(dark[0] - 0.2).toBeGreaterThan(0.05)
    expect(Math.abs(light[0] - 0.85)).toBeLessThan(0.02)
  })

  it('输出永远落在 [0, 1] 内（极端参数也不越界）', () => {
    const extreme = toUnit({
      exposure: 100, contrast: 100, highlights: 100, shadows: 100,
      saturation: 100, temperature: 100, clarity: 100, vignette: 100,
    })
    for (const rgb of [[0, 0, 0], [1, 1, 1], [0.5, 0.2, 0.9]] as const) {
      const out = applyTone(rgb as [number, number, number], extreme)
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })
})
