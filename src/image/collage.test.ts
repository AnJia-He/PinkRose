import { describe, expect, it } from 'vitest'
import {
  collageCanvasSize, collageCells, collageFilename, collageTemplate,
  COLLAGE_TEMPLATES, resolveCollageLayout,
} from './collage.ts'

describe('collage geometry', () => {
  it('builds the requested output ratios around the long edge', () => {
    expect(collageCanvasSize('1:1', 2048)).toEqual({ width: 2048, height: 2048 })
    expect(collageCanvasSize('4:5', 2048)).toEqual({ width: 1638, height: 2048 })
    expect(collageCanvasSize('3:4', 2048)).toEqual({ width: 1536, height: 2048 })
    expect(collageCanvasSize('16:9', 2048)).toEqual({ width: 2048, height: 1152 })
  })

  it('grid cells stay inside the margin and never overlap', () => {
    const width = 1000
    const height = 1200
    const gap = 20
    const cells = collageCells(7, 'grid', width, height, gap)
    expect(cells).toHaveLength(7)
    for (const cell of cells) {
      expect(cell.x).toBeGreaterThanOrEqual(gap - 1e-6)
      expect(cell.y).toBeGreaterThanOrEqual(gap - 1e-6)
      expect(cell.x + cell.width).toBeLessThanOrEqual(width - gap + 1e-6)
      expect(cell.y + cell.height).toBeLessThanOrEqual(height - gap + 1e-6)
    }
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i]!
        const b = cells[j]!
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
        expect(overlapX <= 1e-6 || overlapY <= 1e-6).toBe(true)
      }
    }
  })

  it('feature-left gives the first slot more area and feature-top fills the width', () => {
    const left = collageCells(5, 'feature-left', 1000, 1200, 16)
    expect(left).toHaveLength(5)
    expect(left[0]!.width).toBeGreaterThan(left[1]!.width)

    const top = collageCells(5, 'feature-top', 1200, 800, 16)
    expect(top).toHaveLength(5)
    expect(top[0]!.width).toBeGreaterThan(top[1]!.width)
  })

  it('auto chooses by photo count and canvas orientation', () => {
    expect(resolveCollageLayout(3, 'auto', 1000, 1200)).toBe('feature-left')
    expect(resolveCollageLayout(3, 'auto', 1200, 800)).toBe('feature-top')
    expect(resolveCollageLayout(4, 'auto', 1000, 1000)).toBe('grid')
  })

  it('names files from the actual export format', () => {
    const at = new Date('2026-10-17T18:05:00')
    expect(collageFilename('image/jpeg', at)).toBe('PinkRose-collage-20261017-1805.jpg')
    expect(collageFilename('image/webp', at)).toBe('PinkRose-collage-20261017-1805.webp')
  })

  it('五个模板各带一套版式，导出设置不被覆盖', () => {
    expect(COLLAGE_TEMPLATES.map(t => t.id)).toEqual([
      'grid', 'magazine', 'film', 'story', 'nine',
    ])
    expect(collageTemplate('magazine').patch).toEqual({
      ratio: '4:5', layout: 'feature-left', gap: 6, radius: 0, background: '#111111',
    })
    expect(COLLAGE_TEMPLATES.every(t => !('format' in t.patch))).toBe(true)
  })
})
