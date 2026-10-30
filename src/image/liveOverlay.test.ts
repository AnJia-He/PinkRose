import { describe, expect, it } from 'vitest'
import {
  liveLoupeCrop, liveZoomCrop, paintFalseColor, paintFocusPeaking, paintZebra,
} from './liveOverlay'

function image(w: number, h: number, rgb: [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0]
    data[i + 1] = rgb[1]
    data[i + 2] = rgb[2]
    data[i + 3] = 255
  }
  return data
}

describe('实时取景叠加', () => {
  it('对焦峰值只标出高反差边缘，平坦区域不涂红', () => {
    const flat = image(5, 5, [128, 128, 128])
    expect(paintFocusPeaking(flat, 5, 5, 40)).toBe(0)
    expect([...flat.slice(0, 4)]).toEqual([128, 128, 128, 255])

    const edge = image(7, 7, [20, 20, 20])
    for (let y = 0; y < 7; y++) {
      for (let x = 3; x < 7; x++) {
        const i = (y * 7 + x) * 4
        edge[i] = 220
        edge[i + 1] = 220
        edge[i + 2] = 220
      }
    }
    expect(paintFocusPeaking(edge, 7, 7, 40)).toBeGreaterThan(0)
    const marked = edge[(3 * 7 + 3) * 4]!
    const green = edge[(3 * 7 + 3) * 4 + 1]!
    expect(marked).toBeGreaterThan(green + 80)
  })

  it('对焦放大以点击位置为中心，并夹在画面边界内', () => {
    expect(liveZoomCrop(1000, 500, 1, 0.5, 0.5))
      .toEqual({ x: 0, y: 0, w: 1000, h: 500 })
    expect(liveZoomCrop(1000, 500, 2, 0.5, 0.5))
      .toEqual({ x: 250, y: 125, w: 500, h: 250 })
    expect(liveZoomCrop(1000, 500, 2, 0, 0))
      .toEqual({ x: 0, y: 0, w: 500, h: 250 })
    expect(liveZoomCrop(1000, 500, 4, 1, 1))
      .toEqual({ x: 750, y: 375, w: 250, h: 125 })
  })

  it('★ 100% 放大镜围绕点击位置取固定大小的原生像素', () => {
    const center = liveLoupeCrop(1024, 680, 0.5, 0.5)
    expect(center.w).toBeLessThanOrEqual(320)
    expect(center.h).toBeLessThanOrEqual(200)
    expect(center.x).toBeGreaterThan(300)
    expect(center.y).toBeGreaterThan(200)
    expect(liveLoupeCrop(1024, 680, 0, 0)).toMatchObject({ x: 0, y: 0 })
    expect(liveLoupeCrop(220, 150, 0.5, 0.5))
      .toEqual({ x: 0, y: 0, w: 220, h: 150 })
    const portrait = liveLoupeCrop(1080, 2048, 0.5, 0.5)
    expect(portrait.w).toBeLessThanOrEqual(320)
    expect(portrait.h).toBeLessThanOrEqual(200)
  })

  it('斑马纹只压在高光上，并保留明暗相间的条纹', () => {
    const data = image(8, 2, [128, 128, 128])
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 8; x++) {
        if (x >= 4) {
          const i = (y * 8 + x) * 4
          data[i] = 250
          data[i + 1] = 250
          data[i + 2] = 250
        }
      }
    }
    expect(paintZebra(data, 8, 2, 240)).toBe(4)
    const brightPixels = [4, 5, 6, 7].map(x => data[x * 4]!)
    expect(new Set(brightPixels).size).toBe(2)
    expect(data[0]).toBe(128)
  })

  it('伪色把暗部、中间调和高光映射到不同曝光区间', () => {
    const data = image(7, 1, [0, 0, 0])
    const levels = [0, 40, 90, 145, 200, 236, 252]
    for (let x = 0; x < levels.length; x++) {
      const i = x * 4
      data[i] = levels[x]!
      data[i + 1] = levels[x]!
      data[i + 2] = levels[x]!
    }
    expect(paintFalseColor(data, 7, 1)).toBe(7)
    const colors = levels.map((_, x) => [
      data[x * 4]!, data[x * 4 + 1]!, data[x * 4 + 2]!,
    ])
    expect(new Set(colors.map(color => color.join(','))).size).toBe(7)
    expect(colors[0]![2]).toBeGreaterThan(colors[0]![0]!)
    expect(colors[6]![0]).toBeGreaterThan(colors[6]![1]!)
  })
})
