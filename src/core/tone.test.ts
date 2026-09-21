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

/**
 * 高光/阴影按「剩余余量」缩放（spec 复审后的修复）。
 *
 * 不带余量因子时，高光 +100 会把 luma ≳ 0.79 的像素统统推过 1.0，
 * 被末步 clamp 削平成纯白（0.79 → 1.0，0.85 → 1.0）：高光梯度消失，
 * 而亮天空/雪地/海滩正是旅游照的典型场景。阴影 -100 是镜像的暗部版本。
 */
describe('高光/阴影的余量压缩：收敛到端点而不是穿过它', () => {
  const gray = (v: number): [number, number, number] => [v, v, v]

  describe('高光（亮部）', () => {
    const hi100 = toUnit({ ...ZERO, highlights: 100 })
    const hi0 = toUnit({ ...ZERO, highlights: 0 })

    it('+100 时 luma 0.85 的输出严格小于 1.0（不再削平）', () => {
      const out = applyTone(gray(0.85), hi100)[0]
      expect(out).toBeLessThan(1)
      // 同时仍是「提亮」方向
      expect(out).toBeGreaterThan(0.85)
    })

    it('+100 时 0.79 的输出严格小于 0.85 的输出（梯度保留）', () => {
      const dark = applyTone(gray(0.79), hi100)[0]
      const light = applyTone(gray(0.85), hi100)[0]
      expect(dark).toBeLessThan(light)
    })

    it('+100 时三个通道一起被提亮（灰度输入仍是灰度）', () => {
      const out = applyTone(gray(0.85), hi100)
      expect(out[1]).toBeCloseTo(out[0], 6)
      expect(out[2]).toBeCloseTo(out[0], 6)
    })

    it('0 时输出与输入完全一致（余量因子不能引入任何变化）', () => {
      const out = applyTone(gray(0.85), hi0)
      expect(out[0]).toBeCloseTo(0.85, 5)
      expect(out[1]).toBeCloseTo(0.85, 5)
      expect(out[2]).toBeCloseTo(0.85, 5)
    })
  })

  describe('阴影（暗部，负方向）', () => {
    const shNeg100 = toUnit({ ...ZERO, shadows: -100 })
    const sh0 = toUnit({ ...ZERO, shadows: 0 })

    it('-100 时 luma 0.15 的输出严格大于 0（不再压成纯黑）', () => {
      const out = applyTone(gray(0.15), shNeg100)[0]
      expect(out).toBeGreaterThan(0)
      // 同时仍是「压暗」方向
      expect(out).toBeLessThan(0.15)
    })

    it('-100 时 0.21 的输出严格大于 0.15 的输出（梯度保留）', () => {
      const darker = applyTone(gray(0.15), shNeg100)[0]
      const lighter = applyTone(gray(0.21), shNeg100)[0]
      expect(darker).toBeLessThan(lighter)
    })

    it('0 时输出与输入完全一致（余量因子不能引入任何变化）', () => {
      const out = applyTone(gray(0.15), sh0)
      expect(out[0]).toBeCloseTo(0.15, 5)
      expect(out[1]).toBeCloseTo(0.15, 5)
      expect(out[2]).toBeCloseTo(0.15, 5)
    })
  })
})
