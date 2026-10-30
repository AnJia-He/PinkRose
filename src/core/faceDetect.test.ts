import { describe, expect, it } from 'vitest'
import { detectFaceBox, detectFaceBoxes } from './faceDetect.ts'

function image(w: number, h: number, face: { x0: number; y0: number; x1: number; y1: number }) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const skin = x >= face.x0 && x < face.x1 && y >= face.y0 && y < face.y1
      data[i] = skin ? 205 : 35
      data[i + 1] = skin ? 155 : 140
      data[i + 2] = skin ? 135 : 210
      data[i + 3] = 255
    }
  }
  return data
}

function imageWithFaces(
  w: number, h: number,
  faces: { x0: number; y0: number; x1: number; y1: number }[],
) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const skin = faces.some(face => (
        x >= face.x0 && x < face.x1 && y >= face.y0 && y < face.y1
      ))
      data[i] = skin ? 205 : 35
      data[i + 1] = skin ? 155 : 140
      data[i + 2] = skin ? 135 : 210
      data[i + 3] = 255
    }
  }
  return data
}

function twoFragmentsOfOneFace(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      // 大块是 L 形额头 / 侧脸，小碎片在右下方；两者像素不相连，
      // 但小碎片的框落在大框里。只按 IoU 会把它误当成第二张脸。
      const main = (x >= 20 && x < 132 && y >= 20 && y < 40)
        || (x >= 20 && x < 40 && y >= 20 && y < 132)
      const fragment = x >= 100 && x < 135 && y >= 100 && y < 135
      const skin = main || fragment
      data[i] = skin ? 205 : 35
      data[i + 1] = skin ? 155 : 140
      data[i + 2] = skin ? 135 : 210
      data[i + 3] = 255
    }
  }
  return data
}

describe('detectFaceBox', () => {
  it('找到居中的肤色区域，并按脸形收住高度', () => {
    const w = 120, h = 100
    const data = image(w, h, { x0: 40, y0: 20, x1: 80, y1: 82 })
    const face = detectFaceBox(data, w, h)
    expect(face).not.toBeNull()
    expect(face!.x).toBeLessThanOrEqual(40)
    expect(face!.x + face!.w).toBeGreaterThanOrEqual(80)
    expect(face!.h).toBeLessThanOrEqual(face!.w * 1.45)
    expect(face!.confidence).toBeGreaterThan(0.5)
  })

  it('没有足够肤色就不硬猜', () => {
    const w = 80, h = 60
    const data = image(w, h, { x0: -1, y0: -1, x1: -1, y1: -1 })
    expect(detectFaceBox(data, w, h)).toBeNull()
  })

  it('边缘的一块肤色不算正脸', () => {
    const w = 120, h = 100
    const data = image(w, h, { x0: 0, y0: 0, x1: 18, y1: 55 })
    expect(detectFaceBox(data, w, h)).toBeNull()
  })

  it('尺寸不对要报错', () => {
    expect(() => detectFaceBox(new Uint8ClampedArray(8), 4, 4))
      .toThrow(/像素尺寸/)
  })

  it('合影：返回两张分开的脸，并按 maxFaces 截断', () => {
    const w = 200, h = 120
    const data = imageWithFaces(w, h, [
      { x0: 20, y0: 30, x1: 60, y1: 84 },
      { x0: 120, y0: 30, x1: 160, y1: 84 },
    ])
    const faces = detectFaceBoxes(data, w, h)
    expect(faces).toHaveLength(2)
    expect(faces[0]!.x + faces[0]!.w / 2).toBeLessThan(w / 2)
    expect(faces[1]!.x + faces[1]!.w / 2).toBeGreaterThan(w / 2)
    expect(detectFaceBoxes(data, w, h, 1)).toHaveLength(1)
  })

  it('同一张脸被拆成重叠的大块和碎片时，只返回一个脸框', () => {
    const data = twoFragmentsOfOneFace(200, 180)
    const faces = detectFaceBoxes(data, 200, 180)
    expect(faces).toHaveLength(1)
    expect(faces[0]!.y).toBeLessThan(80)
  })
})
