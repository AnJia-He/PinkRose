import { describe, expect, it } from 'vitest'
import { luminanceRangeMaskPixels } from './luminanceRange.ts'

function grayImage(values: number[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(values.length * 4)
  values.forEach((value, i) => {
    data[i * 4] = value
    data[i * 4 + 1] = value
    data[i * 4 + 2] = value
    data[i * 4 + 3] = 255
  })
  return data
}

describe('luminanceRangeMaskPixels', () => {
  it('★ 高光 / 阴影 / 中间调各自只选中对应亮度', () => {
    const data = grayImage([0, 128, 255])
    expect([...luminanceRangeMaskPixels(data, 3, 1, {
      range: 'shadows', width: 30, feather: 0,
    })]).toEqual([255, 0, 0])
    expect([...luminanceRangeMaskPixels(data, 3, 1, {
      range: 'midtones', width: 30, feather: 0,
    })]).toEqual([0, 255, 0])
    expect([...luminanceRangeMaskPixels(data, 3, 1, {
      range: 'highlights', width: 30, feather: 0,
    })]).toEqual([0, 0, 255])
  })

  it('★ 羽化让范围边缘出现中间覆盖率', () => {
    const data = grayImage([80, 128, 176])
    const mask = luminanceRangeMaskPixels(data, 3, 1, {
      range: 'midtones', width: 55, feather: 100,
    })
    expect(mask[1]).toBe(255)
    expect(mask[0]).toBeGreaterThan(0)
    expect(mask[0]).toBeLessThan(255)
    expect(mask[2]).toBeGreaterThan(0)
    expect(mask[2]).toBeLessThan(255)
  })

  it('★ 全透明像素不进选区；尺寸对不上直接抛', () => {
    const data = grayImage([255])
    data[3] = 0
    expect(luminanceRangeMaskPixels(data, 1, 1, {
      range: 'highlights', width: 30, feather: 0,
    })[0]).toBe(0)
    expect(() => luminanceRangeMaskPixels(new Uint8ClampedArray(8), 4, 4))
      .toThrow(/像素尺寸/)
  })
})
