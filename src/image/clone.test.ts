import { describe, expect, it } from 'vitest'
import { clonePixels } from './clone.ts'

const split = (w: number, h: number) => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const left = x < w / 2
      data[i] = left ? 220 : 30
      data[i + 1] = left ? 50 : 80
      data[i + 2] = left ? 40 : 210
      data[i + 3] = 255
    }
  }
  return data
}

const px = (data: Uint8ClampedArray, w: number, x: number, y: number) => {
  const i = (y * w + x) * 4
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!] as const
}

describe('clonePixels', () => {
  it('按源点偏移把左半边的红色复制到右半边，复制区外逐字节不变', () => {
    const w = 64, h = 40
    const data = split(w, h)
    const source = data.slice()
    const before = data.slice()
    const result = clonePixels(data, source, w, h, [{ x: 48, y: 20 }], 8, { x: -24, y: 0 })

    expect(result.changed).toBeGreaterThan(0)
    const p = px(data, w, 48, 20)
    expect(p[0]).toBeGreaterThan(180)
    expect(p[2]).toBeLessThan(100)
    expect(px(data, w, 2, 2)).toEqual(px(before, w, 2, 2))
  })

  it('沿一条线段连续复制，软边有过渡', () => {
    const w = 64, h = 40
    const data = split(w, h)
    const source = data.slice()
    clonePixels(data, source, w, h, [{ x: 40, y: 12 }, { x: 56, y: 28 }], 8, { x: -24, y: 0 })

    expect(px(data, w, 48, 20)[0]).toBeGreaterThan(120)
    const edge = px(data, w, 56 + 8, 20)
    expect(edge).not.toEqual([30, 80, 210, 255])
  })

  it('空点列 / 半径 0 / 源点越界 = 恒等', () => {
    const w = 32, h = 32
    const data = split(w, h)
    const source = data.slice()
    const before = data.slice()
    expect(clonePixels(data, source, w, h, [], 6, { x: 0, y: 0 }).changed).toBe(0)
    expect(clonePixels(data, source, w, h, [{ x: 20, y: 20 }], 0, { x: -5, y: 0 }).changed).toBe(0)
    expect(clonePixels(data, source, w, h, [{ x: 2, y: 2 }], 6, { x: -100, y: 0 }).changed).toBe(0)
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
  })

  it('尺寸不对要报错', () => {
    const data = new Uint8ClampedArray(16)
    expect(() => clonePixels(data, data, 4, 4, [], 4, { x: 0, y: 0 })).toThrow(/像素尺寸/)
  })
})
