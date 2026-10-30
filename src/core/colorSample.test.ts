import { describe, expect, it } from 'vitest'
import { colorReading, rgbToHex, rgbToHsl } from './colorSample'

describe('颜色取样读数', () => {
  it('RGB 转 HEX 使用两位大写通道', () => {
    expect(rgbToHex([255, 10, 0])).toBe('#FF0A00')
    expect(rgbToHex([300, -1, 128.6])).toBe('#FF0081')
  })

  it('RGB 转 HSL 覆盖红、灰和中间色', () => {
    expect(rgbToHsl([255, 0, 0])).toEqual([0, 100, 50])
    expect(rgbToHsl([128, 128, 128])).toEqual([0, 0, 50])
    expect(rgbToHsl([0, 128, 255])).toMatchObject([210, 100, 50])
  })

  it('一次返回显示需要的三套读数', () => {
    expect(colorReading([18, 52, 86])).toEqual({
      rgb: [18, 52, 86],
      hex: '#123456',
      hsl: [210, 65, 20],
    })
  })
})
