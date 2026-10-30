import { describe, expect, it } from 'vitest'
import { smartCropRect, smartCropRectForAspect, subjectBoundsFromCoverage } from './smartCrop'

describe('subjectBoundsFromCoverage', () => {
  it('只认过半覆盖的主体像素，返回归一化外接框', () => {
    const w = 100, h = 80
    const mask = new Uint8Array(w * h)
    // 软边 127 不算；128 才算。外接框故意不贴着画面边。
    mask[20 * w + 20] = 127
    mask[20 * w + 21] = 128
    mask[40 * w + 60] = 255

    const box = subjectBoundsFromCoverage(mask, w, h)
    expect(box).not.toBeNull()
    expect(box!.x0).toBeCloseTo(21 / w, 8)
    expect(box!.y0).toBeCloseTo(20 / h, 8)
    expect(box!.x1).toBeCloseTo(61 / w, 8)
    expect(box!.y1).toBeCloseTo(41 / h, 8)
    expect(box!.count).toBe(2)
    expect(box!.ratio).toBeCloseTo(2 / (w * h), 8)
  })

  it('空覆盖率返回 null', () => {
    expect(subjectBoundsFromCoverage(new Uint8Array(100), 10, 10)).toBeNull()
  })

  it('尺寸不对要报错，别静默读错位置', () => {
    expect(() => subjectBoundsFromCoverage(new Uint8Array(12), 4, 4))
      .toThrow(/尺寸/)
  })
})

describe('smartCropRect', () => {
  const inner = { x: 0, y: 0, w: 1, h: 1 }

  it('把 1:1 框移到右侧主体上，同时不越出画面', () => {
    const rect = smartCropRect(
      { x: 1 / 6, y: 0, w: 2 / 3, h: 1 },
      inner,
      1200,
      800,
      0,
      { x0: 0.55, y0: 0.2, x1: 0.75, y1: 0.7 },
    )

    // 主体中心 0.65；框宽 2/3，所以框左边界是 0.65 - 1/3。
    expect(rect.x).toBeCloseTo(0.65 - 1 / 3, 8)
    expect(rect.w).toBeCloseTo(2 / 3, 8)
    expect(rect.y).toBeCloseTo(0, 8)
  })

  it('主体在左侧时贴左，不把框甩出画外', () => {
    const rect = smartCropRect(
      { x: 1 / 6, y: 0, w: 2 / 3, h: 1 },
      inner,
      1200,
      800,
      0,
      { x0: 0.05, y0: 0.2, x1: 0.25, y1: 0.7 },
    )
    expect(rect.x).toBe(0)
  })

  it('有旋转时先换算到旋转后的外框坐标，再决定框的位置', () => {
    const rect = smartCropRect(
      { x: 0, y: 1 / 6, w: 1, h: 2 / 3 },
      inner,
      1200,
      800,
      90,
      // 原图左中部：转 90° 后落到外框下半部。
      { x0: 0.1, y0: 0.4, x1: 0.3, y1: 0.6 },
    )
    expect(rect.x).toBeCloseTo(0, 8)
    expect(rect.y).toBeCloseTo(1 / 3, 8)
  })

  it('主体已经居中时返回原来的框（不无端抖动）', () => {
    const current = { x: 0.2, y: 0.3, w: 0.6, h: 0.4 }
    const rect = smartCropRect(
      current,
      { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      1200,
      800,
      0,
      { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 },
    )
    expect(rect).toEqual(current)
  })
})

describe('smartCropRectForAspect', () => {
  it('1:1 取最大方形，并把框移到右侧主体上', () => {
    const rect = smartCropRectForAspect(1200, 800, 1, {
      x0: 0.68, y0: 0.25, x1: 0.78, y1: 0.6,
    })
    expect(rect.w).toBe(800)
    expect(rect.h).toBe(800)
    // 主体中心 x=0.73*1200=876；框半宽 400，所以左边最多到 400。
    expect(rect.x).toBe(400)
    expect(rect.y).toBe(0)
  })

  it('主体靠左时贴左，不越出画面', () => {
    const rect = smartCropRectForAspect(1200, 800, 1, {
      x0: 0.04, y0: 0.25, x1: 0.14, y1: 0.6,
    })
    expect(rect.x).toBe(0)
  })

  it('竖图取 4:5 时按高度算最大框', () => {
    const rect = smartCropRectForAspect(1200, 1600, 4 / 5, {
      x0: 0.4, y0: 0.5, x1: 0.6, y1: 0.7,
    })
    expect(rect.w).toBe(1200)
    expect(rect.h).toBe(1500)
    expect(rect.x).toBe(0)
    expect(rect.y).toBe(100)
  })

  it('非法比例退回整张图，不制造空裁切', () => {
    expect(smartCropRectForAspect(100, 80, 0, { x0: 0, y0: 0, x1: 1, y1: 1 }))
      .toEqual({ x: 0, y: 0, w: 100, h: 80 })
  })
})
