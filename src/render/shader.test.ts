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

  it('★ 磨皮（2026-10-17）：在清晰度之后、色温之前，强度 0 时恒等', () => {
    // 顺序是契约的一半："磨皮和清晰度都吃原始纹理"（都在色调链之前）——
    // 放到色温之后的话，平滑采样拿到的是原图、而 `c` 已经调过色，
    // mix 会把一圈"整体明暗差"糊进皮肤里（和 clarity 那条注释同一个坑）。
    const clarity = FRAGMENT_SRC.indexOf('uClarity * 0.6')
    const skin = FRAGMENT_SRC.indexOf('uSkinSmooth > 0.0')
    const temp = FRAGMENT_SRC.indexOf('uTemperature * 0.10')
    expect(clarity).toBeGreaterThan(-1)
    expect(skin).toBeGreaterThan(clarity)
    expect(temp).toBeGreaterThan(skin)
    // 恒等：混合系数必须是 `uSkinSmooth * skin`（肤色权重）的那一份 ——
    // 少了 uSkinSmooth，磨皮会变成"永远全开"；少了 skin，整张背景都会糊。
    // 高反差边缘（睫毛 / 眉毛 / 发丝 / 唇线）再乘一道保护系数。
    expect(FRAGMENT_SRC).toMatch(/float amount = uSkinSmooth \* skin \* 0\.9 \* \(1\.0 - 0\.85 \* edge\)/)
    expect(FRAGMENT_SRC).toMatch(/mix\(c, soft, amount\)/)
    expect(FRAGMENT_SRC).toContain('float maxDiff = 0.0')
    expect(FRAGMENT_SRC).toContain('float edge = smoothstep(0.055, 0.20, maxDiff)')
    // 采样只让"像皮肤"的邻居投票：棕发和肤色在 Cb/Cr 上会重叠。
    expect(FRAGMENT_SRC).toContain('(0.12 + 0.88 * sampleSkin)')
    expect(FRAGMENT_SRC).toContain('float skinWeight(vec3 rgb)')
  })

  it('★ 细节组（2026-10-17）：降噪、锐化都在肤色之后、色温之前，强度 0 时恒等', () => {
    // 降噪和锐化都吃原始纹理，必须和清晰度/磨皮在同一段（色调链之前）——
    // 放到色温之后的话，采样拿到的是原图、而 `c` 已经调过色，会引入整体明暗差。
    const skin = FRAGMENT_SRC.indexOf('uSkinSmooth > 0.0')
    const denoise = FRAGMENT_SRC.indexOf('uNoiseReduction > 0.0')
    const sharpen = FRAGMENT_SRC.indexOf('uSharpen > 0.0')
    const texture = FRAGMENT_SRC.indexOf('abs(uTexture) > 1e-5')
    const temp = FRAGMENT_SRC.indexOf('uTemperature * 0.10')
    expect(skin).toBeGreaterThan(-1)
    expect(texture).toBeGreaterThan(skin)
    expect(denoise).toBeGreaterThan(texture)
    expect(sharpen).toBeGreaterThan(denoise)
    expect(temp).toBeGreaterThan(sharpen)
    // 恒等：两个强度都只出现在混合系数 / 增量系数里，0 时整段不改变 c。
    expect(FRAGMENT_SRC).toMatch(/mix\(c, nr \/ nrW, uNoiseReduction \* 0\.8\)/)
    expect(FRAGMENT_SRC).toMatch(/\(base - sharpBlur\) \* uSharpen \* 1\.1/)
    expect(FRAGMENT_SRC).toMatch(/\(base - texBlur\) \* uTexture \* 0\.55/)
  })

  it('★ 色调：色温之后、色彩平衡之前，绿—洋红轴保持亮度', () => {
    const temperature = FRAGMENT_SRC.indexOf('c.b -= uTemperature * 0.10')
    const tint = FRAGMENT_SRC.indexOf('c.g -= uTint * 0.035')
    const balance = FRAGMENT_SRC.indexOf('c.r += uCbCyanRed * 0.10')
    expect(tint).toBeGreaterThan(temperature)
    expect(balance).toBeGreaterThan(tint)
    expect(FRAGMENT_SRC).toContain('c.r += uTint * 0.09')
    expect(FRAGMENT_SRC).toContain('c.b += uTint * 0.09')
  })

  it('★ 白色 / 黑色色阶（2026-10-19）：在阴影之后、对比度之前，0 时恒等', () => {
    const shadows = FRAGMENT_SRC.indexOf('float loW =')
    const whites = FRAGMENT_SRC.indexOf('float whiteW =')
    const contrast = FRAGMENT_SRC.indexOf('(c - 0.5) * (1.0 + uContrast)')
    expect(whites).toBeGreaterThan(shadows)
    expect(contrast).toBeGreaterThan(whites)
    for (const n of ['uWhites', 'uBlacks', 'uTexture']) {
      expect(FRAGMENT_SRC).toContain(n)
    }
    expect(FRAGMENT_SRC).toMatch(/uWhites\s*\n\s*\* \(0\.05 \+ 0\.95 \* \(1\.0 - lw\)\) \* 1\.2/)
    expect(FRAGMENT_SRC).toMatch(/uBlacks\s*\n\s*\* \(0\.05 \+ 0\.95 \* lw\) \* 1\.2/)
  })

  it('★ 去雾（2026-10-17）：在对比度之后、饱和度之前，0 时整段跳过', () => {
    const contrast = FRAGMENT_SRC.indexOf('(c - 0.5) * (1.0 + uContrast)')
    const dehaze = FRAGMENT_SRC.indexOf('abs(uDehaze) > 1e-5')
    const saturation = FRAGMENT_SRC.indexOf('c = vec3(l2) + (c - vec3(l2))')
    expect(contrast).toBeGreaterThan(-1)
    expect(dehaze).toBeGreaterThan(contrast)
    expect(saturation).toBeGreaterThan(dehaze)
    // 正负两个方向都真的落地：正值走局部暗通道拉伸，负值混入冷色空气层。
    expect(FRAGMENT_SRC).toContain('float dark = min(min(dc.r, dc.g), dc.b)')
    expect(FRAGMENT_SRC).toMatch(/c = \(c - vec3\(0\.05 \* uDehaze \* haze\)\)/)
    expect(FRAGMENT_SRC).toMatch(/mix\(c, vec3\(0\.82, 0\.86, 0\.92\), \(-uDehaze\) \* 0\.35\)/)
  })

  it('★ HDR（2026-10-18）：在镜头虚化之后、色温之前，0 时整段跳过', () => {
    const lens = FRAGMENT_SRC.indexOf('uLensBlur > 0.0')
    const hdr = FRAGMENT_SRC.indexOf('uHdr > 0.0')
    const temp = FRAGMENT_SRC.indexOf('uTemperature * 0.10')
    expect(hdr).toBeGreaterThan(lens)
    expect(temp).toBeGreaterThan(hdr)
    expect(FRAGMENT_SRC).toContain('float lift = uHdr * (1.0 - smoothstep(0.0, 0.45, local)) * 0.18')
    expect(FRAGMENT_SRC).toContain('float comp = uHdr * smoothstep(0.55, 1.0, local) * 0.18')
    expect(FRAGMENT_SRC).toMatch(/c \+= \(c - blur\) \* uHdr \* 0\.35/)
  })

  it('★ 柔光（2026-10-18）：在 HDR 之后、色温之前，0 时整段跳过', () => {
    const hdr = FRAGMENT_SRC.indexOf('uHdr > 0.0')
    const glow = FRAGMENT_SRC.indexOf('uGlow > 0.0')
    const temp = FRAGMENT_SRC.indexOf('uTemperature * 0.10')
    expect(glow).toBeGreaterThan(hdr)
    expect(temp).toBeGreaterThan(glow)
    expect(FRAGMENT_SRC).toContain('max(halo - vec3(0.30), vec3(0.0)) * uGlow * gate * 0.9')
    expect(FRAGMENT_SRC).toContain('clamp(shortSide * 0.02, 3.0, 24.0)')
    expect(FRAGMENT_SRC).toContain('mix(avg, hmax, 0.5)')
    expect(FRAGMENT_SRC).toMatch(/1\.0 - \(1\.0 - c\) \* \(1\.0 - bloom\)/)
  })

  it('★ 颗粒（2026-10-17）：在暗角之后、LUT 之前（LUT 仍是最后一步）', () => {
    const vig = FRAGMENT_SRC.indexOf('uVignette * dot(d, d)')
    const grain = FRAGMENT_SRC.indexOf('uGrain > 0.0')
    const lut = FRAGMENT_SRC.indexOf('texture(uLut')
    expect(vig).toBeGreaterThan(-1)
    expect(grain).toBeGreaterThan(vig)
    expect(lut).toBeGreaterThan(grain)
    expect(FRAGMENT_SRC).toMatch(/\(gn - 0\.5\) \* uGrain \* 0\.12/)
  })

  it('★ 彩色降噪：只混色度、保留亮度，0 时整段跳过', () => {
    const denoise = FRAGMENT_SRC.indexOf('uNoiseReduction > 0.0')
    const chroma = FRAGMENT_SRC.indexOf('uColorNoiseReduction > 0.0')
    const sharpen = FRAGMENT_SRC.indexOf('uSharpen > 0.0')
    expect(chroma).toBeGreaterThan(denoise)
    expect(sharpen).toBeGreaterThan(chroma)
    expect(FRAGMENT_SRC).toContain('baseChroma')
    expect(FRAGMENT_SRC).toMatch(/c \+= \(blurChroma - baseChroma\) \* uColorNoiseReduction/)
  })

  it('★ 锐化半径与边缘蒙版：扩大采样半径，并只放行明显边缘', () => {
    const chroma = FRAGMENT_SRC.indexOf('uColorNoiseReduction > 0.0')
    const sharpen = FRAGMENT_SRC.indexOf('uSharpen > 0.0')
    expect(sharpen).toBeGreaterThan(chroma)
    expect(FRAGMENT_SRC).toContain('uSharpenRadius')
    expect(FRAGMENT_SRC).toContain('uSharpenMasking')
    expect(FRAGMENT_SRC).toMatch(/1\.0 \+ uSharpenRadius \* 2\.5/)
    expect(FRAGMENT_SRC).toContain('sharpGate')
  })

  it('★ HSL（2026-10-17）：有总开关，且在分离色调之前；0 时整段跳过', () => {
    const hsl = FRAGMENT_SRC.indexOf('uHslOn > 0.0')
    // 找**使用点**而不是 uniform 声明（声明在文件顶部，永远在 HSL 之前）。
    const split = FRAGMENT_SRC.indexOf('uSplitHiHue)')
    expect(hsl).toBeGreaterThan(-1)
    expect(split).toBeGreaterThan(hsl)
    // 八条色带的三根轴都得在源码里真的被读到，不能只加个空壳。
    for (const n of [
      'uHslRedHue', 'uHslOrangeSat', 'uHslYellowLum', 'uHslGreenHue',
      'uHslCyanSat', 'uHslBlueLum', 'uHslPurpleHue', 'uHslMagentaSat',
    ]) {
      expect(FRAGMENT_SRC).toContain(n)
    }
  })

  it('★ 黑白混色：在 HSL 之后、曲线之前，0 时整段跳过', () => {
    const hsl = FRAGMENT_SRC.indexOf('uHslOn > 0.0')
    const bw = FRAGMENT_SRC.indexOf('uBwAmount > 1e-5')
    const curve = FRAGMENT_SRC.indexOf('uCurveOn > 0.0')
    expect(bw).toBeGreaterThan(hsl)
    expect(curve).toBeGreaterThan(bw)
    expect(FRAGMENT_SRC).toContain('pow(vec3(2.0), vec3(uBwRed, uBwGreen, uBwBlue))')
    expect(FRAGMENT_SRC).toMatch(/c = mix\(c, vec3\(bw\), uBwAmount\)/)
  })

  it('★ 曲线（2026-10-17）：在 HSL 之后、分离色调之前，有总开关', () => {
    const hsl = FRAGMENT_SRC.indexOf('uHslOn > 0.0')
    const curve = FRAGMENT_SRC.indexOf('uCurveOn > 0.0')
    const split = FRAGMENT_SRC.indexOf('uSplitHiHue)')
    expect(curve).toBeGreaterThan(hsl)
    expect(split).toBeGreaterThan(curve)
    for (const n of [
      'uCurveBlack', 'uCurveShadows', 'uCurveMidtones', 'uCurveHighlights', 'uCurveWhite',
    ]) {
      expect(FRAGMENT_SRC).toContain(n)
    }
  })

  it('★ RGB 曲线（2026-10-18）：整体曲线之后、美颜之前，0 时整段跳过', () => {
    const master = FRAGMENT_SRC.indexOf('uCurveOn > 0.0')
    const rgb = FRAGMENT_SRC.indexOf('uCurveRgbOn > 0.0')
    const beauty = FRAGMENT_SRC.indexOf('uSkinBrighten * 0.35')
    expect(rgb).toBeGreaterThan(master)
    expect(beauty).toBeGreaterThan(rgb)
    expect(FRAGMENT_SRC).toMatch(/c\.r = curveRedAt\(clamp\(c\.r, 0\.0, 1\.0\)\)/)
    expect(FRAGMENT_SRC).toMatch(/c\.g = curveGreenAt\(clamp\(c\.g, 0\.0, 1\.0\)\)/)
    expect(FRAGMENT_SRC).toMatch(/c\.b = curveBlueAt\(clamp\(c\.b, 0\.0, 1\.0\)\)/)
    for (const n of [
      'uCurveRedMidtones', 'uCurveGreenShadows', 'uCurveBlueHighlights',
    ]) expect(FRAGMENT_SRC).toContain(n)
  })

  it('★ 美颜（2026-10-17）：美白 / 红润在曲线之后、分离色调之前，0 时恒等', () => {
    const curve = FRAGMENT_SRC.indexOf('uCurveOn > 0.0')
    // 找**应用段**而不是肤色蒙版的 if（蒙版在曲线之前就会读这两个 uniform）。
    const beauty = FRAGMENT_SRC.indexOf('uSkinBrighten * 0.35')
    const split = FRAGMENT_SRC.indexOf('uSplitHiHue)')
    expect(beauty).toBeGreaterThan(curve)
    expect(split).toBeGreaterThan(beauty)
    expect(FRAGMENT_SRC).toContain('uSkinRosy')
    expect(FRAGMENT_SRC).toMatch(/uSkinBrighten \* 0\.35/)
  })

  it('★ 三段色彩分级：中间调与明暗平衡在分离色调段内生效', () => {
    const split = FRAGMENT_SRC.indexOf('uSplitHiHue)')
    const mid = FRAGMENT_SRC.indexOf('uSplitMidHue)')
    const balance = FRAGMENT_SRC.indexOf('uSplitBalance')
    const vignette = FRAGMENT_SRC.indexOf('uVignette * dot(d, d)')
    expect(mid).toBeGreaterThan(split)
    expect(balance).toBeGreaterThan(-1)
    expect(vignette).toBeGreaterThan(mid)
    expect(FRAGMENT_SRC).toContain('uSplitMidAmount')
    expect(FRAGMENT_SRC).toMatch(/1\.0 - abs\(toneL \* 2\.0 - 1\.0\)/)
  })

  it('★ 几何透视（2026-10-17）：先改采样坐标，暗角仍用输出坐标，0 时恒等', () => {
    // 透视改的是"每个输出像素去原始纹理哪里取样"，必须排在所有采样之前。
    const sample = FRAGMENT_SRC.indexOf('vec2 uv = clamp(lensUv(perspectiveUv(vUv))')
    const base = FRAGMENT_SRC.indexOf('vec3 base = baseTexel.rgb')
    expect(sample).toBeGreaterThan(-1)
    expect(base).toBeGreaterThan(sample)
    // 暗角属于输出画面，不能跟着被透视拉歪。
    expect(FRAGMENT_SRC).toMatch(/vec2 d = vUv - 0\.5;/)
    // 0 时走早退，和加透视之前逐字节相同。
    expect(FRAGMENT_SRC).toMatch(/abs\(uPerspectiveV\) \+ abs\(uPerspectiveH\) < 1e-5\) return p/)
  })

  it('★ 镜头校正（2026-10-17）：先映射再采样，0 时早退，色差只动红蓝', () => {
    const uv = FRAGMENT_SRC.indexOf('lensUv(perspectiveUv(vUv))')
    const base = FRAGMENT_SRC.indexOf('vec3 base = baseTexel.rgb')
    expect(uv).toBeGreaterThan(-1)
    expect(base).toBeGreaterThan(uv)
    expect(FRAGMENT_SRC).toMatch(/abs\(uLensDistortion\) < 1e-5\) return p/)
    expect(FRAGMENT_SRC).toMatch(/zoom \* 0\.5 \/ max\(m, 1e-4\)/)
    expect(FRAGMENT_SRC).toContain('uLensChromatic')
    expect(FRAGMENT_SRC).toMatch(/baseTexel\.r = texture\(uImage, clamp\(uv \+ shift/)
    expect(FRAGMENT_SRC).toMatch(/baseTexel\.b = texture\(uImage, clamp\(uv - shift/)
    // 暗角和径向虚化仍是输出坐标，不能跟着镜头网格弯掉。
    expect(FRAGMENT_SRC).toMatch(/vec2 d = vUv - 0\.5;/)
    expect(FRAGMENT_SRC).toMatch(/vec2 q = \(vUv - focusCenter\)/)
  })

  it('★ 透明抠图（2026-10-17）：alpha 从源纹理带到输出，不被色调链写死成 1', () => {
    expect(FRAGMENT_SRC).toContain('float sourceAlpha = baseTexel.a')
    expect(FRAGMENT_SRC).toMatch(/fragColor = vec4\(clamp\(c, 0\.0, 1\.0\), sourceAlpha\)/)
    expect(FRAGMENT_SRC).not.toMatch(/fragColor = vec4\(clamp\(c, 0\.0, 1\.0\), 1\.0\)/)
  })

  it('★ 镜头虚化（2026-10-17）：在细节之后、色温之前，用输出坐标做焦点蒙版', () => {
    const sharpen = FRAGMENT_SRC.indexOf('uSharpen > 0.0')
    const lens = FRAGMENT_SRC.indexOf('uLensBlur > 0.0')
    const temp = FRAGMENT_SRC.indexOf('uTemperature * 0.10')
    expect(lens).toBeGreaterThan(sharpen)
    expect(temp).toBeGreaterThan(lens)
    for (const n of [
      'uLensBlur', 'uLensRange', 'uLensFeather', 'uLensFocusX', 'uLensFocusY',
      'uLensShape', 'uLensAngle',
    ]) {
      expect(FRAGMENT_SRC).toContain(n)
    }
    // 焦点从固定中心改成可拖：0 仍落在 0.5，所以默认画面逐字节不变。
    expect(FRAGMENT_SRC).toMatch(
      /vec2 focusCenter = clamp\(\s*vec2\(0\.5\) \+ vec2\(uLensFocusX, uLensFocusY\) \* 0\.5, 0\.0, 1\.0\)/,
    )
    expect(FRAGMENT_SRC).toMatch(/vec2 q = \(vUv - focusCenter\) \* vec2\(aspect, 1\.0\) \* 2\.0/)
    expect(FRAGMENT_SRC).toMatch(/mix\(c, bokeh, uLensBlur \* focus\)/)
    // 正角度在画布辅助带和成片里都必须是顺时针；这条由
    // `check:tilt-shift` 的左右上角清晰度对比做最终验收。
    expect(FRAGMENT_SRC).toMatch(/float bandAngle = uLensAngle \* 1\.5707963/)
    expect(FRAGMENT_SRC).toMatch(/float bandDistance = abs\(dot\(/)
    expect(FRAGMENT_SRC).toMatch(/focus = smoothstep\(bandHalf, bandHalf \+ bandFeather, bandDistance\)/)
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
