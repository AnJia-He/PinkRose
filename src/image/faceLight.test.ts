import { describe, expect, it } from 'vitest'
import { faceLightPixels } from './faceLight'

const FACE = { x: 20, y: 20, w: 60, h: 60, confidence: 1 }

function image(w: number, h: number, px: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const [r, g, b] = px(x, y)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return data
}

const px = (data: Uint8ClampedArray, w: number, x: number, y: number) => {
  const i = (y * w + x) * 4
  return [data[i], data[i + 1], data[i + 2], data[i + 3]] as const
}

describe('faceLightPixels', () => {
  it('强度 0 = 一个字节都不动', () => {
    const data = image(100, 100, () => [48, 42, 36])
    const before = data.slice()
    const r = faceLightPixels(data, 100, 100, FACE, { strength: 0 })
    expect(r.changed).toBe(0)
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
  })

  it('暗脸的阴影被提亮，脸外和 alpha 不动', () => {
    const data = image(100, 100, (x, y) => {
      const inFace = Math.hypot((x - 50) / 34, (y - 50) / 36) < 1
      return inFace ? [42, 35, 30] : [10, 11, 12]
    })
    const before = data.slice()
    const r = faceLightPixels(data, 100, 100, FACE, { strength: 100 })

    expect(r.changed).toBeGreaterThan(0)
    const center = px(data, 100, 50, 50)
    expect(center[0]).toBeGreaterThan(55)
    expect(center[3]).toBe(255)
    expect(px(data, 100, 2, 2)).toEqual(px(before, 100, 2, 2))
  })

  it('高光保护：同一张脸里，暗处提亮幅度大于接近白色的高光', () => {
    const data = image(100, 100, (x, y) => {
      if (Math.hypot((x - 50) / 34, (y - 50) / 36) >= 1) return [0, 0, 0]
      return x < 50 ? [30, 24, 20] : [238, 234, 230]
    })
    const before = data.slice()
    faceLightPixels(data, 100, 100, FACE, { strength: 100 })
    const darkGain = px(data, 100, 42, 50)[0]! - px(before, 100, 42, 50)[0]!
    const highlightGain = px(data, 100, 58, 50)[0]! - px(before, 100, 58, 50)[0]!
    expect(darkGain).toBeGreaterThan(highlightGain + 8)
  })

  it('尺寸不对要报错', () => {
    expect(() => faceLightPixels(new Uint8ClampedArray(12), 4, 4, FACE, { strength: 40 }))
      .toThrow(/像素尺寸/)
  })
})
