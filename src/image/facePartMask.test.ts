import { describe, expect, it } from 'vitest'
import { buildEyeMask, buildTeethMask, buildUnderEyeMask } from './facePartMask.ts'

const FACE = { x: 20, y: 10, w: 40, h: 50, confidence: 0.9 }

describe('facePartMask', () => {
  it('自动眼睛：两只眼的椭圆内高覆盖，嘴和脸外为 0', () => {
    const w = 100, h = 100
    const mask = buildEyeMask(FACE, w, h)
    const leftX = Math.round(FACE.x + FACE.w * 0.3)
    const rightX = Math.round(FACE.x + FACE.w * 0.7)
    const eyeY = Math.round(FACE.y + FACE.h * 0.42)
    const mouthY = Math.round(FACE.y + FACE.h * 0.76)

    expect(mask[eyeY * w + leftX]).toBeGreaterThan(180)
    expect(mask[eyeY * w + rightX]).toBeGreaterThan(180)
    expect(mask[mouthY * w + 40]).toBe(0)
    expect(mask[2 * w + 2]).toBe(0)
  })

  it('自动牙齿：嘴里的白牙被选中，红唇和嘴外不选', () => {
    const w = 100, h = 100
    const data = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 90; data[i * 4 + 1] = 100; data[i * 4 + 2] = 110
      data[i * 4 + 3] = 255
    }
    const mouthY = Math.round(FACE.y + FACE.h * 0.76)
    for (let y = mouthY - 5; y <= mouthY + 5; y++) {
      for (let x = 25; x <= 55; x++) {
        const i = (y * w + x) * 4
        // 中间一排白牙，其余是红唇
        const teeth = y >= mouthY - 1 && y <= mouthY + 1
        data[i] = teeth ? 235 : 210
        data[i + 1] = teeth ? 235 : 40
        data[i + 2] = teeth ? 235 : 55
      }
    }
    const mask = buildTeethMask(data, w, h, FACE)
    expect(mask[mouthY * w + 40]).toBeGreaterThan(160)
    expect(mask[(mouthY - 4) * w + 40]).toBe(0)
    expect(mask[2 * w + 2]).toBe(0)
  })

  it('自动眼下：两块眼下软选区覆盖泪沟，眼球和脸外不选', () => {
    const w = 100, h = 100
    const mask = buildUnderEyeMask(FACE, w, h)
    const leftX = Math.round(FACE.x + FACE.w * 0.3)
    const rightX = Math.round(FACE.x + FACE.w * 0.7)
    const underY = Math.round(FACE.y + FACE.h * 0.56)
    const eyeY = Math.round(FACE.y + FACE.h * 0.42)

    expect(mask[underY * w + leftX]).toBeGreaterThan(180)
    expect(mask[underY * w + rightX]).toBeGreaterThan(180)
    expect(mask[eyeY * w + leftX], '上缘不碰眼球').toBe(0)
    expect(mask[2 * w + 2], '脸外不选').toBe(0)
    // 椭圆边缘是软的：中心满覆盖，外缘明显更低。
    const edge = Math.round(leftX + FACE.w * 0.15)
    expect(mask[underY * w + edge]).toBeLessThan(mask[underY * w + leftX]!)
  })
})
