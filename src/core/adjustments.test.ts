import { describe, it, expect } from 'vitest'
import { ZERO, PARAM_KEYS, clampAdjustments, applyDeltas, toUnit } from './adjustments'

describe('PARAM_KEYS', () => {
  it('固定八个参数，名字不能改', () => {
    expect(PARAM_KEYS).toEqual([
      'exposure', 'contrast', 'highlights', 'shadows',
      'saturation', 'temperature', 'clarity', 'vignette',
    ])
  })
})

describe('ZERO', () => {
  it('八个字段全为 0', () => {
    for (const k of PARAM_KEYS) expect(ZERO[k]).toBe(0)
  })
})

describe('clampAdjustments', () => {
  it('把越界值钳到 [-100, 100]', () => {
    const out = clampAdjustments({ ...ZERO, exposure: 150, contrast: -220, shadows: 30 })
    expect(out.exposure).toBe(100)
    expect(out.contrast).toBe(-100)
    expect(out.shadows).toBe(30)
  })

  it('不改动入参（纯函数）', () => {
    const input = { ...ZERO, exposure: 999 }
    clampAdjustments(input)
    expect(input.exposure).toBe(999)
  })

  it('NaN / ±Infinity 一律当中立 0（否则会一路穿进 shader uniform）', () => {
    const out = clampAdjustments({
      ...ZERO,
      exposure: NaN, contrast: Infinity, shadows: -Infinity,
      highlights: 30, saturation: NaN,
    })
    expect(out.exposure).toBe(0)
    expect(out.contrast).toBe(0)
    expect(out.shadows).toBe(0)
    expect(out.saturation).toBe(0)
    expect(out.highlights).toBe(30)
  })
})

describe('applyDeltas', () => {
  it('增量叠加到当前值上', () => {
    const base = { ...ZERO, temperature: -20 }
    const out = applyDeltas(base, { temperature: 15 })
    expect(out.temperature).toBe(-5)
  })

  it('叠加后仍钳制在范围内', () => {
    const out = applyDeltas({ ...ZERO, exposure: 90 }, { exposure: 50 })
    expect(out.exposure).toBe(100)
  })

  it('只动传入的字段，其余保持不变', () => {
    const base = { ...ZERO, saturation: 40, vignette: -10 }
    const out = applyDeltas(base, { exposure: 10 })
    expect(out.saturation).toBe(40)
    expect(out.vignette).toBe(-10)
  })
})

describe('toUnit', () => {
  it('-100 -> -1，100 -> 1，0 -> 0', () => {
    const u = toUnit({ ...ZERO, exposure: -100, contrast: 100, shadows: 0 })
    expect(u.exposure).toBe(-1)
    expect(u.contrast).toBe(1)
    expect(u.shadows).toBe(0)
  })

  it('中间值线性映射（50 -> 0.5）', () => {
    expect(toUnit({ ...ZERO, saturation: 50 }).saturation).toBe(0.5)
  })

  it('八个通道各读各的字段（互不串位）', () => {
    // 每个通道喂一个互不相同的值：若映射写错（例如 clarity 读成 contrast），
    // 这条会立刻红。只抽样 4 个通道是抓不到串位的。
    const u = toUnit({
      exposure: 10, contrast: 20, highlights: 30, shadows: 40,
      saturation: 50, temperature: 60, clarity: 70, vignette: 80,
    })
    expect(u.exposure).toBe(0.1)
    expect(u.contrast).toBe(0.2)
    expect(u.highlights).toBe(0.3)
    expect(u.shadows).toBe(0.4)
    expect(u.saturation).toBe(0.5)
    expect(u.temperature).toBe(0.6)
    expect(u.clarity).toBe(0.7)
    expect(u.vignette).toBe(0.8)
  })

  it('负值同样逐通道对应', () => {
    const u = toUnit({
      exposure: -10, contrast: -20, highlights: -30, shadows: -40,
      saturation: -50, temperature: -60, clarity: -70, vignette: -80,
    })
    expect(u).toEqual({
      exposure: -0.1, contrast: -0.2, highlights: -0.3, shadows: -0.4,
      saturation: -0.5, temperature: -0.6, clarity: -0.7, vignette: -0.8,
    })
  })
})
