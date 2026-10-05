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

  it('GLSL 里不许出现非 ASCII —— 注释也算（真机驱动可能整段编译不过）', () => {
    // 不能先剥掉 `//` 整行注释再查：混中文最自然的写法就是整行注释，剥掉正好漏掉它。
    // 直接扫非 ASCII 字符，CJK、§、全角标点一视同仁；两份源码都扫。
    expect(/[^\x00-\x7F]/.test(FRAGMENT_SRC)).toBe(false)
    expect(/[^\x00-\x7F]/.test(VERTEX_SRC)).toBe(false)
  })
})
