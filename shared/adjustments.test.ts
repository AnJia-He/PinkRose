import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ZERO, PARAM_KEYS, PARAM_LABELS, isChanged, clampAdjustments, applyDeltas, toUnit } from './adjustments.ts'

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

describe('PARAM_LABELS', () => {
  it('八个参数一个不少、一个不多', () => {
    expect(Object.keys(PARAM_LABELS).sort()).toEqual([...PARAM_KEYS].sort())
  })

  it('八条标签互不相同', () => {
    // 变异：`contrast: '亮度'` 这种复制粘贴事故 —— 上面那条数键、这条管值，
    // 少了这条，两条参数在界面上会顶同一个名字，而所有别的断言都照绿。
    expect(new Set(Object.values(PARAM_LABELS)).size).toBe(8)
  })

  it('exposure 显示成「亮度」，不是「曝光」', () => {
    // §3.5.2 的两条理由：用户找的是「亮度」；而 Lightroom 里"曝光"是 EV(-5~+5)，
    // 我们这套是 -100~+100 —— 挂在"曝光"这个名字下会让用过 Lightroom 的人误判数量级
    expect(PARAM_LABELS.exposure).toBe('亮度')
  })

  it('每个名字都是中文，而且**不是字段名本身**', () => {
    // 变异：把某一条改成 `'exposure'` 这种 → 必须红。
    // 界面上出现裸字段名，用户看到的就是一行英文变量名。
    for (const [key, label] of Object.entries(PARAM_LABELS)) {
      expect(label).not.toBe(key)
      expect(/[一-鿿]/.test(label)).toBe(true)
    }
  })
})

describe('isChanged', () => {
  it('中立值（0）算没动过，别的都算动过', () => {
    expect(PARAM_KEYS.filter(k => isChanged(ZERO, k))).toEqual([])
    expect(PARAM_KEYS.filter(k => isChanged({ ...ZERO, exposure: 1 }, k))).toEqual(['exposure'])
    expect(PARAM_KEYS.filter(k => isChanged({ ...ZERO, vignette: -1 }, k))).toEqual(['vignette'])
  })

  it('★ 两个界面问的是同一个问题 —— 判据只有一份', () => {
    // 微调面板靠它点亮滑块，作品详情页靠它决定那张表里列哪些行。
    // 两处各写一份 `!== 0` 的话，判据一变（比如以后 ±2 以内都算没动）会出现
    // **两个屏幕对同一张图说法不一致**：详情页说"这一张是原样"，面板那边还亮着。
    //
    // 这条测试钉的是"两处真的都走这里"，做法和 `PARAM_LABELS` 那条同款
    // （读源码，断言没人自己写死一份）。
    for (const f of ['../src/ui/AdjustmentPanel.tsx', '../src/ui/WorkDetailPage.tsx']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      expect(src, `${f} 该用 isChanged`).toContain('isChanged')
      // 变异：在任一处写回 `params[k] !== 0` / `value[k] !== 0` → 必须红
      expect(src, `${f} 里还有人自己判 null 值`).not.toMatch(/\w+\[k\]\s*!==\s*0/)
    }
  })
})
