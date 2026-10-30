import { describe, expect, it } from 'vitest'
import { convertSrgbPixelsToDisplayP3, srgbToDisplayP3 } from './p3.ts'

describe('sRGB → Display P3', () => {
  it('sRGB 纯红换成 P3 数值，不能只换标签', () => {
    const [r, g, b] = srgbToDisplayP3(1, 0, 0)
    expect(r).toBeCloseTo(0.9175, 3)
    expect(g).toBeCloseTo(0.2003, 3)
    expect(b).toBeCloseTo(0.1386, 3)
  })

  it('批量转换保留 alpha，白点和灰阶保持中性', () => {
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 77,
      255, 255, 255, 255,
      128, 128, 128, 255,
    ])

    convertSrgbPixelsToDisplayP3(pixels)

    expect([...pixels.slice(0, 4)]).toEqual([234, 51, 35, 77])
    expect([...pixels.slice(4, 8)]).toEqual([255, 255, 255, 255])
    expect(Math.abs(pixels[8]! - 128)).toBeLessThanOrEqual(1)
    expect(pixels[9]).toBe(pixels[8])
    expect(pixels[10]).toBe(pixels[8])
    expect(pixels[11]).toBe(255)
  })
})
