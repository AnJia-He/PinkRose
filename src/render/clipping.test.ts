import { describe, expect, it } from 'vitest'
import { clippingMaskPixels } from './clipping.ts'

describe('裁切警告 mask', () => {
  it('任一通道接近 255 标高光，三通道都接近 0 标阴影', () => {
    const pixels = new Uint8ClampedArray([
      255, 255, 255, 255, // 高光
      255, 20, 20, 255,   // 单通道高光也算
      0, 0, 0, 255,       // 阴影
      120, 80, 40, 255,   // 正常
    ])
    const result = clippingMaskPixels(pixels, 2, 2)
    expect([...result.mask]).toEqual([1, 1, 2, 0])
    expect(result).toMatchObject({ width: 2, height: 2 })
  })

  it('尺寸对不上直接抛，避免提示盖错位置', () => {
    expect(() => clippingMaskPixels(new Uint8ClampedArray(8), 2, 2))
      .toThrow(/像素尺寸/)
  })
})
