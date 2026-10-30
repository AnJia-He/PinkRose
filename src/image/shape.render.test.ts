import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const canvasMock = vi.hoisted(() => ({
  makeCanvas: vi.fn(),
  createImageBitmap: vi.fn(),
  ctx: {} as Record<string, unknown>,
}))

vi.mock('../core/canvas', () => ({
  makeCanvas: canvasMock.makeCanvas,
}))

import { shapeToBitmap } from './shape'

describe('形状落像素', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const ctx = {
      drawImage: vi.fn(),
      save: vi.fn(), restore: vi.fn(),
      fill: vi.fn(), stroke: vi.fn(),
      globalAlpha: 1, globalCompositeOperation: 'source-over',
      fillStyle: '#000', strokeStyle: '#000',
      lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    }
    canvasMock.ctx = ctx
    canvasMock.makeCanvas.mockReturnValue({
      canvas: { width: 1000, height: 800 },
      ctx,
    })
    canvasMock.createImageBitmap.mockResolvedValue({ width: 1000, height: 800 })
    vi.stubGlobal('createImageBitmap', canvasMock.createImageBitmap)
    vi.stubGlobal('Path2D', class {
      constructor(readonly d: string) {}
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('不透明度和混合模式落到 Canvas；填充与描边共用同一份几何', async () => {
    await shapeToBitmap({ width: 1000, height: 800 } as ImageBitmap, {
      kind: 'rect', x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.8,
      color: '#ff3b30', fill: true, fillColor: '#ffffff', fillOpacity: 40,
      opacity: 50, blend: 'multiply',
    })
    expect(canvasMock.ctx.globalAlpha).toBeCloseTo(0.5)
    expect(canvasMock.ctx.globalCompositeOperation).toBe('multiply')
    expect(canvasMock.ctx.fill).toHaveBeenCalledTimes(1)
    expect(canvasMock.ctx.stroke).toHaveBeenCalledTimes(1)
  })
})
