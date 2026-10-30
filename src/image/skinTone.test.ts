import { describe, expect, it } from 'vitest'
import type { FaceBox } from '../core/faceDetect'
import { skinTonePixels } from './skinTone'

const W = 200
const H = 220
const FACE: FaceBox = { x: 40, y: 30, w: 120, h: 150, confidence: 1 }

function image(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4)
  const cx = FACE.x + FACE.w / 2
  const cy = FACE.y + FACE.h / 2
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const inFace = Math.hypot((x - cx) / 70, (y - cy) / 82) < 1
      data[i] = inFace ? 210 : 35
      data[i + 1] = inFace ? 170 : 45
      data[i + 2] = inFace ? 150 : 55
      data[i + 3] = 255
    }
  }
  // 眼睛：黑色椭圆；嘴唇：高饱和红。
  const eyeY = FACE.y + FACE.h * 0.38
  for (const ex of [FACE.x + FACE.w * 0.28, FACE.x + FACE.w * 0.72]) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (Math.hypot((x - ex) / 13, (y - eyeY) / 8) >= 1) continue
        const i = (y * W + x) * 4
        data[i] = 20; data[i + 1] = 20; data[i + 2] = 20
      }
    }
  }
  const mouthY = FACE.y + FACE.h * 0.76
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (Math.hypot((x - cx) / 23, (y - mouthY) / 11) >= 1) continue
      const i = (y * W + x) * 4
      data[i] = 180; data[i + 1] = 60; data[i + 2] = 70
    }
  }
  return data
}

const px = (data: Uint8ClampedArray, x: number, y: number) => {
  const i = (y * W + x) * 4
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!] as const
}

const luma = (p: readonly [number, number, number, number]) =>
  0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]

describe('skinTonePixels', () => {
  it('强度和空脸框都为 0 时一个字节都不动', () => {
    const data = image()
    const before = data.slice()
    expect(skinTonePixels(data, W, H, FACE, { whiten: 0, rosy: 0 }).changed).toBe(0)
    expect(skinTonePixels(data, W, H, { ...FACE, w: 0 }, { whiten: 100 }).changed).toBe(0)
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
  })

  it('美白只提亮肤色，眼睛、嘴唇和脸外都不动', () => {
    const data = image()
    const before = data.slice()
    const r = skinTonePixels(data, W, H, FACE, { whiten: 80 })
    expect(r.changed).toBeGreaterThan(0)
    expect(luma(px(data, 100, 90))).toBeGreaterThan(luma(px(before, 100, 90)) + 6)
    expect(px(data, 73, 87), '眼睛不动').toEqual(px(before, 73, 87))
    expect(px(data, 100, 144), '嘴唇不动').toEqual(px(before, 100, 144))
    expect(px(data, 2, 2), '脸外不动').toEqual(px(before, 2, 2))
    expect(px(data, 100, 90)[3], 'alpha 不动').toBe(255)
  })

  it('红润抬红、轻收绿蓝，只作用在肤色上', () => {
    const data = image()
    const before = data.slice()
    skinTonePixels(data, W, H, FACE, { rosy: 80 })
    const p0 = px(before, 100, 90)
    const p1 = px(data, 100, 90)
    expect(p1[0] - (p1[1] + p1[2]) / 2)
      .toBeGreaterThan(p0[0] - (p0[1] + p0[2]) / 2 + 4)
    expect(px(data, 2, 2)).toEqual(px(before, 2, 2))
    expect(px(data, 73, 87)).toEqual(px(before, 73, 87))
    expect(px(data, 100, 144)).toEqual(px(before, 100, 144))
  })
})
