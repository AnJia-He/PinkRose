import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LINEAR_GRADIENT, DEFAULT_RADIAL_GRADIENT, fillGradientMask,
} from './gradientMask.ts'

const at = (mask: Uint8Array, w: number, x: number, y: number) => mask[y * w + x]!

describe('fillGradientMask', () => {
  it('线性：start 之前全生效，end 之后归零，中间平滑过渡', () => {
    const w = 40, h = 40
    const mask = new Uint8Array(w * h)
    const count = fillGradientMask(mask, w, h, DEFAULT_LINEAR_GRADIENT)

    expect(count).toBeGreaterThan(0)
    expect(at(mask, w, 20, 2)).toBe(255)
    expect(at(mask, w, 20, 38)).toBe(0)
    const middle = at(mask, w, 20, 18)
    expect(middle).toBeGreaterThan(0)
    expect(middle).toBeLessThan(255)
    expect(at(mask, w, 2, 10)).toBe(at(mask, w, 38, 10))
  })

  it('径向：圆心全生效，半径外归零，羽化带单调下降', () => {
    const w = 80, h = 80
    const mask = new Uint8Array(w * h)
    fillGradientMask(mask, w, h, DEFAULT_RADIAL_GRADIENT)

    const center = at(mask, w, 40, 40)
    const edge = at(mask, w, 40, 64)
    const outside = at(mask, w, 40, 79)
    expect(center).toBe(255)
    expect(edge).toBeGreaterThan(0)
    expect(edge).toBeLessThan(center)
    expect(outside).toBe(0)
  })

  it('长度为零 / 尺寸不符：不写出任何假蒙版', () => {
    const mask = new Uint8Array(16)
    mask.fill(255)
    expect(fillGradientMask(mask, 4, 4, {
      kind: 'linear', start: { x: 0.5, y: 0.5 }, end: { x: 0.5, y: 0.5 }, feather: 0,
    })).toBe(0)
    expect(mask.every(v => v === 0)).toBe(true)
    expect(() => fillGradientMask(new Uint8Array(10), 4, 4, DEFAULT_RADIAL_GRADIENT))
      .toThrow(/蒙版尺寸/)
  })
})
