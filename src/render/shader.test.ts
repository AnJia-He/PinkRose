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

  it('sampler3D 必须带精度限定 —— 少了整个程序编译不过', () => {
    // ★ 2026-10-05 补，为的是一个**真机探针才抓到**的 bug：
    //   原来写的是 `uniform sampler3D uLut;`，ANGLE（Chromium 的 GL 后端，
    //   也就是真 Chrome 走的那条路）报 "'sampler3D' : No precision specified"，
    //   **整个 program 链接失败** —— 不只是滤镜坏：每一张照片都画不出来，
    //   屏幕上只有一句「画面出问题了」。
    //   根因：GLSL ES 3.00 只给 sampler2D / samplerCube 定了默认精度，
    //   sampler3D 这类没有，必须自己写（`highp sampler3D`）。
    //   这一条是**快**的那道哨兵（不用起服务器、不用真 GPU）；真机那道在
    //   scripts/check-lut.ts —— 它连的是"到底编译得过吗"。
    const decls = [...FRAGMENT_SRC.matchAll(/uniform\s+[^;]*?sampler3D[^;]*;/g)].map((m) => m[0])
    // 哨兵自己先别失效：哪天这句声明被改名/删掉，上面那个循环会空转、这一条会绿。
    expect(decls.length).toBeGreaterThan(0)
    for (const d of decls) {
      expect(d, `这句 sampler3D 声明少了精度限定：${d}`).toMatch(/\b(lowp|mediump|highp)\b/)
    }
  })

  it('GLSL 里不许出现非 ASCII —— 注释也算（真机驱动可能整段编译不过）', () => {
    // 不能先剥掉 `//` 整行注释再查：混中文最自然的写法就是整行注释，剥掉正好漏掉它。
    // 直接扫非 ASCII 字符，CJK、§、全角标点一视同仁；两份源码都扫。
    expect(/[^\x00-\x7F]/.test(FRAGMENT_SRC)).toBe(false)
    expect(/[^\x00-\x7F]/.test(VERTEX_SRC)).toBe(false)
  })
})
