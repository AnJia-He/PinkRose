import { describe, expect, it } from 'vitest'
import { localAdjustPixels } from './localAdjust.ts'

const image = (w: number, h: number) => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 120
    data[i * 4 + 1] = 120
    data[i * 4 + 2] = 120
    data[i * 4 + 3] = 255
  }
  return data
}

const rectMask = (w: number, h: number, x0: number, y0: number, x1: number, y1: number) => {
  const m = new Uint8Array(w * h)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 255
  return m
}

const px = (data: Uint8ClampedArray, w: number, x: number, y: number) => {
  const i = (y * w + x) * 4
  return [data[i]!, data[i + 1]!, data[i + 2]!]
}

describe('localAdjustPixels · 模糊 / 马赛克', () => {
  it('模糊：掩码里的细噪点被抹平，掩码外逐字节不变', () => {
    const w = 40, h = 40
    const data = image(w, h)
    let seed = 7
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    for (let y = 8; y < 32; y++) {
      for (let x = 8; x < 32; x++) {
        const i = (y * w + x) * 4
        const v = 80 + Math.round(rand() * 80)
        data[i] = v; data[i + 1] = v; data[i + 2] = v
      }
    }
    const before = data.slice()
    const variance = (arr: Uint8ClampedArray) => {
      let sum = 0
      let sum2 = 0
      let n = 0
      for (let y = 10; y < 30; y++) {
        for (let x = 10; x < 30; x++) {
          const v = arr[(y * w + x) * 4]!
          sum += v; sum2 += v * v; n++
        }
      }
      const mean = sum / n
      return sum2 / n - mean * mean
    }
    const beforeVar = variance(before)
    localAdjustPixels(data, w, h, rectMask(w, h, 8, 8, 32, 32), {
      effect: 'blur', effectStrength: 100,
    })
    expect(variance(data)).toBeLessThan(beforeVar * 0.55)
    expect(px(data, w, 1, 1)).toEqual(px(before, w, 1, 1))
  })

  it('马赛克：同一格变成同一个颜色，格子外不动', () => {
    const w = 48, h = 48
    const data = image(w, h)
    for (let y = 8; y < 40; y++) {
      for (let x = 8; x < 40; x++) {
        const i = (y * w + x) * 4
        data[i] = x * 3
        data[i + 1] = y * 3
        data[i + 2] = (x + y) * 2
      }
    }
    const before = data.slice()
    localAdjustPixels(data, w, h, rectMask(w, h, 8, 8, 40, 40), {
      effect: 'mosaic', effectStrength: 100,
    })
    const block = new Set<string>()
    for (let y = 8; y < 16; y++) {
      for (let x = 8; x < 16; x++) block.add(px(data, w, x, y).join(','))
    }
    expect(block.size, '同一块里应该只剩一种颜色').toBe(1)
    expect(px(data, w, 1, 1)).toEqual(px(before, w, 1, 1))
  })

  it('强度 0 = 逐字节恒等', () => {
    const w = 24, h = 24
    const data = image(w, h)
    const before = data.slice()
    localAdjustPixels(data, w, h, rectMask(w, h, 4, 4, 20, 20), {
      effect: 'blur', effectStrength: 0,
    })
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
    localAdjustPixels(data, w, h, rectMask(w, h, 4, 4, 20, 20), {
      effect: 'mosaic', effectStrength: 0,
    })
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
  })
})
