import { describe, expect, it } from 'vitest'
import { colorRangeMaskPixels, rgbToHsv } from './colorRange.ts'

function makeImage(
  w: number, h: number, px: (x: number, y: number) => [number, number, number, number?],
) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = px(x, y)
      const i = (y * w + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return data
}

describe('colorRangeMaskPixels', () => {
  it('HSV：红 / 绿 / 灰的基本换算', () => {
    expect(rgbToHsv(255, 0, 0)).toMatchObject({ h: 0, s: 1, v: 1 })
    expect(rgbToHsv(0, 255, 0).h).toBeCloseTo(1 / 3, 6)
    expect(rgbToHsv(0, 0, 255).h).toBeCloseTo(2 / 3, 6)
    expect(rgbToHsv(128, 128, 128)).toMatchObject({ s: 0 })
  })

  it('★ 选红不选蓝；容差放大后近红进来，绿仍然不进来', () => {
    const w = 32, h = 16
    const data = makeImage(w, h, x => (x < 16 ? [200, 40, 40] : [40, 40, 200]))
    const mask = colorRangeMaskPixels(data, w, h, [200, 40, 40], { tolerance: 20, feather: 0 })
    expect(mask[4 * w + 4]).toBe(255)
    expect(mask[4 * w + 24]).toBe(0)

    // 近红：暗一点的红
    const near = makeImage(w, h, () => [170, 45, 42])
    expect(colorRangeMaskPixels(near, w, h, [200, 40, 40], {
      tolerance: 20, feather: 0,
    })[0]).toBe(255)
    const green = makeImage(w, h, () => [40, 180, 60])
    expect(colorRangeMaskPixels(green, w, h, [200, 40, 40], {
      tolerance: 20, feather: 0,
    })[0]).toBe(0)
  })

  it('★ 羽化给出中间值；全透明像素不选', () => {
    const w = 4, h = 1
    const data = makeImage(w, h, x => (x === 0 ? [200, 40, 40] : x === 1
      ? [150, 40, 40] : x === 2 ? [40, 180, 60] : [0, 0, 0, 0]))
    const mask = colorRangeMaskPixels(data, w, h, [200, 40, 40], {
      tolerance: 50, feather: 50,
    })
    expect(mask[0]).toBe(255)
    expect(mask[1]).toBeGreaterThan(0)
    expect(mask[1]).toBeLessThan(255)
    expect(mask[2]).toBe(0)
    expect(mask[3]).toBe(0)
  })

  it('尺寸对不上直接抛', () => {
    expect(() => colorRangeMaskPixels(new Uint8ClampedArray(8), 4, 4, [0, 0, 0]))
      .toThrow(/像素尺寸/)
  })

  it('★ 从点击点只在相连区域生长，同色但不连通的另一块不选', () => {
    const w = 10
    const h = 3
    const data = makeImage(w, h, x => (x < 3 || x >= 6 ? [200, 40, 40] : [40, 40, 200]))
    const opts = { tolerance: 20, feather: 0, connected: true, seedX: 0.15, seedY: 0.5 }
    const left = colorRangeMaskPixels(data, w, h, [200, 40, 40], opts)
    expect(left[1 * w + 1]).toBe(255)
    expect(left[1 * w + 7]).toBe(0)

    const right = colorRangeMaskPixels(data, w, h, [200, 40, 40], {
      ...opts, seedX: 0.75,
    })
    expect(right[1 * w + 1]).toBe(0)
    expect(right[1 * w + 7]).toBe(255)
  })
})
