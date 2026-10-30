import { describe, expect, it } from 'vitest'
import {
  ID_PHOTO_SHEET_HEIGHT, ID_PHOTO_SHEET_WIDTH, layoutIdPhotoSheet,
} from './idPhotoSheet.ts'

describe('layoutIdPhotoSheet', () => {
  it('一寸照排 4×2 八张，全部在 6 寸相纸内', () => {
    const cells = layoutIdPhotoSheet(295, 413)
    expect(cells).toHaveLength(8)
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0)
      expect(c.y).toBeGreaterThanOrEqual(0)
      expect(c.x + c.w).toBeLessThanOrEqual(ID_PHOTO_SHEET_WIDTH)
      expect(c.y + c.h).toBeLessThanOrEqual(ID_PHOTO_SHEET_HEIGHT)
    }
  })

  it('照片互不重叠，按四列两行排', () => {
    const cells = layoutIdPhotoSheet(413, 579)
    expect(new Set(cells.map(c => c.y)).size).toBe(2)
    expect(new Set(cells.map(c => c.x)).size).toBe(4)
    for (let i = 1; i < 4; i++) {
      expect(cells[i]!.x).toBeGreaterThan(cells[i - 1]!.x + cells[i - 1]!.w)
    }
  })

  it('照片过大时等比缩进相纸', () => {
    const cells = layoutIdPhotoSheet(1200, 1800)
    expect(cells[0]!.w).toBeLessThan(1200)
    expect(cells[0]!.h).toBeLessThan(1800)
  })
})
