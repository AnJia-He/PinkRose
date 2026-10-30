import { describe, expect, it } from 'vitest'
import { liquifyPixels, type LiquifyStroke } from './liquify'

function canvasWithDots(redX = 50): {
  data: Uint8ClampedArray; width: number; height: number
} {
  const width = 100
  const height = 100
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 3; i < data.length; i += 4) data[i] = 255
  const paint = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * width + x) * 4
    data[i] = r; data[i + 1] = g; data[i + 2] = b
  }
  paint(redX, 50, 255, 0, 0)
  paint(90, 90, 0, 0, 255)
  return { data, width, height }
}

function centroid(data: Uint8ClampedArray, width: number, channel: 0 | 2) {
  let sx = 0
  let n = 0
  for (let i = channel; i < data.length; i += 4) {
    if (data[i]! > 30) { sx += ((i - channel) / 4) % width; n++ }
  }
  return n ? sx / n : NaN
}

const stroke = (patch: Partial<LiquifyStroke>): LiquifyStroke => ({
  x0: 50, y0: 50, x1: 60, y1: 50,
  radius: 20, strength: 100, mode: 'push', ...patch,
})

describe('liquifyPixels', () => {
  it('强度 0 / 没拖动 = 一个字节都不动', () => {
    const a = canvasWithDots()
    const before = a.data.slice()
    expect(liquifyPixels(a.data, a.width, a.height, stroke({ strength: 0 })).changed).toBe(0)
    expect(a.data).toEqual(before)
    expect(liquifyPixels(a.data, a.width, a.height, stroke({ x1: 50 })).changed).toBe(0)
  })

  it('推移：红点跟着拖动方向走，半径外的蓝点不动', () => {
    const a = canvasWithDots()
    const before = a.data.slice()
    const r = liquifyPixels(a.data, a.width, a.height, stroke({}))
    expect(r.changed).toBeGreaterThan(0)
    expect(centroid(a.data, a.width, 0)).toBeGreaterThan(centroid(before, a.width, 0))
    const blue = (90 * a.width + 90) * 4
    expect([...a.data.slice(blue, blue + 3)]).toEqual([0, 0, 255])
  })

  it('收拢：点往中心靠', () => {
    const a = canvasWithDots(60)
    const before = a.data.slice()
    liquifyPixels(a.data, a.width, a.height, stroke({
      x0: 50, y0: 50, x1: 50, y1: 50, mode: 'pinch',
    }))
    expect(centroid(a.data, a.width, 0)).toBeLessThan(centroid(before, a.width, 0))
  })

  it('贴着画布边缘也不抛错、尺寸不变', () => {
    const a = canvasWithDots()
    expect(() => liquifyPixels(a.data, a.width, a.height, stroke({
      x0: 0, y0: 0, x1: 2, y1: 0,
    }))).not.toThrow()
    expect(a.data).toHaveLength(100 * 100 * 4)
  })
})
