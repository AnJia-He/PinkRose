import { describe, expect, it, vi } from 'vitest'

const { drawCalls, state } = vi.hoisted(() => ({
  drawCalls: [] as unknown[][],
  state: { tile: 0 },
}))

vi.mock('../core/canvas', () => ({
  makeCanvas: (width: number, height: number) => {
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      clip: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn((...args: unknown[]) => { drawCalls.push(args) }),
      fillStyle: '',
    }
    const canvas = {
      width,
      height,
      toBlob: (cb: (blob: Blob | null) => void, type: string) => {
        cb(new Blob([new Uint8Array([state.tile++])], { type }))
      },
    }
    return {
      canvas: canvas as unknown as HTMLCanvasElement,
      ctx: ctx as unknown as CanvasRenderingContext2D,
    }
  },
}))

import {
  DEFAULT_GRID_SPLIT_OPTIONS, gridCellRect, gridTileFilename,
  gridTilePlan, gridZipFilename, splitGrid,
} from './gridSplit.ts'

describe('九宫格切图几何', () => {
  it('单格尺寸按原图计算，且不会放大超过单格长边', () => {
    expect(gridTilePlan(1200, 800, 3, 1080, 0)).toMatchObject({
      tileW: 400, tileH: 267, gapPx: 0, contentW: 400, contentH: 267,
    })
    expect(gridTilePlan(4000, 3000, 3, 1080, 0)).toMatchObject({
      tileW: 1080, tileH: 810,
    })
    expect(gridTilePlan(300, 300, 3, 1080, 0)).toMatchObject({
      tileW: 100, tileH: 100,
    })
  })

  it('间距不会吃掉整格，极端值会被夹住', () => {
    expect(gridTilePlan(300, 300, 3, 1080, 200).gapPx).toBe(98)
    expect(gridTilePlan(300, 300, 3, 1080, -5).gapPx).toBe(0)
  })

  it('9 个格子按行优先覆盖整张图，互不重叠', () => {
    const w = 1200, h = 800
    const cells = Array.from({ length: 9 }, (_, i) => gridCellRect(i, 3, w, h))
    expect(cells.map(c => [c.row, c.col])).toEqual([
      [0, 0], [0, 1], [0, 2],
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
    ])
    expect(cells.reduce((sum, c) => sum + c.sw * c.sh, 0)).toBeCloseTo(w * h, 6)
    expect(cells[8]).toMatchObject({ sx: 800, sy: 1600 / 3 })
  })

  it('文件名按格式和序号走，ZIP 名保持稳定', () => {
    expect(gridTileFilename('IMG_0001.HEIC', 'image/jpeg', 4)).toBe('IMG_0001_5.jpg')
    expect(gridTileFilename('a/b:c.png', 'image/png', 0)).toBe('a_b_c_1.png')
    expect(gridZipFilename('照片.jpg')).toBe('照片_grid.zip')
  })
})

describe('splitGrid', () => {
  it('输出 N×N 张、每张按对应格子取样，ZIP 里有同样多的条目', async () => {
    drawCalls.length = 0
    state.tile = 0
    const made = await splitGrid(
      {} as CanvasImageSource, 1200, 800,
      { ...DEFAULT_GRID_SPLIT_OPTIONS, size: 3, gap: 0 },
      'photo.jpg',
    )
    expect(made.tiles).toHaveLength(9)
    expect(drawCalls).toHaveLength(9)
    expect(made.zipFilename).toBe('photo_grid.zip')

    const seen = new Set<string>()
    for (const call of drawCalls) {
      // drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh)
      const [, sx, sy, sw, sh] = call as [unknown, number, number, number, number]
      expect(sx).toBeGreaterThanOrEqual(0)
      expect(sy).toBeGreaterThanOrEqual(0)
      expect(sx + sw).toBeLessThanOrEqual(1200 + 1e-6)
      expect(sy + sh).toBeLessThanOrEqual(800 + 1e-6)
      seen.add(`${Math.round(sx)},${Math.round(sy)}`)
    }
    expect(seen.size).toBe(9)

    const bytes = new Uint8Array(await made.zip.arrayBuffer())
    const view = new DataView(bytes.buffer)
    expect(view.getUint16(bytes.length - 22 + 10, true)).toBe(9)
  })

  it('间距模式仍然输出 N×N 张，背景和格子都写进画布', async () => {
    drawCalls.length = 0
    state.tile = 0
    const made = await splitGrid(
      {} as CanvasImageSource, 1200, 800,
      { ...DEFAULT_GRID_SPLIT_OPTIONS, size: 2, gap: 12, radius: 8 },
      'photo.jpg',
    )
    expect(made.tiles).toHaveLength(4)
    expect(drawCalls).toHaveLength(4)
    const [, , , , , dx, dy, dw, dh] = drawCalls[0] as number[]
    expect(dx).toBe(6)
    expect(dy).toBe(6)
    expect(dw).toBe(made.tiles[0]!.width - 12)
    expect(dh).toBe(made.tiles[0]!.height - 12)
  })
})
