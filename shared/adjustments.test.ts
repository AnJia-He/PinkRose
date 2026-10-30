import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ZERO, PARAM_KEYS, PARAM_RANGE, PARAM_GROUPS, PARAM_LABELS,
  isChanged, clampAdjustments, applyDeltas, blendAdjustments, toUnit,
  HSL_BANDS, HSL_KEYS, CURVE_KEYS, RGB_CURVE_KEYS, type Adjustments,
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

describe('blendAdjustments（预设强度）', () => {
  const target = { ...ZERO, exposure: 40, contrast: -20, temperature: 30 }

  it('0 / 50 / 100 三档：不动 / 插值 / 原值', () => {
    expect(blendAdjustments(ZERO, target, 0)).toEqual(ZERO)
    expect(blendAdjustments(ZERO, target, 50)).toMatchObject({
      exposure: 20, contrast: -10, temperature: 15,
    })
    expect(blendAdjustments(ZERO, target, 100)).toEqual(target)
  })

  it('越界强度会钳制，不会把参数带出预设范围', () => {
    expect(blendAdjustments(ZERO, target, -20)).toEqual(ZERO)
    expect(blendAdjustments(ZERO, target, 180)).toEqual(target)
    expect(blendAdjustments(ZERO, target, Number.NaN)).toEqual(ZERO)
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

  it('★ 色温旁的色调是独立绿—洋红轴，0 = 不动', () => {
    expect(PARAM_LABELS.tint).toBe('色调')
    expect(PARAM_RANGE.tint).toEqual([-100, 100])
    expect(PARAM_KEYS.indexOf('tint')).toBe(PARAM_KEYS.indexOf('temperature') + 1)
    expect(toUnit({ ...ZERO, tint: 50 }).tint).toBe(0.5)
  })

  it('★ 黑白混色是独立的强度与红 / 绿 / 蓝权重', () => {
    expect(PARAM_LABELS.bwAmount).toBe('黑白强度')
    expect(PARAM_LABELS.bwRed).toBe('红色混色')
    expect(PARAM_RANGE.bwAmount).toEqual([0, 100])
    expect(PARAM_RANGE.bwRed).toEqual([-100, 100])
    const u = toUnit({ ...ZERO, bwAmount: 100, bwRed: 50, bwGreen: -25, bwBlue: 75 })
    expect(u.bwAmount).toBe(1)
    expect(u.bwRed).toBe(0.5)
    expect(u.bwGreen).toBe(-0.25)
    expect(u.bwBlue).toBe(0.75)
  })

  it('★ 四十八个通道各读各的字段（互不串位）', () => {
    // 每个通道喂一个互不相同的值：若映射写错（例如 clarity 读成 contrast、
    // 或者色相被除了 100 而不是 360），这条会立刻红。只抽样几个通道是抓不到串位的
    // —— 这条原来只抽样八个老的，2026-10-04 加参数时同步扩到十五个，
    // 2026-10-17 磨皮、细节组、HSL、曲线进来时同步扩到四十八个。
    const u = toUnit({
      ...ZERO,
      exposure: 10, contrast: 20, highlights: 30, shadows: 40,
      temperature: 50, vibrance: 60, saturation: 70,
      cbCyanRed: 80, cbMagentaGreen: 90, cbYellowBlue: 100,
      splitHiHue: 180, splitLoHue: 270, splitAmount: 25,
      clarity: 55, vignette: 65, skinSmooth: 45,
      sharpen: 35, noiseReduction: 25, grain: 15,
    })
    expect(u).toEqual({
      ...ZERO,
      exposure: 0.1, contrast: 0.2, highlights: 0.3, shadows: 0.4,
      temperature: 0.5, vibrance: 0.6, saturation: 0.7,
      cbCyanRed: 0.8, cbMagentaGreen: 0.9, cbYellowBlue: 1,
      splitHiHue: 0.5, splitLoHue: 0.75, splitAmount: 0.25,
      clarity: 0.55, vignette: 0.65, skinSmooth: 0.45,
      sharpen: 0.35, noiseReduction: 0.25, grain: 0.15,
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
  it('八十六个参数一个不少、一个不多', () => {
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
  it('PARAM_KEYS 是 94 个（含色调、黑白混色、锐化半径 / 蒙版、彩色降噪和三段色彩分级），而且顺序就是面板顺序', () => {
    expect(PARAM_KEYS).toEqual([
      'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
      'temperature', 'tint', 'vibrance', 'saturation',
      'bwAmount', 'bwRed', 'bwGreen', 'bwBlue',
      'cbCyanRed', 'cbMagentaGreen', 'cbYellowBlue',
      'splitHiHue', 'splitLoHue', 'splitAmount',
      'splitMidHue', 'splitMidAmount', 'splitBalance',
      'clarity', 'vignette', 'skinSmooth', 'dehaze', 'hdr', 'glow',
      'texture', 'sharpen', 'sharpenRadius', 'sharpenMasking',
      'noiseReduction', 'colorNoiseReduction', 'grain',
      ...HSL_KEYS,
      ...CURVE_KEYS,
      ...RGB_CURVE_KEYS,
      'skinBrighten', 'skinRosy',
      'perspectiveV', 'perspectiveH',
      'lensBlur', 'lensRange', 'lensFeather', 'lensFocusX', 'lensFocusY',
      'lensShape', 'lensAngle',
      'lensDistortion', 'lensChromatic', 'lensVignette',
    ])
  })

  it('每个键都有一行范围、一个界面名，而且分组顺序就是 PARAM_KEYS 顺序', () => {
    for (const k of PARAM_KEYS) {
      expect(PARAM_RANGE[k], `${k} 没有范围`).toBeTruthy()
      expect(PARAM_LABELS[k], `${k} 没有界面名`).toBeTruthy()
    }
    // ★ 2026-10-04 终审勘误：原来两边各 `sort()` 一次 = 只钉了**集合相等** ——
    // 组里把参数换个次序（面板顺序 ≠ `PARAM_KEYS` 顺序）它照样绿，而
    // `shared/adjustments.ts` 那三条注释都写着"顺序 = 面板顺序 = 显示顺序"。
    // 去掉 sort 逐序比：顺序一漂当场红（不重不漏顺带仍在其中）。
    expect(PARAM_GROUPS.flatMap(g => g.keys)).toEqual([...PARAM_KEYS])
  })

  it('色相是 0~360、强度/磨皮/细节是 0~100，其余仍是 -100~100', () => {
    expect(PARAM_RANGE.splitHiHue).toEqual([0, 360])
    expect(PARAM_RANGE.splitLoHue).toEqual([0, 360])
    expect(PARAM_RANGE.splitMidHue).toEqual([0, 360])
    expect(PARAM_RANGE.splitAmount).toEqual([0, 100])
    expect(PARAM_RANGE.splitMidAmount).toEqual([0, 100])
    expect(PARAM_RANGE.splitBalance).toEqual([-100, 100])
    // ★ 2026-10-17：磨皮只有正的（0 = 没磨）—— 负值会被钳回 0
    expect(PARAM_RANGE.skinSmooth).toEqual([0, 100])
    // ★ 2026-10-17（去雾）：正负是两个相反方向
    expect(PARAM_RANGE.dehaze).toEqual([-100, 100])
    // ★ 2026-10-18（HDR）：只有正的
    expect(PARAM_RANGE.hdr).toEqual([0, 100])
    // ★ 2026-10-18（柔光）：只有正的
    expect(PARAM_RANGE.glow).toEqual([0, 100])
    // ★ 2026-10-17（细节组）：三条也只有正的，0 = 没做
    expect(PARAM_RANGE.sharpen).toEqual([0, 100])
    expect(PARAM_RANGE.sharpenRadius).toEqual([0, 100])
    expect(PARAM_RANGE.sharpenMasking).toEqual([0, 100])
    expect(PARAM_RANGE.noiseReduction).toEqual([0, 100])
    expect(PARAM_RANGE.colorNoiseReduction).toEqual([0, 100])
    expect(PARAM_RANGE.grain).toEqual([0, 100])
    expect(PARAM_RANGE.vibrance).toEqual([-100, 100])
    expect(PARAM_RANGE.cbCyanRed).toEqual([-100, 100])
    expect(PARAM_RANGE.whites).toEqual([-100, 100])
    expect(PARAM_RANGE.blacks).toEqual([-100, 100])
    expect(PARAM_RANGE.texture).toEqual([-100, 100])
    expect(PARAM_RANGE.lensShape).toEqual([0, 100])
    expect(PARAM_RANGE.lensAngle).toEqual([-100, 100])
  })

  it('clamp 按各自的范围钳（色相不会被钳成 100）', () => {
    const c = clampAdjustments({
      ...ZERO, splitHiHue: 400, splitLoHue: -20, splitAmount: 300,
      splitMidHue: 400, splitMidAmount: 300, splitBalance: -300, cbCyanRed: 999,
      skinSmooth: -5, dehaze: 150, hdr: 150, glow: 150,
      whites: 400, blacks: -400, texture: 400,
      sharpen: -5, sharpenRadius: 200, sharpenMasking: -5,
      noiseReduction: 200, colorNoiseReduction: 200, grain: -1,
    })
    expect(c.splitHiHue).toBe(360)
    expect(c.splitLoHue).toBe(0)
    expect(c.splitMidHue).toBe(360)
    expect(c.splitAmount).toBe(100)
    expect(c.splitMidAmount).toBe(100)
    expect(c.splitBalance).toBe(-100)
    expect(c.cbCyanRed).toBe(100)
    // ★ 磨皮没有负值：模型给「少磨一点」的负增量，落下来最多到 0
    expect(c.skinSmooth).toBe(0)
    expect(c.dehaze).toBe(100)
    expect(c.hdr).toBe(100)
    expect(c.glow).toBe(100)
    expect(c.whites).toBe(100)
    expect(c.blacks).toBe(-100)
    expect(c.texture).toBe(100)
    expect(c.sharpen).toBe(0)
    expect(c.sharpenRadius).toBe(100)
    expect(c.sharpenMasking).toBe(0)
    expect(c.noiseReduction).toBe(100)
    expect(c.colorNoiseReduction).toBe(100)
    expect(c.grain).toBe(0)
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
    const u = toUnit({
      ...ZERO, splitHiHue: 180, splitLoHue: 90, splitMidHue: 270,
      splitAmount: 50, splitMidAmount: 25, splitBalance: -30,
      vibrance: -50, cbYellowBlue: 25,
    })
    expect(u.splitHiHue).toBeCloseTo(0.5)
    expect(u.splitLoHue).toBeCloseTo(0.25)
    expect(u.splitMidHue).toBeCloseTo(0.75)
    expect(u.splitAmount).toBeCloseTo(0.5)
    expect(u.splitMidAmount).toBeCloseTo(0.25)
    expect(u.splitBalance).toBeCloseTo(-0.3)
    expect(u.vibrance).toBeCloseTo(-0.5)
    expect(u.cbYellowBlue).toBeCloseTo(0.25)
  })

  it('★ 去雾 -100~100 → -1~1', () => {
    expect(toUnit({ ...ZERO, dehaze: 34 }).dehaze).toBeCloseTo(0.34)
    expect(toUnit({ ...ZERO, dehaze: -60 }).dehaze).toBeCloseTo(-0.6)
  })

  it('★ HDR / 柔光 0~100 → 0~1', () => {
    expect(toUnit({ ...ZERO, hdr: 45 }).hdr).toBeCloseTo(0.45)
    expect(toUnit({ ...ZERO, glow: 40 }).glow).toBeCloseTo(0.4)
    expect(toUnit({ ...ZERO, whites: 25, blacks: -35, texture: 45 }).whites).toBeCloseTo(0.25)
    expect(toUnit({ ...ZERO, whites: 25, blacks: -35, texture: 45 }).blacks).toBeCloseTo(-0.35)
    expect(toUnit({ ...ZERO, whites: 25, blacks: -35, texture: 45 }).texture).toBeCloseTo(0.45)
    expect(toUnit({ ...ZERO, colorNoiseReduction: 55 }).colorNoiseReduction).toBeCloseTo(0.55)
  })

  it('ZERO 有全部 81 个键、全是 0（新参数的中立点也是 0）', () => {
    for (const k of PARAM_KEYS) expect(ZERO[k]).toBe(0)
  })
})

describe('HSL 分色（2026-10-17）', () => {
  /**
   * 八条色带 × 三轴 = 24 个数字。色带顺序就是面板上的顺序，
   * 也是 `PARAM_KEYS` 末尾的顺序；老 19 个参数一个都不许动。
   */
  it('★ 追加 24 个通道，顺序是 红橙黄绿青蓝紫洋红 × 色相/饱和/明度', () => {
    expect(PARAM_KEYS.slice(36, 60)).toEqual([...HSL_KEYS])
    expect(PARAM_KEYS).toHaveLength(94)
    expect(HSL_BANDS.flatMap(b => b.keys)).toEqual([...HSL_KEYS])
  })

  it('每条色带的三个键都有 0~100 范围（-100 到 100）和唯一中文名', () => {
    for (const k of HSL_KEYS) {
      expect(PARAM_RANGE[k]).toEqual([-100, 100])
      expect(PARAM_LABELS[k]).toBeTruthy()
      expect(ZERO[k]).toBe(0)
    }
    expect(new Set(HSL_KEYS.map(k => PARAM_LABELS[k])).size).toBe(24)
  })

  it('toUnit 逐通道除以 100，不串位', () => {
    const u = toUnit({
      ...ZERO,
      hslRedHue: 40,
      hslGreenSat: -30,
      hslBlueLum: 20,
    })
    expect(u.hslRedHue).toBeCloseTo(0.4)
    expect(u.hslGreenSat).toBeCloseTo(-0.3)
    expect(u.hslBlueLum).toBeCloseTo(0.2)
  })
})

describe('影调曲线（2026-10-17）', () => {
  const CURVE_KEYS = [
    'curveBlack', 'curveShadows', 'curveMidtones', 'curveHighlights', 'curveWhite',
  ] as const

  it('★ 五个整体曲线控制点在 HSL 之后、RGB 曲线之前，总参数 94 个', () => {
    expect(PARAM_KEYS.slice(60, 65)).toEqual([...CURVE_KEYS])
    expect(PARAM_KEYS).toHaveLength(94)
  })

  it('每个控制点都有范围 / 中文名 / 中立点 0', () => {
    for (const k of CURVE_KEYS) {
      expect(PARAM_RANGE[k]).toEqual([-100, 100])
      expect(PARAM_LABELS[k]).toBeTruthy()
      expect(ZERO[k]).toBe(0)
    }
  })

  it('toUnit 逐项除以 100', () => {
    const u = toUnit({
      ...ZERO,
      curveBlack: 20,
      curveMidtones: -50,
      curveWhite: -80,
    })
    expect(u.curveBlack).toBeCloseTo(0.2)
    expect(u.curveMidtones).toBeCloseTo(-0.5)
    expect(u.curveWhite).toBeCloseTo(-0.8)
  })
})

describe('RGB 分通道曲线（2026-10-18）', () => {
  it('★ 红 / 绿 / 蓝各五个控制点，紧跟在整体曲线之后', () => {
    expect(PARAM_KEYS.slice(65, 80)).toEqual([...RGB_CURVE_KEYS])
    expect(PARAM_KEYS).toHaveLength(94)
    expect(RGB_CURVE_KEYS).toHaveLength(15)
  })

  it('15 个键都有范围 / 中文名 / 中立点 0，toUnit 各走各的', () => {
    for (const k of RGB_CURVE_KEYS) {
      expect(PARAM_RANGE[k]).toEqual([-100, 100])
      expect(PARAM_LABELS[k]).toBeTruthy()
      expect(ZERO[k]).toBe(0)
    }
    const u = toUnit({ ...ZERO, curveRedMidtones: 50, curveGreenShadows: -25, curveBlueWhite: -80 })
    expect(u.curveRedMidtones).toBeCloseTo(0.5)
    expect(u.curveGreenShadows).toBeCloseTo(-0.25)
    expect(u.curveBlueWhite).toBeCloseTo(-0.8)
  })
})

describe('美颜（2026-10-17）', () => {
  const SKIN_KEYS = ['skinBrighten', 'skinRosy'] as const

  it('★ 两个美颜参数在 RGB 曲线之后、几何之前，总参数 94 个', () => {
    expect(PARAM_KEYS.slice(80, 82)).toEqual([...SKIN_KEYS])
    expect(PARAM_KEYS).toHaveLength(94)
  })

  it('美白 / 红润都是 0~100，中立点 0', () => {
    for (const k of SKIN_KEYS) {
      expect(PARAM_RANGE[k]).toEqual([0, 100])
      expect(PARAM_LABELS[k]).toBeTruthy()
      expect(ZERO[k]).toBe(0)
    }
  })

  it('toUnit 逐项除以 100', () => {
    const u = toUnit({ ...ZERO, skinBrighten: 35, skinRosy: 20 })
    expect(u.skinBrighten).toBeCloseTo(0.35)
    expect(u.skinRosy).toBeCloseTo(0.2)
  })
})

describe('几何透视（2026-10-17）', () => {
  it('★ 两个透视参数在美颜之后、镜头之前，都是 -100~100，分组叫「几何」', () => {
    expect(PARAM_KEYS.slice(82, 84)).toEqual(['perspectiveV', 'perspectiveH'])
    for (const k of ['perspectiveV', 'perspectiveH'] as const) {
      expect(PARAM_RANGE[k]).toEqual([-100, 100])
      expect(PARAM_LABELS[k]).toBeTruthy()
      expect(ZERO[k]).toBe(0)
    }
    expect(PARAM_GROUPS.at(-3)).toEqual({
      id: 'geometry', title: '几何', keys: ['perspectiveV', 'perspectiveH'],
    })
  })

  it('toUnit 逐项除以 100', () => {
    const u = toUnit({ ...ZERO, perspectiveV: 40, perspectiveH: -25 })
    expect(u.perspectiveV).toBeCloseTo(0.4)
    expect(u.perspectiveH).toBeCloseTo(-0.25)
  })
})

describe('镜头虚化与校正（2026-10-17）', () => {
  it('★ 镜头参数追加在最后，虚化（含焦点）和校正分成两组', () => {
    expect(PARAM_KEYS.slice(84)).toEqual([
      'lensBlur', 'lensRange', 'lensFeather', 'lensFocusX', 'lensFocusY',
      'lensShape', 'lensAngle',
      'lensDistortion', 'lensChromatic', 'lensVignette',
    ])
    expect(PARAM_RANGE.lensBlur).toEqual([0, 100])
    expect(PARAM_RANGE.lensRange).toEqual([-100, 100])
    expect(PARAM_RANGE.lensFeather).toEqual([-100, 100])
    expect(PARAM_RANGE.lensFocusX).toEqual([-100, 100])
    expect(PARAM_RANGE.lensFocusY).toEqual([-100, 100])
    expect(PARAM_RANGE.lensDistortion).toEqual([-100, 100])
    expect(PARAM_RANGE.lensChromatic).toEqual([-100, 100])
    expect(PARAM_GROUPS.at(-2)).toEqual({
      id: 'lens', title: '镜头',
      keys: [
        'lensBlur', 'lensRange', 'lensFeather', 'lensFocusX', 'lensFocusY',
        'lensShape', 'lensAngle',
      ],
    })
    expect(PARAM_GROUPS.at(-1)).toEqual({
      id: 'lensFix', title: '镜头校正',
      keys: ['lensDistortion', 'lensChromatic', 'lensVignette'],
    })
  })

  it('toUnit 逐项除以 100', () => {
    const u = toUnit({
      ...ZERO, lensBlur: 70, lensRange: -30, lensFeather: 20,
      lensFocusX: 40, lensFocusY: -60,
    })
    expect(u.lensBlur).toBeCloseTo(0.7)
    expect(u.lensRange).toBeCloseTo(-0.3)
    expect(u.lensFeather).toBeCloseTo(0.2)
    expect(u.lensFocusX).toBeCloseTo(0.4)
    expect(u.lensFocusY).toBeCloseTo(-0.6)
  })

  it('镜头校正两项也是 -100~100 → -1~1，默认 0', () => {
    expect(ZERO.lensDistortion).toBe(0)
    expect(ZERO.lensChromatic).toBe(0)
    const u = toUnit({ ...ZERO, lensDistortion: 35, lensChromatic: -20 })
    expect(u.lensDistortion).toBeCloseTo(0.35)
    expect(u.lensChromatic).toBeCloseTo(-0.2)
  })
})
