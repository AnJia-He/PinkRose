import { describe, it, expect } from 'vitest'
import { markerGeometry, MARKER_RADIUS_RATIO } from './mark'

describe('markerGeometry', () => {
  it('归一化的点换算成像素，圆心落在点上', () => {
    expect(markerGeometry({ x: 0.5, y: 0.5 }, 1000, 800))
      .toMatchObject({ cx: 500, cy: 400 })
  })

  it('四个角和正中间都对', () => {
    // 写成 `x * h` 之类的实现会在这组里露出来
    expect(markerGeometry({ x: 0, y: 0 }, 1000, 800)).toMatchObject({ cx: 0, cy: 0 })
    expect(markerGeometry({ x: 1, y: 1 }, 1000, 800)).toMatchObject({ cx: 1000, cy: 800 })
    expect(markerGeometry({ x: 0.25, y: 0.75 }, 1200, 800)).toMatchObject({ cx: 300, cy: 600 })
  })

  it('半径按**长边**算 —— 横竖图的圈看起来要一样大', () => {
    // 按短边算的话，1000x200 的横图上圈会小得看不见。
    // 这条按长边：1000 * 0.06 = 60
    expect(markerGeometry({ x: .5, y: .5 }, 1000, 200).r)
      .toBe(Math.round(1000 * MARKER_RADIUS_RATIO))
    expect(markerGeometry({ x: .5, y: .5 }, 200, 1000).r)
      .toBe(Math.round(1000 * MARKER_RADIUS_RATIO))
  })

  it('半径至少 8 像素 —— 小图上也得看得见', () => {
    expect(markerGeometry({ x: .5, y: .5 }, 64, 64).r).toBeGreaterThanOrEqual(8)
  })

  it('归一化越界的点会被夹回来（点歪到画布外面时不该画出个空标记）', () => {
    expect(markerGeometry({ x: 1.4, y: -0.3 }, 100, 100)).toMatchObject({ cx: 100, cy: 0 })
  })
})
