import { describe, it, expect } from 'vitest'
import { matchToReference, MATCH_JND, type Rgb } from './colorMatch'

/**
 * 一条灰阶。**故意用五档而不是一个色块**：单色块的明暗标准差是 0，
 * Reinhard 那一步要按标准差比例缩放，除数为 0 就没定义了 ——
 * 那是个要单独测的边界，不该混进"亮度"这条用例里。
 */
const RAMP: readonly Rgb[] = [
  [40, 40, 40], [90, 90, 90], [140, 140, 140], [190, 190, 190], [230, 230, 230],
]

/** 每个采样各加同样的量 —— 整体更亮，色彩分布不变。 */
const lift = (px: readonly Rgb[], by: number): Rgb[] =>
  px.map(([r, g, b]) => [r + by, g + by, b + by] as Rgb)

/** 暖一点：抬红压蓝，并拿绿补回亮度（0.2126·20 + 0.0722·(-20) = +2.8，绿补 -4）。 */
const warm = (px: readonly Rgb[]): Rgb[] =>
  px.map(([r, g, b]) => clamp([r + 20, g - 4, b - 20]))

/**
 * 一样暖，但**绿一个像素都不动**。
 *
 * 跟上面那个只差绿通道的 4 点，意义完全不同：色温那根滑块就是「红加、蓝减」，
 * 所以只有这一种是它能**原样表达**的。真实照片里的暖调（黄昏、暖咖）
 * 一定带绿分量的偏移，那是另一根轴的事 —— 见下面那条"够不着的"用例。
 */
const warmNeutral = (px: readonly Rgb[]): Rgb[] =>
  px.map(([r, g, b]) => clamp([r + 20, g, b - 20]))

/**
 * 品红一点：抬红抬蓝、压绿，亮度不变。
 * ⚠️ **这一根轴八个滑块表达不了** —— 色温是「红加、蓝减」，这里是「红加、蓝也加」，
 *    方向反着；而采样源是灰的（没有彩度），饱和度对灰像素是个空操作。
 *    所以它专门用来验"残差会不会诚实地说出做不到"。
 */
const magenta = (px: readonly Rgb[]): Rgb[] =>
  px.map(([r, g, b]) => clamp([r + 10, g - 4, b + 10]))

/** 淡一点：每个通道朝亮度收 60%。 */
const flatten = (px: readonly Rgb[]): Rgb[] =>
  px.map((px0) => {
    const l = luma(px0[0], px0[1], px0[2])
    return clamp([l + (px0[0] - l) * 0.4, l + (px0[1] - l) * 0.4, l + (px0[2] - l) * 0.4])
  })

/** 冲一点：绕中灰拉开 30%。 */
const punch = (px: readonly Rgb[]): Rgb[] =>
  px.map(([r, g, b]) => clamp([(r - 128) * 1.3 + 128, (g - 128) * 1.3 + 128, (b - 128) * 1.3 + 128]))

const clamp = (rgb: number[]): Rgb =>
  rgb.map(v => Math.max(0, Math.min(255, Math.round(v)))) as unknown as Rgb

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** 一组带彩度的采样 —— 测"色"那几根轴时用灰阶是测不出东西的。 */
const COLORS: readonly Rgb[] = [
  [180, 120, 90], [90, 130, 160], [120, 160, 110],
  [200, 190, 170], [70, 80, 95], [150, 140, 130],
]

describe('matchToReference', () => {
  it('参考图整体更亮时，亮度给正值', () => {
    const { params } = matchToReference(RAMP, lift(RAMP, 30))
    expect(params.exposure).toBeGreaterThan(0)
  })

  it('参考图更暖时，色温给正值', () => {
    const { params } = matchToReference(COLORS, warm(COLORS))
    expect(params.temperature).toBeGreaterThan(0)
  })

  it('参考图更淡时，饱和度给负值', () => {
    const { params } = matchToReference(COLORS, flatten(COLORS))
    expect(params.saturation).toBeLessThan(0)
  })

  it('参考图反差更大时，明暗那一组参数会动 —— 但不一定是「对比度」那一根', () => {
    // ⚠️ 实测（2026-10-02）：这一根**不是** `contrast`（它是 0）。
    //    我们对比度是 **sRGB 空间的线性拉伸**，而靶子（Reinhard）是 **Lab L 的线性拉伸**
    //    —— L 对 sRGB 是凹的，两者不等价。拟合于是拿高光/阴影把这条曲线掰过来，
    //    残差反而小得多（1.27 对只用四根参数时的 6.21）。所以这条只钉
    //    "明暗被动了"，**不钉是哪一根** —— 钉错了就是一条假的守卫。
    const { params } = matchToReference(COLORS, punch(COLORS))
    const moved = Math.abs(params.contrast) + Math.abs(params.highlights) + Math.abs(params.shadows)
    expect(moved).toBeGreaterThan(20)
  })

  it('拿它自己当参考图，八个参数一个都不动', () => {
    const { params, residual } = matchToReference(COLORS, COLORS)
    expect(params).toEqual({
      exposure: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, temperature: 0,
    })
    expect(residual).toBeLessThan(0.1)
  })

  it('返回的只有六个参数 —— 清晰度和暗角不在里面，就没人能顺手把它们清零', () => {
    const { params } = matchToReference(COLORS, COLORS)
    expect(Object.keys(params).sort()).toEqual(
      ['contrast', 'exposure', 'highlights', 'saturation', 'shadows', 'temperature'])
  })
})

describe('matchToReference 的边界', () => {
  it('八根滑块够得着的几种改动，都要做到肉眼看不出来', () => {
    // 反过来读这条：残差小 = 这几根轴确实够用。哪天真落在 2.3 以上，
    // 说明连"最简单"的风格迁移都做不满了，是个该被看见的退化。
    for (const [name, src, ref] of [
      ['整体更亮', RAMP, lift(RAMP, 30)],
      ['往蓝黄方向暖', COLORS, warmNeutral(COLORS)],
      ['更淡', COLORS, flatten(COLORS)],
      ['反差更大', COLORS, punch(COLORS)],
    ] as const) {
      const { residual } = matchToReference(src, ref)
      expect(residual, `${name} 的残差`).toBeLessThan(2.3)
    }
  })

  it('够不着的要给出数字，而且指得出是哪根轴', () => {
    // 实测（2026-10-02，六个参数全开）：
    //   带绿分量的暖 残差 3.20（其中 a 轴 3.02）· 品红 残差 9.28（a 轴 9.09）
    // 共同点：**残差几乎全部落在 a 轴**（绿↔品红），而八根滑块里没有这根轴。
    // 这两条不是"算法不够好"，是量出来的能力边界 —— 想让它们也变准，
    // 得往渲染管线里加一层真正的三通道变换，那是另一件事。
    for (const [name, src, ref] of [
      ['带绿分量的暖', COLORS, warm(COLORS)],
      ['品红', RAMP, magenta(RAMP)],
    ] as const) {
      const { residual, axis } = matchToReference(src, ref)
      expect(residual, `${name} 的残差`).toBeGreaterThan(2.3)
      expect(axis.a, `${name} 的 a 轴`).toBeGreaterThan(axis.l)
      expect(axis.a, `${name} 的 a 轴`).toBeGreaterThan(axis.b)
    }
  })

  it('搜索不能卡在局部最优 —— 「更淡」这种要贴到阈值以内', () => {
    // ★ 这条是有来历的：最初那版纯贪心搜索给出 3.99（对比度先去替颜色偏差背锅，
    //   然后再也退不回来），换成"全量程粗扫 + 先色后明暗"之后是 0.72。
    //   **阈值故意卡在 1.0**：旧的贪心 3.99、改到一半的版本 1.71，
    //   两个都会红 —— 只写 < 2.3 的话，旧版照样绿，这条就等于没写。
    const { residual } = matchToReference(COLORS, flatten(COLORS))
    expect(residual).toBeLessThan(1.0)
  })

  it('纯色块（标准差为 0）不炸，也不会返回 NaN', () => {
    const flat = (v: number): Rgb[] => [[v, v, v], [v, v, v]]
    const { params, residual } = matchToReference(flat(120), flat(160))
    for (const v of Object.values(params)) expect(Number.isFinite(v)).toBe(true)
    expect(Number.isFinite(residual)).toBe(true)
    expect(params.exposure).toBeGreaterThan(0)
  })

  it('空采样抛错 —— 宁可不给，也不返回一组假的参数', () => {
    expect(() => matchToReference([], COLORS)).toThrow()
    expect(() => matchToReference(COLORS, [])).toThrow()
  })

  it('黑底对白底的极端输入，参数仍在 [-100, 100] 内且都是有限数', () => {
    const black: Rgb[] = [[0, 0, 0], [8, 8, 8], [16, 16, 16]]
    const white: Rgb[] = [[240, 240, 240], [248, 248, 248], [255, 255, 255]]
    const { params, residual } = matchToReference(black, white)
    for (const v of Object.values(params)) {
      expect(Number.isFinite(v)).toBe(true)
      expect(Math.abs(v)).toBeLessThanOrEqual(100)
    }
    expect(Number.isFinite(residual)).toBe(true)
  })

  it('同样输入给同样结果（拟合不能带随机）', () => {
    const a = matchToReference(COLORS, warm(COLORS))
    const b = matchToReference(COLORS, warm(COLORS))
    expect(b).toEqual(a)
  })

  it('总残差和三个分轴对得上（平方和开根）', () => {
    const { residual, axis } = matchToReference(COLORS, warm(COLORS))
    expect(Math.hypot(axis.l, axis.a, axis.b)).toBeCloseTo(residual, 10)
  })

  it('肉眼阈值钉死在 2.3 —— 「这一版够不够用」的判据就是它，松了这条会红', () => {
    expect(MATCH_JND).toBe(2.3)
  })

  it('不改动入参', () => {
    const src = [...COLORS]
    const snapshot = JSON.stringify(src)
    matchToReference(src, COLORS)
    expect(JSON.stringify(src)).toBe(snapshot)
  })

  it('几千个采样点也照跑（内部会抽稀）', () => {
    const many: Rgb[] = Array.from({ length: 3000 }, (_, i) => RAMP[i % RAMP.length])
    const { params } = matchToReference(many, lift(many, 30))
    expect(params.exposure).toBeGreaterThan(0)
  })
})

