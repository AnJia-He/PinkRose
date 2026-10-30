import { describe, expect, it } from 'vitest'
import { eraseAlphaPixels } from './transparency.ts'

const solid = (w: number, h: number) => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 120
    data[i * 4 + 1] = 90
    data[i * 4 + 2] = 60
    data[i * 4 + 3] = 255
  }
  return data
}

describe('eraseAlphaPixels', () => {
  it('★ 只改掩码里的 alpha；RGB 和掩码外逐字节不变', () => {
    const w = 16, h = 16
    const data = solid(w, h)
    const before = data.slice()
    const mask = new Uint8Array(w * h)
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) mask[y * w + x] = 255

    const { covered } = eraseAlphaPixels(data, w, h, mask)
    expect(covered).toBe(64)
    expect(data[(8 * w + 8) * 4 + 3]).toBe(0)
    expect(Array.from(data.slice((8 * w + 8) * 4, (8 * w + 8) * 4 + 3))).toEqual([120, 90, 60])
    expect(data[(0 * w + 0) * 4 + 3]).toBe(255)
    expect(Buffer.from(data.slice(0, 4 * 4))).toEqual(Buffer.from(before.slice(0, 4 * 4)))
  })

  it('半覆盖 = 半透明；已经透明的像素不会被"擦回来"', () => {
    const w = 8, h = 8
    const data = solid(w, h)
    const mask = new Uint8Array(w * h).fill(128)
    eraseAlphaPixels(data, w, h, mask)
    expect(data[3]).toBe(127)

    const clear = solid(w, h)
    for (let i = 3; i < clear.length; i += 4) clear[i] = 0
    eraseAlphaPixels(clear, w, h, new Uint8Array(w * h).fill(255))
    expect(clear[3]).toBe(0)
  })

  it('空掩码什么都不做；尺寸不符要抛', () => {
    const w = 8, h = 8
    const data = solid(w, h)
    const before = data.slice()
    expect(eraseAlphaPixels(data, w, h, new Uint8Array(w * h)).covered).toBe(0)
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
    expect(() => eraseAlphaPixels(data, w, h, new Uint8Array(5))).toThrow(/掩码尺寸/)
  })
})
