import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ZERO, PARAM_KEYS, PARAM_RANGE, PARAM_GROUPS, PARAM_LABELS,
  isChanged, clampAdjustments, applyDeltas, toUnit, type Adjustments,
} from './adjustments.ts'

// ⚠️ 这里原来有两条 `PARAM_KEYS 固定八个参数` / `ZERO 八个字段全为 0` 的
//    describe —— 2026-10-04 参数层扩到 15 个之后，它们的断言（键数、键序）
//    必然红，而**覆盖被下面「专业面板新增的 7 个参数」那一组的首尾两条完全
//    包含**（15 键 + 顺序 / ZERO 全 0），所以直接删掉，不留两份同一个断言。

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

  it('★ 十五个通道各读各的字段（互不串位）', () => {
    // 每个通道喂一个互不相同的值：若映射写错（例如 clarity 读成 contrast、
    // 或者色相被除了 100 而不是 360），这条会立刻红。只抽样几个通道是抓不到串位的
    // —— 这条原来只抽样八个老的，2026-10-04 加参数时同步扩到十五个。
    const u = toUnit({
      exposure: 10, contrast: 20, highlights: 30, shadows: 40,
      temperature: 50, vibrance: 60, saturation: 70,
      cbCyanRed: 80, cbMagentaGreen: 90, cbYellowBlue: 100,
      splitHiHue: 180, splitLoHue: 270, splitAmount: 25,
      clarity: 55, vignette: 65,
    })
    expect(u).toEqual({
      exposure: 0.1, contrast: 0.2, highlights: 0.3, shadows: 0.4,
      temperature: 0.5, vibrance: 0.6, saturation: 0.7,
      cbCyanRed: 0.8, cbMagentaGreen: 0.9, cbYellowBlue: 1,
      splitHiHue: 0.5, splitLoHue: 0.75, splitAmount: 0.25,
      clarity: 0.55, vignette: 0.65,
    })
  })

  it('负值同样逐通道对应', () => {
    const u = toUnit({
      ...ZERO,
      exposure: -10, contrast: -20, highlights: -30, shadows: -40,
      saturation: -50, temperature: -60, clarity: -70, vignette: -80,
    })
    expect(u).toEqual({
      ...ZERO,
      exposure: -0.1, contrast: -0.2, highlights: -0.3, shadows: -0.4,
      saturation: -0.5, temperature: -0.6, clarity: -0.7, vignette: -0.8,
    })
  })
})

describe('PARAM_LABELS', () => {
  it('十五个参数一个不少、一个不多', () => {
    expect(Object.keys(PARAM_LABELS).sort()).toEqual([...PARAM_KEYS].sort())
  })

  it('每条标签互不相同', () => {
    // 变异：`contrast: '亮度'` 这种复制粘贴事故 —— 上面那条数键、这条管值，
    // 少了这条，两条参数在界面上会顶同一个名字，而所有别的断言都照绿。
    // 数用 PARAM_KEYS.length 而不是写死 —— 加参数时这条跟着走，不许静默放宽。
    expect(new Set(Object.values(PARAM_LABELS)).size).toBe(PARAM_KEYS.length)
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

describe('专业面板新增的 7 个参数（2026-10-04）', () => {
  it('PARAM_KEYS 是 15 个，而且顺序就是面板顺序', () => {
    expect(PARAM_KEYS).toEqual([
      'exposure', 'contrast', 'highlights', 'shadows',
      'temperature', 'vibrance', 'saturation',
      'cbCyanRed', 'cbMagentaGreen', 'cbYellowBlue',
      'splitHiHue', 'splitLoHue', 'splitAmount',
      'clarity', 'vignette',
    ])
  })

  it('每个键都有一行范围、一个界面名，而且分组不重不漏', () => {
    for (const k of PARAM_KEYS) {
      expect(PARAM_RANGE[k], `${k} 没有范围`).toBeTruthy()
      expect(PARAM_LABELS[k], `${k} 没有界面名`).toBeTruthy()
    }
    const inGroups = PARAM_GROUPS.flatMap(g => g.keys)
    expect([...inGroups].sort()).toEqual([...PARAM_KEYS].sort())   // 不重不漏
  })

  it('色相是 0~360、强度是 0~100，其余仍是 -100~100', () => {
    expect(PARAM_RANGE.splitHiHue).toEqual([0, 360])
    expect(PARAM_RANGE.splitLoHue).toEqual([0, 360])
    expect(PARAM_RANGE.splitAmount).toEqual([0, 100])
    expect(PARAM_RANGE.vibrance).toEqual([-100, 100])
    expect(PARAM_RANGE.cbCyanRed).toEqual([-100, 100])
  })

  it('clamp 按各自的范围钳（色相不会被钳成 100）', () => {
    const c = clampAdjustments({ ...ZERO, splitHiHue: 400, splitLoHue: -20, splitAmount: 300, cbCyanRed: 999 })
    expect(c.splitHiHue).toBe(360)
    expect(c.splitLoHue).toBe(0)
    expect(c.splitAmount).toBe(100)
    expect(c.cbCyanRed).toBe(100)
  })

  it('★ 缺新键的老 params（只有八根）→ 全部落成 0，一个 NaN 都不许有', () => {
    // 形状照 2026-10-04 之前存进库里的那份（只有八个键）
    const legacy = {
      exposure: 10, contrast: -5, highlights: 0, shadows: 0,
      saturation: 0, temperature: 0, clarity: 0, vignette: 0,
    } as unknown as Adjustments
    const c = clampAdjustments(legacy)
    for (const k of PARAM_KEYS) expect(Number.isFinite(c[k]), `${k} 不是有限数`).toBe(true)
    expect(c.vibrance).toBe(0)
    expect(c.splitHiHue).toBe(0)
    expect(c.exposure).toBe(10)   // 老值照旧保留
  })

  it('toUnit：色相除以 360、其余除以 100', () => {
    const u = toUnit({ ...ZERO, splitHiHue: 180, splitAmount: 50, vibrance: -50, cbYellowBlue: 25 })
    expect(u.splitHiHue).toBeCloseTo(0.5)
    expect(u.splitAmount).toBeCloseTo(0.5)
    expect(u.vibrance).toBeCloseTo(-0.5)
    expect(u.cbYellowBlue).toBeCloseTo(0.25)
  })

  it('ZERO 有全部 15 个键、全是 0（新参数的中立点也是 0）', () => {
    for (const k of PARAM_KEYS) expect(ZERO[k]).toBe(0)
  })
})
