import { describe, expect, it } from 'vitest'
import { faceShapePixels, headScaledFace } from './faceShape.ts'

const FACE = { x: 30, y: 20, w: 40, h: 50, confidence: 1 }

const base = (w: number, h: number) => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 98
    data[i * 4 + 1] = 106
    data[i * 4 + 2] = 114
    data[i * 4 + 3] = 255
  }
  return data
}

const px = (data: Uint8ClampedArray, w: number, x: number, y: number) => {
  const i = (y * w + x) * 4
  return [data[i]!, data[i + 1]!, data[i + 2]!] as const
}

const whiteCentroidX = (
  data: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number,
) => {
  let sum = 0, n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const weight = Math.max(0, px(data, w, x, y)[0] - 98)
      if (weight > 0) { sum += x * weight; n += weight }
    }
  }
  return n ? sum / n : 0
}

describe('head scale', () => {
  it('shrinks the head area and keeps the face-box centre', () => {
    const w = 100, h = 100
    const data = base(w, h)
    const lineX = FACE.x + Math.round(FACE.w * 0.85)
    for (let y = FACE.y; y < FACE.y + FACE.h; y++) {
      const i = (y * w + lineX) * 4
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
    }
    const before = whiteCentroidX(data, w, 40, 30, 75, 60)
    const outside = px(data, w, 2, 2)
    faceShapePixels(data, w, h, FACE, { head: 100 })
    const after = whiteCentroidX(data, w, 40, 30, 75, 60)

    expect(after).toBeLessThan(before - 0.5)
    expect(px(data, w, 2, 2)).toEqual(outside)
    const face = headScaledFace(FACE, 100)
    expect(face.w).toBeLessThan(FACE.w)
    expect(face.h).toBeLessThan(FACE.h)
    expect(face.x + face.w / 2).toBeCloseTo(FACE.x + FACE.w / 2)
    expect(face.y + face.h / 2).toBeCloseTo(FACE.y + FACE.h / 2)
  })

  it('head=0 leaves the face box untouched', () => {
    expect(headScaledFace(FACE, 0)).toEqual(FACE)
  })
})
