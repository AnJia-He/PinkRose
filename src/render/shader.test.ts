import { describe, it, expect } from 'vitest'
import { FRAGMENT_SRC, VERTEX_SRC } from './shader.ts'

/**
 * 管线顺序是**契约**（设计 §4.1）：改了 = 所有老作品点开时颜色都变。
 * 这里钉的是"LUT 那一段在暗角之后、fragColor 之前" —— 源码级的哨兵，
 * 真机的数值复核在 scripts/check-lut.ts（Task 13）。
 */
describe('管线顺序', () => {
  it('LUT 排在暗角之后、出图之前', () => {
    const vig = FRAGMENT_SRC.indexOf('uVignette * dot(d, d)')
    const lut = FRAGMENT_SRC.indexOf('texture(uLut')
    const out = FRAGMENT_SRC.indexOf('fragColor = vec4')
    expect(vig).toBeGreaterThan(-1)
    expect(lut).toBeGreaterThan(vig)
    expect(out).toBeGreaterThan(lut)
  })

  it('强度 0 时那一整段都不产生作用（mix 的第三参来自 uLutOn * uLutAmount）', () => {
    expect(FRAGMENT_SRC).toMatch(/uLutOn\s*\*\s*uLutAmount/)
  })

  it('uniform 里的采样器都得带精度限定 —— 除 sampler2D / samplerCube 外没有默认精度', () => {
    // ★ 2026-10-05 补，为的是一个**真机探针才抓到**的 bug：
    //   原来写的是 `uniform sampler3D uLut;`，ANGLE（Chromium 的 GL 后端，
    //   也就是真 Chrome 走的那条路）报 "'sampler3D' : No precision specified"，
    //   **整个 program 链接失败** —— 不只是滤镜坏：每一张照片都画不出来，
    //   屏幕上只有一句「画面出问题了」。
    //   根因：GLSL ES 3.00 **只给 sampler2D / samplerCube 定了默认精度**，
    //   其余采样器类型（sampler3D / sampler2DArray / 各种 shadow / i·u 前缀的）
    //   必须自己写。所以这一条**按类型泛化**，不只拉黑 sampler3D ——
    //   同一个坑换个类型就是同一个 bug（审查 Minor 指的是这一条）。
    //   ⚠️ 豁免清单要**整词相等**：写成裸 `sampler2D` 会前缀匹配上 sampler2DArray，
    //      而后者恰恰是要查的那个。
    //   这一条是**快**的那道哨兵（不用起服务器、不用真 GPU）；真机那道在
    //   scripts/check-lut.ts —— 它连的是"到底编译得过吗"。两份源码都扫。
    const HAS_DEFAULT_PRECISION = new Set(['sampler2D', 'samplerCube'])
    const found: { where: string; decl: string; type: string }[] = []
    for (const [where, src] of [['片段', FRAGMENT_SRC], ['顶点', VERTEX_SRC]] as const) {
      for (const m of src.matchAll(/uniform\s+([^;]*);/g)) {
        const type = m[1]!.trim().split(/\s+/).find((t) => /^[iu]?sampler\w*$/.test(t))
        if (type) found.push({ where, decl: m[0].trim(), type })
      }
    }
    // 哨兵自己先别失效：哪天采样器声明被改名/删光，下面的循环会空转、这一条会绿。
    expect(found.some((d) => !HAS_DEFAULT_PRECISION.has(d.type))).toBe(true)
    for (const d of found) {
      // 豁免的那两种（sampler2D / samplerCube）两种源码里都有合法默认精度。
      if (HAS_DEFAULT_PRECISION.has(d.type)) continue
      expect(d.decl, `${d.where}源码里这句 ${d.type} 声明少了精度限定：${d.decl}`)
        .toMatch(/\b(lowp|mediump|highp)\b/)
    }
  })

  it('GLSL 里不许出现非 ASCII —— 注释也算（真机驱动可能整段编译不过）', () => {
    // 不能先剥掉 `//` 整行注释再查：混中文最自然的写法就是整行注释，剥掉正好漏掉它。
    // 直接扫非 ASCII 字符，CJK、§、全角标点一视同仁；两份源码都扫。
    expect(/[^\x00-\x7F]/.test(FRAGMENT_SRC)).toBe(false)
    expect(/[^\x00-\x7F]/.test(VERTEX_SRC)).toBe(false)
  })
})
