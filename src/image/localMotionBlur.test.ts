import { describe, expect, it } from 'vitest'
import { localAdjustPixels } from './localAdjust.ts'

const W = 80
const H = 64

/** 黑底 + 居中的 15px 竖白条，用来量方向。 */
function barImage(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 25; x < 40; x++) {
      const i = (y * W + x) * 4
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = 255
    }
  }
  return data
}

const mask = () => new Uint8Array(W * H).fill(255)
const px = (data: Uint8ClampedArray, x: number, y: number) =>
  data[(y * W + x) * 4]!

describe('localAdjustPixels · 动感模糊', () => {
  it('角度 0° 把竖条向左右抹开，90° 只沿竖直方向抹', () => {
    const horizontal = barImage()
    localAdjustPixels(horizontal, W, H, mask(), {
      effect: 'motionBlur', effectStrength: 100, angle: 0,
    })
    // 远离白条中心、但仍在水平抹开范围内：吃到白条
    expect(px(horizontal, 20, 32)).toBeGreaterThan(0)
    // 白条中心被平均掉一部分，不再是一整块纯白
    expect(px(horizontal, 32, 32)).toBeLessThan(220)

    const vertical = barImage()
    localAdjustPixels(vertical, W, H, mask(), {
      effect: 'motionBlur', effectStrength: 100, angle: 90,
    })
    // 竖直方向不会把中间的白条横向抹到 x=20
    expect(px(vertical, 20, 32)).toBe(0)
    // 白条自己的竖线仍然保留
    expect(px(vertical, 32, 32)).toBe(255)
  })

  it('掩码外逐字节不变；强度 0 = 恒等', () => {
    const data = barImage()
    const before = data.slice()
    const edgeMask = new Uint8Array(W * H)
    for (let y = 8; y < 56; y++) {
      for (let x = 16; x < 64; x++) edgeMask[y * W + x] = 255
    }
    localAdjustPixels(data, W, H, edgeMask, {
      effect: 'motionBlur', effectStrength: 100, angle: 0,
    })
    expect(px(data, 1, 32)).toBe(px(before, 1, 32))
    expect(px(data, W - 2, 32)).toBe(px(before, W - 2, 32))

    const identity = barImage()
    localAdjustPixels(identity, W, H, mask(), {
      effect: 'motionBlur', effectStrength: 0, angle: 90,
    })
    expect(Buffer.from(identity)).toEqual(Buffer.from(barImage()))
  })
})
