import { describe, expect, it } from 'vitest'
import {
  orientTemplate, PRINT_TEMPLATES, printCells, printFilename, templateById,
} from './printSheet.ts'

describe('打印排版', () => {
  it('四套模板的格子数与纸张尺寸对得上', () => {
    expect(PRINT_TEMPLATES.map(t => t.id)).toEqual([
      '6x4-8', '6x4-4', '6x4-1', '5x7-2', 'a4-9', 'a4-6', 'a5-4', 'custom',
    ])
    for (const template of PRINT_TEMPLATES) {
      const cells = printCells(template)
      expect(cells).toHaveLength(template.cols * template.rows)
      for (const cell of cells) {
        expect(cell.x).toBeGreaterThanOrEqual(0)
        expect(cell.y).toBeGreaterThanOrEqual(0)
        expect(cell.x + cell.w).toBeLessThanOrEqual(template.width)
        expect(cell.y + cell.h).toBeLessThanOrEqual(template.height)
      }
    }
    expect(templateById('a4-9')).toMatchObject({ width: 2480, height: 3508 })
  })

  it('格子互不重叠，行列顺序稳定', () => {
    const cells = printCells(templateById('6x4-8'))
    expect(cells[0]!.x).toBeLessThan(cells[1]!.x)
    expect(cells[0]!.x).toBe(cells[4]!.x)
    expect(cells[0]!.y).toBeLessThan(cells[4]!.y)
    expect(cells[0]!.x + cells[0]!.w).toBeLessThan(cells[1]!.x)
  })

  it('自定义页边距 / 间距：边距变大、格子变小，默认值仍是旧版观感', () => {
    const template = templateById('6x4-8')
    const normal = printCells(template)
    const wideMargin = printCells(template, { marginPct: 8, gapPct: 4 })
    expect(normal[0]!.x).toBeGreaterThan(0)
    expect(wideMargin[0]!.x).toBeGreaterThan(normal[0]!.x)
    expect(wideMargin[0]!.w).toBeLessThan(normal[0]!.w)
    expect(wideMargin[0]!.h).toBeLessThan(normal[0]!.h)
  })

  it('横竖版切换会同时交换纸张宽高和行列', () => {
    const wide = templateById('6x4-8')
    expect(orientTemplate(wide, 'portrait')).toMatchObject({
      width: 1200, height: 1800, cols: 2, rows: 4,
    })
    const a4 = templateById('a4-9')
    expect(orientTemplate(a4, 'landscape')).toMatchObject({
      width: 3508, height: 2480, cols: 3, rows: 3,
    })
    expect(orientTemplate(a4, 'auto')).toBe(a4)
  })

  it('文件名带模板和分钟级时间', () => {
    expect(printFilename(templateById('a4-6'), new Date(2026, 9, 17, 8, 5)))
      .toBe('PinkRose-print-a4-6-20261017-0805.jpg')
  })
})
