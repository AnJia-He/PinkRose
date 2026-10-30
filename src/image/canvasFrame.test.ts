import { describe, expect, it } from 'vitest'
import { canvasFrameLayout, normalizeCanvasFrameOptions } from './canvasFrame'

describe('canvasFrameLayout', () => {
  it('原比例、零边距：画布和照片一样大，照片铺满', () => {
    const layout = canvasFrameLayout(1200, 800, { aspect: 'original', paddingPct: 0 })
    expect(layout).toMatchObject({
      width: 1200, height: 800,
      photo: { x: 0, y: 0, w: 1200, h: 800 },
    })
  })

  it('横图改 1:1：保留原照片分辨率，上下补画布', () => {
    const layout = canvasFrameLayout(1200, 800, { aspect: '1:1', paddingPct: 0 })
    expect(layout).toMatchObject({
      width: 1200, height: 1200,
      photo: { x: 0, y: 200, w: 1200, h: 800 },
    })
  })

  it('横图改 9:16：左右不缩，上下补成竖幅', () => {
    const layout = canvasFrameLayout(1200, 800, { aspect: '9:16', paddingPct: 0 })
    expect(layout.width).toBe(1200)
    expect(layout.height).toBe(2133)
    expect(layout.photo).toMatchObject({ x: 0, w: 1200, h: 800 })
    expect(layout.photo.y).toBe(667)
  })

  it('边距 10%：照片尺寸不变，四周留出等宽画布', () => {
    const layout = canvasFrameLayout(1200, 800, { aspect: '1:1', paddingPct: 10 })
    expect(layout).toMatchObject({
      width: 1500, height: 1500,
      photo: { x: 150, y: 350, w: 1200, h: 800 },
    })
  })

  it('长边超过上限时整张画布等比缩小', () => {
    const layout = canvasFrameLayout(1200, 800, { aspect: '16:9', paddingPct: 0 }, 1000)
    expect(layout.width).toBe(1000)
    expect(layout.height).toBe(563)
    expect(layout.photo.w).toBe(845)
    expect(layout.photo.h).toBe(563)
  })
})

describe('normalizeCanvasFrameOptions', () => {
  it('夹取边距和颜色，未知比例 / 背景回默认值', () => {
    expect(normalizeCanvasFrameOptions({
      aspect: 'nope' as never,
      background: 'nope' as never,
      color: 'red',
      paddingPct: 99,
    })).toEqual({
      aspect: '1:1', background: 'color', color: '#ffffff', paddingPct: 20,
    })
  })
})
