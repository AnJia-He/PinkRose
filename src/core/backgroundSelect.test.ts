import { describe, expect, it } from 'vitest'
import { selectBackgroundMask } from './backgroundSelect.ts'

function canvasImage(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const subject = x >= 10 && x < 20 && y >= 5 && y < 15
      data[i] = subject ? 220 : 20
      data[i + 1] = subject ? 70 : 180
      data[i + 2] = subject ? 60 : 20
      data[i + 3] = 255
    }
  }
  return data
}

describe('selectBackgroundMask', () => {
  it('★ 只选和种子连通的背景，主体不被带进去', () => {
    const w = 32, h = 24
    const data = canvasImage(w, h)
    const { mask, covered, seed } = selectBackgroundMask(data, w, h, 2, 2, 20)
    expect(seed).toEqual([20, 180, 20])
    expect(covered).toBeGreaterThan(0)
    expect(mask[2 * w + 2]).toBe(255)
    expect(mask[12 * w + 15]).toBe(0)
  })

  it('★ 不越过主体边缘，也不把断开同色块一起选进来', () => {
    const w = 32, h = 24
    const data = canvasImage(w, h)
    // 右上角一块和背景同色，但被主体隔开。
    for (let y = 0; y < 4; y++) {
      for (let x = 20; x < 28; x++) {
        const i = (y * w + x) * 4
        data[i] = 20; data[i + 1] = 180; data[i + 2] = 20; data[i + 3] = 255
      }
    }
    // 真正的连接路径被改成主体色。
    for (let y = 0; y < h; y++) {
      const i = (y * w + 18) * 4
      data[i] = 220; data[i + 1] = 70; data[i + 2] = 60
    }
    const { mask } = selectBackgroundMask(data, w, h, 2, 2, 20)
    expect(mask[2 * w + 24]).toBe(0)
  })

  it('容差越大选得越多；尺寸不符要抛', () => {
    const w = 16, h = 16
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const v = x < 8 ? 0 : 25
        data[i] = v; data[i + 1] = 100 + v; data[i + 2] = 0; data[i + 3] = 255
      }
    }
    const low = selectBackgroundMask(data, w, h, 1, 1, 0).covered
    const high = selectBackgroundMask(data, w, h, 1, 1, 30).covered
    expect(high).toBeGreaterThan(low)
    expect(() => selectBackgroundMask(new Uint8ClampedArray(12), w, h, 0, 0, 10))
      .toThrow(/像素尺寸/)
  })
})
