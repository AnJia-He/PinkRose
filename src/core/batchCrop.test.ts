import { describe, expect, it } from 'vitest'
import {
  clampBatchCrop, cropAtZoom, cropPixels, maxCropForAspect,
  moveCropBy, moveCropTo, zoomOfCrop,
} from './batchCrop.ts'

describe('batch crop', () => {
  it('取目标比例的最大框，宽高比按像素算而不是按归一化方格算', () => {
    const wide = maxCropForAspect(1200, 800, 1)
    expect(wide.x).toBeCloseTo(1 / 6, 8)
    expect(wide.y).toBe(0)
    expect(wide.w).toBeCloseTo(2 / 3, 8)
    expect(wide.h).toBe(1)
    expect((wide.w * 1200) / (wide.h * 800)).toBeCloseTo(1, 8)

    const portrait = maxCropForAspect(800, 1200, 1)
    expect(portrait.x).toBe(0)
    expect(portrait.y).toBeCloseTo(1 / 6, 8)
    expect(portrait.w).toBe(1)
    expect(portrait.h).toBeCloseTo(2 / 3, 8)
    expect((portrait.w * 800) / (portrait.h * 1200)).toBeCloseTo(1, 8)
  })

  it('zoom 以中心缩小，中心不动；移出边界时整框平移回来', () => {
    const atOne = cropAtZoom(1200, 800, 1, 1)
    expect(atOne.x).toBeCloseTo(1 / 6, 8)
    expect(atOne.y).toBe(0)
    expect(atOne.w).toBeCloseTo(2 / 3, 8)
    expect(atOne.h).toBe(1)

    const atTwo = cropAtZoom(1200, 800, 1, 2)
    expect(atTwo.w).toBeCloseTo(1 / 3, 8)
    expect(atTwo.h).toBeCloseTo(1 / 2, 8)
    expect(atTwo.x).toBeCloseTo(1 / 3, 8)
    expect(atTwo.y).toBeCloseTo(1 / 4, 8)

    const nearLeft = cropAtZoom(1200, 800, 1, 2, 0, 0.5)
    expect(nearLeft.x).toBe(0)
    expect(nearLeft.w).toBeCloseTo(1 / 3, 8)
  })

  it('moveCropTo / moveCropBy 都钳在画面内，负数和不合法值不越界', () => {
    const base = cropAtZoom(1200, 800, 4 / 5, 1)
    expect(moveCropTo(base, -3, 9)).toMatchObject({ x: 0, y: 0 })
    expect(moveCropTo(base, 0.5, 0.5).x).toBeCloseTo(0.5 - base.w / 2, 8)
    expect(moveCropTo(base, 0.5, 0.5).y).toBe(0)

    const moved = moveCropBy(base, 99, -99)
    expect(moved.x).toBeCloseTo(1 - moved.w, 8)
    expect(moved.y).toBe(0)

    expect(clampBatchCrop({ x: -1, y: 2, w: 0, h: Number.NaN }))
      .toEqual({ x: 0, y: 0, w: 0.02, h: 1 })
  })

  it('zoomOfCrop 能把取景框换算回滑杆读数', () => {
    const rect = cropAtZoom(1200, 800, 1, 2.5)
    expect(zoomOfCrop(1200, 800, 1, rect)).toBe(250)
  })

  it('cropPixels 输出至少 1×1，并夹在原图范围内', () => {
    expect(cropPixels({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 100, 80))
      .toEqual({ x: 50, y: 40, w: 50, h: 40 })
    expect(cropPixels({ x: 2, y: -1, w: 0, h: 0 }, 10, 20))
      .toEqual({ x: 9, y: 0, w: 1, h: 1 })
  })
})
