import { describe, expect, it } from 'vitest'
import { computeIdPhotoCrop, ID_PHOTO_SIZES } from './idPhoto.ts'

const face = { x: 300, y: 150, w: 300, h: 360, confidence: 0.9 }

describe('computeIdPhotoCrop', () => {
  it('按目标比例裁，脸在画面中部，头顶留出余量', () => {
    const crop = computeIdPhotoCrop(face, 1200, 1600, 295, 413)
    expect(crop.w / crop.h).toBeCloseTo(295 / 413, 1)
    expect(crop.x).toBeLessThan(face.x + face.w / 2)
    expect(crop.x + crop.w).toBeGreaterThan(face.x + face.w / 2)
    expect(crop.y).toBeLessThan(face.y)
    expect(crop.y).toBeGreaterThanOrEqual(0)
  })

  it('脸贴边时裁框不越界', () => {
    const crop = computeIdPhotoCrop(
      { ...face, x: 0, y: 0 }, 1200, 1600, 413, 579,
    )
    expect(crop.x).toBeGreaterThanOrEqual(0)
    expect(crop.y).toBeGreaterThanOrEqual(0)
    expect(crop.x + crop.w).toBeLessThanOrEqual(1200)
    expect(crop.y + crop.h).toBeLessThanOrEqual(1600)
  })

  it('没有脸：取居中的最大目标比例区域', () => {
    const crop = computeIdPhotoCrop(null, 1000, 1000, 295, 413)
    expect(crop.w / crop.h).toBeCloseTo(295 / 413, 1)
    expect(crop.x + crop.w / 2).toBeCloseTo(500, 0)
    expect(crop.y + crop.h / 2).toBeCloseTo(500, 0)
  })

  it('四套标准尺寸都是竖版且像素合理', () => {
    expect(ID_PHOTO_SIZES).toHaveLength(4)
    for (const s of ID_PHOTO_SIZES) {
      expect(s.height).toBeGreaterThan(s.width)
      expect(s.width).toBeGreaterThan(200)
    }
  })
})
