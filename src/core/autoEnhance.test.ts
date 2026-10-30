import { describe, expect, it } from 'vitest'
import { autoAdjustments, type AutoTone } from './autoEnhance'
import { PARAM_RANGE, ZERO, toUnit } from '../../shared/adjustments.ts'
import type { Rgb } from './colorMatch'
import { applyTone } from './tone.ts'

const fill = (rgb: Rgb, n = 200): Rgb[] => Array.from({ length: n }, () => rgb)

describe('autoAdjustments', () => {
  it('空样本 = 什么都不做', () => {
    expect(autoAdjustments([])).toEqual({
      temperature: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0,
      saturation: 0, vibrance: 0, cbMagentaGreen: 0,
    })
  })

  it('暗图提亮，并给一点对比度', () => {
    const a = autoAdjustments(fill([40, 40, 40]))
    expect(a.exposure).toBeGreaterThan(20)
    expect(a.contrast).toBeGreaterThan(0)
    expect(a.saturation).toBe(0)   // 纯灰不硬加饱和
    expect(a.vibrance).toBe(0)
  })

  it('★ 暗图套上自动参数之后，渲染结果真的比原图亮（曝光不被对比度抵消）', () => {
    const a = autoAdjustments(fill([40, 40, 40]))
    const [r, g, b] = applyTone([40 / 255, 40 / 255, 40 / 255], toUnit({ ...ZERO, ...a }))
    expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeGreaterThan(40 / 255)
  })

  it('亮图压曝光、收高光', () => {
    const a = autoAdjustments(fill([235, 235, 235]))
    expect(a.exposure).toBeLessThan(0)
    expect(a.highlights).toBeLessThan(0)
  })

  it('低反差彩色图加对比和饱和', () => {
    const a = autoAdjustments(fill([100, 120, 140]))
    expect(a.contrast).toBeGreaterThan(0)
    expect(a.saturation).toBeGreaterThan(0)
    expect(a.vibrance).toBeGreaterThan(0)
  })

  it('暖色偏往回压一点，绿色偏往回收', () => {
    const warm = autoAdjustments(fill([205, 125, 80]))
    expect(warm.temperature).toBeLessThan(0)
    const green = autoAdjustments(fill([100, 200, 100]))
    expect(green.cbMagentaGreen).toBeLessThan(0)
  })

  it('所有输出都落在自己的参数范围里', () => {
    const samples: Rgb[] = []
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 31) {
        for (let b = 0; b <= 255; b += 47) samples.push([r, g, b])
      }
    }
    const a = autoAdjustments(samples)
    for (const [k, v] of Object.entries(a) as [keyof AutoTone, number][]) {
      const [lo, hi] = PARAM_RANGE[k]
      expect(Number.isInteger(v), `${k} 不是整数`).toBe(true)
      expect(v).toBeGreaterThanOrEqual(lo)
      expect(v).toBeLessThanOrEqual(hi)
    }
  })
})
