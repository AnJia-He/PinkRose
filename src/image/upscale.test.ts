import { describe, expect, it } from 'vitest'
import { unsharpPixels, upscaleTarget } from './upscale.ts'

describe('超清放大', () => {
  it('默认目标是最多 2 倍，并受设备单边 / 面积上限约束', () => {
    expect(upscaleTarget(1200, 800, { maxSide: 8192, maxArea: null }))
      .toEqual({ width: 2400, height: 1600 })
    expect(upscaleTarget(3000, 2000, { maxSide: 4096, maxArea: 16_777_216 }))
      .toEqual({ width: 4096, height: 2730 })
    expect(upscaleTarget(4000, 3000, { maxSide: 4096, maxArea: 16_777_216 }))
      .toBeNull()
  })

  it('可选 4 倍，但 12 MP 本机缓冲上限仍然生效', () => {
    expect(upscaleTarget(1200, 800, { maxSide: 8192, maxArea: null }, 4))
      .toEqual({ width: 4242, height: 2828 })
    expect(upscaleTarget(1200, 800, { maxSide: 8192, maxArea: null }, 8))
      .toEqual({ width: 4242, height: 2828 })
    expect(upscaleTarget(1200, 800, { maxSide: 8192, maxArea: null }, 1))
      .toBeNull()
  })

  it('锐化提高边缘反差，alpha 原样不动', () => {
    const data = new Uint8ClampedArray(3 * 3 * 4)
    for (let i = 0; i < 9; i++) {
      data[i * 4] = 60
      data[i * 4 + 1] = 80
      data[i * 4 + 2] = 100
      data[i * 4 + 3] = 200
    }
    data[4 * 4] = 180
    data[4 * 4 + 1] = 200
    data[4 * 4 + 2] = 220
    const beforeCenter = data[4 * 4]
    const beforeAlpha = data[4 * 4 + 3]
    const r = unsharpPixels(data, 3, 3, 0.5)
    expect(r.changed).toBeGreaterThan(0)
    expect(data[4 * 4]).toBeGreaterThan(beforeCenter)
    expect(data[4 * 4 + 3]).toBe(beforeAlpha)
  })

  it('amount 0 一个字节都不改', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255])
    const copy = new Uint8ClampedArray(data)
    expect(unsharpPixels(data, 2, 1, 0)).toEqual({ changed: 0 })
    expect(data).toEqual(copy)
  })
})
