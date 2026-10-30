import { describe, it, expect } from 'vitest'
import { UNIFORM_NAMES, uniformValues } from './uniforms'
import { ZERO } from '../../shared/adjustments'

describe('uniformValues', () => {
  it('97 个名字一个不少（94 参数 + HSL / 整体曲线 / RGB 曲线总开关）', () => {
    expect(UNIFORM_NAMES).toHaveLength(97)
    expect(new Set(UNIFORM_NAMES).size).toBe(97)
  })
  it('全零参数映射全零', () => {
    const v = uniformValues(ZERO)
    for (const n of UNIFORM_NAMES) expect(v[n]).toBe(0)
  })
  it('100 映射到 1（toUnit 在函数内做过）', () => {
    const v = uniformValues({ ...ZERO, exposure: 100 })
    expect(v.uExposure).toBe(1)
  })
  it('★ 色调走 uTint，-100~100 → -1~1', () => {
    expect(uniformValues({ ...ZERO, tint: -35 }).uTint).toBeCloseTo(-0.35)
  })
  it('★ 黑白强度与三条混色权重各走各的 uniform', () => {
    const v = uniformValues({
      ...ZERO, bwAmount: 100, bwRed: 50, bwGreen: -25, bwBlue: 75,
    })
    expect(v.uBwAmount).toBe(1)
    expect(v.uBwRed).toBeCloseTo(0.5)
    expect(v.uBwGreen).toBeCloseTo(-0.25)
    expect(v.uBwBlue).toBeCloseTo(0.75)
  })
  it('★ 白色色阶 / 黑色色阶 / 纹理各走各的 uniform', () => {
    const v = uniformValues({ ...ZERO, whites: 25, blacks: -35, texture: 45 })
    expect(v.uWhites).toBeCloseTo(0.25)
    expect(v.uBlacks).toBeCloseTo(-0.35)
    expect(v.uTexture).toBeCloseTo(0.45)
  })
  it('★ 磨皮走 uSkinSmooth，0~100 → 0~1', () => {
    expect(uniformValues({ ...ZERO, skinSmooth: 60 }).uSkinSmooth).toBeCloseTo(0.6)
  })
  it('★ 去雾走 uDehaze，-100~100 → -1~1', () => {
    expect(uniformValues({ ...ZERO, dehaze: 35 }).uDehaze).toBeCloseTo(0.35)
    expect(uniformValues({ ...ZERO, dehaze: -40 }).uDehaze).toBeCloseTo(-0.4)
  })
  it('★ HDR 走 uHdr，0~100 → 0~1', () => {
    expect(uniformValues({ ...ZERO, hdr: 45 }).uHdr).toBeCloseTo(0.45)
  })
  it('★ 柔光走 uGlow，0~100 → 0~1', () => {
    expect(uniformValues({ ...ZERO, glow: 40 }).uGlow).toBeCloseTo(0.4)
  })
  it('★ 三段色彩分级的中间调与平衡各走各的 uniform', () => {
    const v = uniformValues({
      ...ZERO, splitMidHue: 200, splitMidAmount: 45, splitBalance: -30,
    })
    expect(v.uSplitMidHue).toBeCloseTo(200 / 360)
    expect(v.uSplitMidAmount).toBeCloseTo(0.45)
    expect(v.uSplitBalance).toBeCloseTo(-0.3)
  })
  it('★ 细节组三个各走各的 uniform，0~100 → 0~1', () => {
    const v = uniformValues({ ...ZERO, sharpen: 40, noiseReduction: 30, grain: 20 })
    expect(v.uSharpen).toBeCloseTo(0.4)
    expect(v.uNoiseReduction).toBeCloseTo(0.3)
    expect(v.uGrain).toBeCloseTo(0.2)
  })
  it('★ 彩色降噪单独走 uColorNoiseReduction', () => {
    expect(uniformValues({ ...ZERO, colorNoiseReduction: 65 }).uColorNoiseReduction)
      .toBeCloseTo(0.65)
  })
  it('★ 锐化半径与蒙版各走自己的 uniform', () => {
    const v = uniformValues({ ...ZERO, sharpenRadius: 40, sharpenMasking: 75 })
    expect(v.uSharpenRadius).toBeCloseTo(0.4)
    expect(v.uSharpenMasking).toBeCloseTo(0.75)
  })
  it('★ HSL 24 个通道进 uniform，任一条非零就点亮 uHslOn', () => {
    const off = uniformValues(ZERO)
    expect(off.uHslOn).toBe(0)
    const on = uniformValues({ ...ZERO, hslGreenSat: 45 })
    expect(on.uHslGreenSat).toBeCloseTo(0.45)
    expect(on.uHslOn).toBe(1)
  })
  it('★ 曲线五个控制点进 uniform，任一条非零就点亮 uCurveOn', () => {
    const off = uniformValues(ZERO)
    expect(off.uCurveOn).toBe(0)
    const on = uniformValues({ ...ZERO, curveMidtones: 25 })
    expect(on.uCurveMidtones).toBeCloseTo(0.25)
    expect(on.uCurveOn).toBe(1)
  })
  it('★ RGB 曲线三组通道进 uniform，任一条非零就点亮 uCurveRgbOn', () => {
    const off = uniformValues(ZERO)
    expect(off.uCurveRgbOn).toBe(0)
    const on = uniformValues({ ...ZERO, curveGreenMidtones: 30 })
    expect(on.uCurveGreenMidtones).toBeCloseTo(0.3)
    expect(on.uCurveRgbOn).toBe(1)
  })
  it('★ 美颜两项进 uniform（美白 / 红润）', () => {
    const v = uniformValues({ ...ZERO, skinBrighten: 30, skinRosy: 20 })
    expect(v.uSkinBrighten).toBeCloseTo(0.3)
    expect(v.uSkinRosy).toBeCloseTo(0.2)
  })
  it('★ 几何透视两项进 uniform（垂直 / 水平）', () => {
    const v = uniformValues({ ...ZERO, perspectiveV: 40, perspectiveH: -25 })
    expect(v.uPerspectiveV).toBeCloseTo(0.4)
    expect(v.uPerspectiveH).toBeCloseTo(-0.25)
  })
  it('★ 镜头五项进 uniform（强度 / 范围 / 过渡 / 焦点 X / 焦点 Y）', () => {
    const v = uniformValues({
      ...ZERO, lensBlur: 70, lensRange: -30, lensFeather: 20,
      lensFocusX: 40, lensFocusY: -60,
    })
    expect(v.uLensBlur).toBeCloseTo(0.7)
    expect(v.uLensRange).toBeCloseTo(-0.3)
    expect(v.uLensFeather).toBeCloseTo(0.2)
    expect(v.uLensFocusX).toBeCloseTo(0.4)
    expect(v.uLensFocusY).toBeCloseTo(-0.6)
  })
  it('★ 移轴模式与角度进 uniform', () => {
    const v = uniformValues({ ...ZERO, lensShape: 100, lensAngle: -45 })
    expect(v.uLensShape).toBeCloseTo(1)
    expect(v.uLensAngle).toBeCloseTo(-0.45)
  })
  it('★ 镜头校正三项进 uniform（畸变 / 色差 / 暗角）', () => {
    const v = uniformValues({
      ...ZERO, lensDistortion: 35, lensChromatic: -20, lensVignette: 40,
    })
    expect(v.uLensDistortion).toBeCloseTo(0.35)
    expect(v.uLensChromatic).toBeCloseTo(-0.2)
    expect(v.uLensVignette).toBeCloseTo(0.4)
  })
})
