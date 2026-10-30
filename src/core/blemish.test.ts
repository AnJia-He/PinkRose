import { describe, expect, it } from 'vitest'
import { detectBlemishes } from './blemish'
import { faceMask } from '../image/faceMask'

const W = 200
const H = 200
const face = { x: 50, y: 30, w: 100, h: 140, confidence: 0.9 }

function synthetic(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      data[i] = 200
      data[i + 1] = 160
      data[i + 2] = 140
      data[i + 3] = 255
    }
  }
  const paint = (x0: number, y0: number, w: number, h: number, rgb: [number, number, number]) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * W + x) * 4
        data[i] = rgb[0]
        data[i + 1] = rgb[1]
        data[i + 2] = rgb[2]
      }
    }
  }
  paint(120, 100, 5, 5, [135, 92, 82])       // 痘印
  paint(74, 72, 12, 5, [30, 25, 25])         // 眼睛（应排除）
  paint(70, 105, 16, 16, [120, 90, 84])      // 大阴影（面积应拒绝）
  return data
}

describe('detectBlemishes', () => {
  it('找脸框内的小暗点，排除眼睛和大阴影', () => {
    const mask = faceMask(W, H, face)
    const result = detectBlemishes(synthetic(), W, H, face, mask, { strength: 70 })
    expect(result.spots.length).toBeGreaterThan(0)
    expect(result.mask[102 * W + 122]).toBeGreaterThan(0)
    expect(result.mask[74 * W + 80]).toBe(0)
    expect(result.mask[110 * W + 78]).toBe(0)
  })

  it('强度 0 不动；空脸框返回空蒙版', () => {
    const mask = faceMask(W, H, face)
    expect(detectBlemishes(synthetic(), W, H, face, mask, { strength: 0 }).spots).toEqual([])
    const empty = detectBlemishes(synthetic(), W, H, { ...face, w: 0, h: 0 }, mask, { strength: 80 })
    expect(empty.spots).toEqual([])
    expect(empty.mask.every(v => v === 0)).toBe(true)
  })
})
