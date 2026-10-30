import { describe, expect, it } from 'vitest'
import { faceShapePixels } from './faceShape.ts'

const FACE = { x: 30, y: 20, w: 40, h: 50, confidence: 1 }

const base = (w = 100, h = 100) => {
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

const countWhite = (data: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number) => {
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (px(data, w, x, y)[0] > 200) n++
    }
  }
  return n
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

const whiteCentroidY = (
  data: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number,
) => {
  let sum = 0, n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const weight = Math.max(0, px(data, w, x, y)[0] - 98)
      if (weight > 0) { sum += y * weight; n += weight }
    }
  }
  return n ? sum / n : 0
}

describe('faceShapePixels', () => {
  it('全零 = 一个字节都不动', () => {
    const w = 100, h = 100
    const data = base(w, h)
    const before = data.slice()
    const r = faceShapePixels(data, w, h, FACE, { slim: 0, eyes: 0, nose: 0, chin: 0 })
    expect(r.changed).toBe(0)
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
  })

  it('瘦脸：脸颊外侧的竖线向中心收，脸外不动', () => {
    const w = 100, h = 100
    const data = base(w, h)
    const cheekY = FACE.y + Math.round(FACE.h * 0.45)
    const lineX = FACE.x + Math.round(FACE.w * 0.82)
    for (let y = FACE.y; y < FACE.y + FACE.h; y++) {
      const i = (y * w + lineX) * 4
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
    }
    const outside = px(data, w, 2, 2)
    const beforeInner = px(data, w, lineX - 2, cheekY)[0]
    faceShapePixels(data, w, h, FACE, { slim: 100 })

    expect(px(data, w, lineX, cheekY)[0]).toBeLessThan(240)
    expect(px(data, w, lineX - 2, cheekY)[0]).toBeGreaterThan(beforeInner + 40)
    expect(px(data, w, 2, 2)).toEqual(outside)
  })

  it('颅顶：额头上方向下取样、内容整体上移，脸下方和脸外不动', () => {
    const w = 100, h = 100
    const data = base(w, h)
    // 一条位于额头中段下方的白带：颅顶把下面的内容向上拉，应该出现在上方。
    for (let y = 27; y <= 30; y++) {
      for (let x = 38; x <= 62; x++) {
        const i = (y * w + x) * 4
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
      }
    }
    const beforeTop = px(data, w, 50, 18)[0]
    const faceBelow = px(data, w, 50, FACE.y + Math.round(FACE.h * 0.7))
    const outside = px(data, w, 2, 2)
    faceShapePixels(data, w, h, FACE, { crown: 100 })

    expect(beforeTop, '上方原本是底色').toBeLessThan(120)
    expect(px(data, w, 50, 18)[0], '下方白带被拉到额头').toBeGreaterThan(180)
    expect(px(data, w, 50, FACE.y + Math.round(FACE.h * 0.7))).toEqual(faceBelow)
    expect(px(data, w, 2, 2)).toEqual(outside)
  })

  it('大眼：眼周的小白块被放大，脸外不动', () => {
    const w = 100, h = 100
    const data = base(w, h)
    const ex = FACE.x + Math.round(FACE.w * 0.3)
    const ey = FACE.y + Math.round(FACE.h * 0.42)
    for (let y = ey - 3; y <= ey + 3; y++) {
      for (let x = ex - 3; x <= ex + 3; x++) {
        const i = (y * w + x) * 4
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
      }
    }
    const before = countWhite(data, w, ex - 12, ey - 12, ex + 13, ey + 13)
    const outside = px(data, w, 2, 2)
    faceShapePixels(data, w, h, FACE, { eyes: 100 })
    const after = countWhite(data, w, ex - 12, ey - 12, ex + 13, ey + 13)

    expect(after).toBeGreaterThan(before)
    expect(px(data, w, 2, 2)).toEqual(outside)
  })

  it('微笑：嘴角白块被斜向上提，脸外不动', () => {
    const w = 100, h = 100
    const data = base(w, h)
    const cornerX = FACE.x + Math.round(FACE.w * 0.32)
    const cornerY = FACE.y + Math.round(FACE.h * 0.76)
    for (let y = cornerY; y <= cornerY + 3; y++) {
      for (let x = cornerX - 2; x <= cornerX + 2; x++) {
        const i = (y * w + x) * 4
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
      }
    }
    const before = whiteCentroidY(data, w, cornerX - 5, cornerY - 8, cornerX + 6, cornerY + 8)
    const outside = px(data, w, 2, 2)
    faceShapePixels(data, w, h, FACE, { smile: 100 })
    const after = whiteCentroidY(data, w, cornerX - 5, cornerY - 8, cornerX + 6, cornerY + 8)

    expect(after).toBeLessThan(before - 0.5)
    expect(px(data, w, 2, 2)).toEqual(outside)
  })

  it('下巴：只动下半张脸，外包框外逐字节不变', () => {
    const w = 100, h = 100
    const data = base(w, h)
    const lowerY = FACE.y + Math.round(FACE.h * 0.8)
    const lineX = FACE.x + Math.round(FACE.w * 0.22)
    for (let y = lowerY - 5; y <= lowerY + 5; y++) {
      const i = (y * w + lineX) * 4
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
    }
    const beforeTop = px(data, w, 50, FACE.y + 2)
    const outside = px(data, w, 2, 2)
    faceShapePixels(data, w, h, FACE, { chin: 100 })

    expect(px(data, w, 50, FACE.y + 2)).toEqual(beforeTop)
    expect(px(data, w, 2, 2)).toEqual(outside)
    expect(px(data, w, lineX, lowerY)[0]).toBeLessThan(240)
  })

  it('瘦颈：下巴下方的竖线向中心收，脸本身不动', () => {
    const w = 100, h = 130
    const data = base(w, h)
    const neckY = 76
    const lineX = 65
    for (let y = 72; y <= 92; y++) {
      const i = (y * w + lineX) * 4
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
    }
    const faceBefore = px(data, w, 50, 30)
    const outside = px(data, w, 2, 2)
    faceShapePixels(data, w, h, FACE, { neck: 100 })

    expect(px(data, w, 50, 30), '脸本身不动').toEqual(faceBefore)
    expect(px(data, w, 2, 2), '颈外不动').toEqual(outside)
    expect(px(data, w, lineX, neckY)[0]).toBeLessThan(240)
    expect(px(data, w, lineX - 2, neckY)[0]).toBeGreaterThan(110)
  })

  it('双下巴：下巴下方的白带被向上提，脸顶和画面外不动', () => {
    const w = 100, h = 130
    const data = base(w, h)
    for (let y = 68; y <= 70; y++) {
      for (let x = 40; x <= 60; x++) {
        const i = (y * w + x) * 4
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
      }
    }
    const faceBefore = px(data, w, 50, 22)
    const outside = px(data, w, 2, 2)
    faceShapePixels(data, w, h, FACE, { doubleChin: 100 })

    expect(px(data, w, 50, 22), '脸顶不动').toEqual(faceBefore)
    expect(px(data, w, 2, 2), '画面外不动').toEqual(outside)
    expect(px(data, w, 50, 66)[0], '白带被提到更上方').toBeGreaterThan(180)
  })

  it('直角肩：肩线外侧的白带被抬起，脸中心和画面外不动', () => {
    const w = 100, h = 130
    const data = base(w, h)
    for (let y = 88; y <= 90; y++) {
      for (let x = 15; x <= 35; x++) {
        const i = (y * w + x) * 4
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
      }
    }
    const faceBefore = px(data, w, 50, 20)
    const outside = px(data, w, 2, 2)
    const centerBefore = px(data, w, 50, 86)
    faceShapePixels(data, w, h, FACE, { shoulder: 100 })

    expect(px(data, w, 50, 20), '脸顶不动').toEqual(faceBefore)
    expect(px(data, w, 2, 2), '画面外不动').toEqual(outside)
    expect(px(data, w, 50, 86), '肩线中心不被抬').toEqual(centerBefore)
    expect(px(data, w, 20, 86)[0], '肩线外侧被抬起').toBeGreaterThan(180)
  })

  it('瘦身：脸下方的一条竖线向中心收，脸本身不动', () => {
    const w = 100, h = 130
    const data = base(w, h)
    const bodyY = 100
    const lineX = 80
    for (let y = 52; y < h; y++) {
      const i = (y * w + lineX) * 4
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
    }
    const faceBefore = px(data, w, 50, 30)
    faceShapePixels(data, w, h, FACE, { body: 100 })

    expect(px(data, w, 50, 30)).toEqual(faceBefore)
    expect(px(data, w, lineX, bodyY)[0]).toBeLessThan(240)
    expect(px(data, w, lineX - 4, bodyY)[0]).toBeGreaterThan(110)
  })

  it('长腿：身体中段的白线被向下拉，脸和身体外不动', () => {
    const w = 100, h = 130
    const data = base(w, h)
    const faceBefore = px(data, w, 50, 30)
    const outside = px(data, w, 2, 2)
    for (let y = 67; y <= 69; y++) {
      for (let x = 40; x <= 60; x++) {
        const i = (y * w + x) * 4
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
      }
    }
    faceShapePixels(data, w, h, FACE, { legs: 100 })

    expect(px(data, w, 50, 30), '脸本身不动').toEqual(faceBefore)
    expect(px(data, w, 2, 2), '身体外不动').toEqual(outside)
    expect(px(data, w, 50, 75)[0], '上方白线被拉到身体中段').toBeGreaterThan(180)
  })

  it('瘦鼻：鼻翼一侧的竖线向中线收，脸外不动', () => {
    const w = 100, h = 100
    const data = base(w, h)
    const noseY = FACE.y + Math.round(FACE.h * 0.58)
    for (let y = noseY - 6; y <= noseY + 6; y++) {
      for (let x = 45; x <= 47; x++) {
        const i = (y * w + x) * 4
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
      }
    }
    const outside = px(data, w, 2, 2)
    const before = whiteCentroidX(data, w, 38, noseY - 8, 51, noseY + 8)
    faceShapePixels(data, w, h, FACE, { nose: 100 })
    const after = whiteCentroidX(data, w, 38, noseY - 8, 51, noseY + 8)

    expect(after).toBeGreaterThan(before + 0.4)
    expect(px(data, w, 2, 2)).toEqual(outside)
  })

  it('尺寸不对要报错', () => {
    expect(() => faceShapePixels(new Uint8ClampedArray(8), 4, 4, FACE, { slim: 50 }))
      .toThrow(/像素尺寸/)
  })
})
