import { describe, expect, it } from 'vitest'
import { estimateSubjectMask, resampleCoverage } from './subjectSelect.ts'

type RGB = [number, number, number]

function paint(
  w: number, h: number,
  background: (x: number, y: number) => RGB,
  subject?: { x0: number; y0: number; x1: number; y1: number; color: RGB },
) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const c = subject && x >= subject.x0 && x < subject.x1 && y >= subject.y0 && y < subject.y1
        ? subject.color
        : background(x, y)
      data[i] = c[0]
      data[i + 1] = c[1]
      data[i + 2] = c[2]
      data[i + 3] = 255
    }
  }
  return data
}

describe('estimateSubjectMask', () => {
  it('纯色背景里的主体被保住，背景被标成 255', () => {
    const w = 80, h = 60
    const data = paint(w, h, () => [40, 150, 205], {
      x0: 24, y0: 12, x1: 56, y1: 50, color: [205, 75, 55],
    })
    const result = estimateSubjectMask(data, w, h)

    expect(result.mask[2 * w + 2]).toBe(255)
    expect(result.mask[30 * w + 40]).toBe(0)
    expect(result.subjectRatio).toBeGreaterThan(0.15)
    expect(result.subjectRatio).toBeLessThan(0.5)
  })

  it('背景有渐变也按颜色模型分开，不把整张图都当主体', () => {
    const w = 80, h = 60
    const data = paint(w, h, (x, y) => [
      30 + Math.round(x * 0.7),
      90 + Math.round(y * 0.8),
      150 + Math.round((x + y) * 0.4),
    ], {
      x0: 28, y0: 10, x1: 54, y1: 52, color: [220, 80, 45],
    })
    const result = estimateSubjectMask(data, w, h)

    expect(result.mask[2 * w + 2]).toBe(255)
    expect(result.mask[30 * w + 40]).toBe(0)
    expect(result.subjectRatio).toBeLessThan(0.6)
  })

  it('主体触底不会被整块删掉', () => {
    const w = 64, h = 64
    const data = paint(w, h, () => [30, 145, 210], {
      x0: 20, y0: 8, x1: 44, y1: 64, color: [210, 85, 50],
    })
    const result = estimateSubjectMask(data, w, h)

    expect(result.mask[55 * w + 32]).toBe(0)
    expect(result.mask[62 * w + 2]).toBe(255)
  })

  it('边缘的小块异色杂物不会长成一个假主体', () => {
    const w = 80, h = 60
    const data = paint(w, h, () => [35, 150, 205], {
      x0: 28, y0: 14, x1: 52, y1: 48, color: [210, 80, 55],
    })
    for (let y = 1; y < 5; y++) {
      for (let x = 1; x < 6; x++) {
        const i = (y * w + x) * 4
        data[i] = 245; data[i + 1] = 235; data[i + 2] = 30
      }
    }
    const result = estimateSubjectMask(data, w, h)

    expect(result.mask[2 * w + 2]).toBe(255)
    expect(result.mask[30 * w + 40]).toBe(0)
  })

  it('没有主体时给出低占比，交给上层提示而不是乱删', () => {
    const w = 48, h = 40
    const data = paint(w, h, (x, y) => [
      100 + (x % 3), 120 + (y % 3), 140,
    ])
    const result = estimateSubjectMask(data, w, h)

    expect(result.subjectRatio).toBeLessThan(0.02)
  })

  it('主体边缘有半覆盖过渡，不是一刀硬边', () => {
    const w = 80, h = 60
    const data = paint(w, h, () => [40, 150, 205], {
      x0: 24, y0: 12, x1: 56, y1: 50, color: [205, 75, 55],
    })
    const { mask } = estimateSubjectMask(data, w, h)

    expect(Array.from(mask).some(v => v > 0 && v < 255)).toBe(true)
  })

  it('人像：脸和头发都保住，哪怕墙色和肤色接近', () => {
    const w = 80, h = 60
    const data = paint(w, h, () => [185, 170, 158], {
      x0: 28, y0: 16, x1: 52, y1: 46, color: [205, 155, 135],
    })
    for (let y = 5; y < 22; y++) {
      for (let x = 20; x < 60; x++) {
        const i = (y * w + x) * 4
        data[i] = 42; data[i + 1] = 28; data[i + 2] = 22
      }
    }
    const result = estimateSubjectMask(data, w, h)

    expect(result.mask[2 * w + 2]).toBe(255)
    expect(result.mask[30 * w + 40]).toBe(0)
    expect(result.mask[12 * w + 24]).toBe(0)
  })

  it('尺寸不对要报错', () => {
    expect(() => estimateSubjectMask(new Uint8ClampedArray(12), 4, 4))
      .toThrow(/像素尺寸/)
  })
})

describe('resampleCoverage', () => {
  it('双线性放大后尺寸正确、角点保持、分界出现过渡', () => {
    const out = resampleCoverage(
      Uint8Array.from([255, 255, 0, 0]), 2, 2, 8, 8,
    )
    expect(out).toHaveLength(64)
    expect(out[0]).toBe(255)
    expect(out[out.length - 1]).toBe(0)
    expect(Array.from(out).some(v => v > 0 && v < 255)).toBe(true)
  })
})
