import { describe, expect, it } from 'vitest'
import {
  MAX_STRAIGHTEN, clampRect, cropOutputSize, effectiveAngle, fitAspect, inscribedRect,
  rectFromSize, rotatedBounds, type CropSpec,
} from './crop'

const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol)

describe('rotatedBounds —— 转过来之后占多大一块', () => {
  it('不转就是原来那块', () => {
    expect(rotatedBounds(1000, 500, 0)).toEqual({ w: 1000, h: 500 })
  })
  it('90 度：长宽对调（不会多出空白角）', () => {
    expect(rotatedBounds(1000, 500, 90)).toEqual({ w: 500, h: 1000 })
  })
  it('15 度：两头都长大', () => {
    const b = rotatedBounds(1000, 500, 15)
    expect(b.w).toBeGreaterThan(1000)
    expect(b.h).toBeGreaterThan(500)
  })
})

describe('inscribedRect —— 转完之后，不露空角的最大矩形', () => {
  it('★ 不转 = 整张（归一化就是 1×1）', () => {
    const b = rotatedBounds(1000, 500, 0)
    const r = inscribedRect(1000, 500, 0)
    close(r.w / b.w, 1); close(r.h / b.h, 1)
  })
  it('★ 90 度也是整张（转直角不会露角）', () => {
    const b = rotatedBounds(1000, 500, 90)
    const r = inscribedRect(1000, 500, 90)
    close(r.w / b.w, 1); close(r.h / b.h, 1)
  })
  it('★ 转 1 度就要缩一点；转 15 度缩得更多（单调）', () => {
    const a1 = inscribedRect(1000, 500, 1)
    const a15 = inscribedRect(1000, 500, 15)
    expect(a1.w).toBeLessThan(1000)
    expect(a15.w).toBeLessThan(a1.w)
  })
  it('★ 内接矩形不许超过原图（面积意义上：它就是"能留下的最大一块"）', () => {
    for (const deg of [1, 5, 15, -15, -7.5]) {
      const r = inscribedRect(1000, 500, deg)
      expect(r.w * r.h).toBeLessThanOrEqual(1000 * 500 + 1e-6)
      expect(r.w).toBeGreaterThan(0); expect(r.h).toBeGreaterThan(0)
    }
  })
})

describe('fitAspect / rectFromSize / clampRect', () => {
  it('给了比例档就按它收（装得下为前提）', () => {
    // 可用区 800×600，要 1:1 → 600×600
    expect(fitAspect({ w: 800, h: 600 }, 1)).toEqual({ w: 600, h: 600 })
    // 要 16:9 → 800×450
    expect(fitAspect({ w: 800, h: 600 }, 16 / 9)).toEqual({ w: 800, h: 450 })
  })
  it('自由档原样返回', () => {
    expect(fitAspect({ w: 800, h: 600 }, null)).toEqual({ w: 800, h: 600 })
  })
  it('居中的归一化矩形', () => {
    expect(rectFromSize({ w: 400, h: 300 }, { w: 800, h: 600 }))
      .toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
  })
  it('夹进 0~1；太小的框给一个下限（别让它缩成 0）', () => {
    expect(clampRect({ x: -1, y: 2, w: 5, h: 5 })).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    const tiny = clampRect({ x: .5, y: .5, w: 0.0001, h: 0.0001 })
    expect(tiny.w).toBeCloseTo(0.02); expect(tiny.h).toBeCloseTo(0.02)
  })
})

describe('cropOutputSize —— 裁出来多少像素', () => {
  const spec = (rect: [number, number, number, number], angle = 0): CropSpec =>
    ({ rect: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] }, angle })
  it('不转、整张 → 就是原图尺寸', () => {
    expect(cropOutputSize(spec([0, 0, 1, 1]), 0, 1200, 800)).toEqual({ width: 1200, height: 800 })
  })
  it('裁一半 → 一半像素', () => {
    expect(cropOutputSize(spec([0, 0, .5, .5]), 0, 1200, 800)).toEqual({ width: 600, height: 400 })
  })
  it('★ 转 90 度 → 长宽对调', () => {
    expect(cropOutputSize(spec([0, 0, 1, 1]), 1, 1200, 800)).toEqual({ width: 800, height: 1200 })
  })
  it('★ 转完之后**不许放大**：像素总数不超过原图', () => {
    // 15 度时外框比原图大，内接矩形几乎占满外框 —— 不设上限就会输出比原图更大的图
    const r = inscribedRect(1200, 800, MAX_STRAIGHTEN)
    const b = rotatedBounds(1200, 800, MAX_STRAIGHTEN)
    const out = cropOutputSize({ rect: rectFromSize(r, b), angle: MAX_STRAIGHTEN }, 0, 1200, 800)
    expect(out.width * out.height).toBeLessThanOrEqual(1200 * 800 + 1)
    expect(out.width).toBeGreaterThan(0)
  })
  it('effectiveAngle 把 90 度整转和矫正角合起来', () => {
    expect(effectiveAngle(spec([0, 0, 1, 1], 7), 1)).toBe(97)
    expect(effectiveAngle(spec([0, 0, 1, 1], -7), 3)).toBe(263)
  })
})
