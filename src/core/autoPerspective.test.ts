import { describe, expect, it } from 'vitest'
import { detectVerticalPerspective } from './autoPerspective.ts'

function architectureImage(
  width: number,
  height: number,
  leftTop: number,
  rightTop: number,
  leftBottom: number,
  rightBottom: number,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 28
    data[i * 4 + 1] = 34
    data[i * 4 + 2] = 42
    data[i * 4 + 3] = 255
  }
  const line = (x0: number, x1: number) => {
    for (let y = 0; y < height; y++) {
      const t = y / Math.max(1, height - 1)
      const x = Math.round(x0 + (x1 - x0) * t)
      for (let dx = -1; dx <= 1; dx++) {
        const px = Math.max(0, Math.min(width - 1, x + dx))
        const i = (y * width + px) * 4
        data[i] = 238
        data[i + 1] = 241
        data[i + 2] = 246
      }
    }
  }
  line(leftTop * width, leftBottom * width)
  line(rightTop * width, rightBottom * width)
  return data
}

describe('自动垂直透视', () => {
  it('找到向底部张开的左右竖边，给出可拉正的四角', () => {
    const width = 240
    const height = 320
    const data = architectureImage(width, height, 0.28, 0.72, 0.16, 0.84)

    const quad = detectVerticalPerspective(data, width, height)

    expect(quad).not.toBeNull()
    expect(Math.abs(quad![0].x - 0.28)).toBeLessThan(0.035)
    expect(Math.abs(quad![1].x - 0.72)).toBeLessThan(0.035)
    expect(Math.abs(quad![2].x - 0.84)).toBeLessThan(0.035)
    expect(Math.abs(quad![3].x - 0.16)).toBeLessThan(0.035)
    expect(quad![0].y).toBe(0)
    expect(quad![2].y).toBe(1)
  })

  it('平行竖边不需要透视，返回 null 而不是硬拉一个四角', () => {
    const width = 240
    const height = 320
    const data = architectureImage(width, height, 0.28, 0.72, 0.28, 0.72)
    expect(detectVerticalPerspective(data, width, height)).toBeNull()
  })

  it('没有可信竖边时返回 null', () => {
    const width = 80
    const height = 80
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = 94
      data[i * 4 + 1] = 108
      data[i * 4 + 2] = 121
      data[i * 4 + 3] = 255
    }
    expect(detectVerticalPerspective(data, width, height)).toBeNull()
  })
})
