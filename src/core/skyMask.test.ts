import { describe, expect, it } from 'vitest'
import { skyMaskPixels } from './skyMask.ts'

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

describe('天空蒙版', () => {
  it('蓝色天空命中，绿色地面不命中', () => {
    const w = 40, h = 40
    const result = skyMaskPixels(image(w, h, (_x, y) => (
      y < 20 ? [70, 150, 235] : [60, 130, 60]
    )), w, h)
    expect(result.covered).toBeGreaterThan(0)
    expect(result.mask[5 * w + 20]).toBeGreaterThan(180)
    expect(result.mask[35 * w + 20]).toBe(0)
  })

  it('阴天亮灰天空能选中，下方暗灰建筑不选', () => {
    const w = 40, h = 40
    const result = skyMaskPixels(image(w, h, (_x, y) => (
      y < 18 ? [215, 220, 226] : [80, 80, 82]
    )), w, h)
    expect(result.mask[5 * w + 20]).toBeGreaterThan(150)
    expect(result.mask[30 * w + 20]).toBe(0)
  })

  it('尺寸不对要报错', () => {
    expect(() => skyMaskPixels(new Uint8ClampedArray(4), 2, 2)).toThrow(/尺寸/)
  })
})
