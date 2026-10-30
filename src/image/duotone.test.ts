import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DUOTONE, duotonePixels, parseHexColor, type DuotoneOptions,
} from './duotone'

function pixels(...rgba: number[]): Uint8ClampedArray {
  return new Uint8ClampedArray(rgba)
}

const options = (patch: Partial<DuotoneOptions> = {}): DuotoneOptions => ({
  ...DEFAULT_DUOTONE,
  shadow: '#000000',
  highlight: '#ffffff',
  intensity: 100,
  ...patch,
})

describe('双色调像素映射', () => {
  it('解析 #rgb / #rrggbb，不合法返回 null', () => {
    expect(parseHexColor('#f00')).toEqual([255, 0, 0])
    expect(parseHexColor('#0B1F2A')).toEqual([11, 31, 42])
    expect(parseHexColor('#fff')).toEqual([255, 255, 255])
    expect(parseHexColor('red')).toBeNull()
    expect(parseHexColor('#12345')).toBeNull()
  })

  it('强度 0 一个字节都不动', () => {
    const data = pixels(10, 20, 30, 255)
    expect(duotonePixels(data, 1, 1, options({ intensity: 0 }))).toEqual({ changed: 0 })
    expect([...data]).toEqual([10, 20, 30, 255])
  })

  it('100% 时黑 / 白像素分别落到暗部 / 亮部颜色，alpha 不动', () => {
    const data = pixels(
      0, 0, 0, 255,
      255, 255, 255, 180,
    )
    duotonePixels(data, 2, 1, options({
      shadow: '#0b1f2a', highlight: '#e8d7b8',
    }))
    expect([...data.slice(0, 4)]).toEqual([11, 31, 42, 255])
    expect([...data.slice(4)]).toEqual([232, 215, 184, 180])
  })

  it('50% 把目标色和原图各混一半', () => {
    const data = pixels(0, 0, 0, 255)
    duotonePixels(data, 1, 1, options({
      shadow: '#ff0000', highlight: '#ff0000', intensity: 50,
    }))
    expect([...data]).toEqual([128, 0, 0, 255])
  })

  it('颜色非法时保持原样', () => {
    const data = pixels(1, 2, 3, 4)
    expect(duotonePixels(data, 1, 1, options({ shadow: 'oops' }))).toEqual({ changed: 0 })
    expect([...data]).toEqual([1, 2, 3, 4])
  })

  it('尺寸对不上直接抛，不静默产出错误图片', () => {
    expect(() => duotonePixels(pixels(1, 2, 3, 4), 2, 1, options()))
      .toThrow('像素尺寸和照片对不上')
  })
})
