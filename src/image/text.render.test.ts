import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const canvasMock = vi.hoisted(() => ({
  makeCanvas: vi.fn(),
  createImageBitmap: vi.fn(),
  ctx: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
}))

vi.mock('../core/canvas', () => ({
  makeCanvas: canvasMock.makeCanvas,
}))

import { drawTextLayers, textLayersToBitmap, textToBitmap } from './text'

describe('textToBitmap 旋转落图', () => {
  beforeEach(() => {
    const ctx = {
      drawImage: vi.fn(), measureText: vi.fn(() => ({ width: 200 })),
      fillText: vi.fn(), strokeText: vi.fn(),
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(),
      save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    }
    canvasMock.ctx = ctx
    canvasMock.makeCanvas.mockReset()
    canvasMock.makeCanvas.mockReturnValue({
      canvas: { width: 1000, height: 800 },
      ctx,
    })
    canvasMock.createImageBitmap.mockReset()
    canvasMock.createImageBitmap.mockResolvedValue({ width: 1000, height: 800 })
    vi.stubGlobal('createImageBitmap', canvasMock.createImageBitmap)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('非零角度绕文字中心旋转，0 度不加旋转', async () => {
    const source = { width: 1000, height: 800 } as ImageBitmap
    await textToBitmap(source, {
      text: 'TEST', x: 0.5, y: 0.5, fontPx: 100, rotation: 30,
    })
    expect(canvasMock.ctx.translate).toHaveBeenNthCalledWith(1, 500, 400)
    expect(canvasMock.ctx.translate).toHaveBeenNthCalledWith(2, -500, -400)
    expect(canvasMock.ctx.rotate).toHaveBeenCalledWith(Math.PI / 6)
    expect(canvasMock.ctx.restore).toHaveBeenCalledTimes(1)

    canvasMock.ctx.rotate.mockClear()
    canvasMock.ctx.save.mockClear()
    canvasMock.ctx.restore.mockClear()
    await textToBitmap(source, {
      text: 'TEST', x: 0.5, y: 0.5, fontPx: 100, rotation: 0,
    })
    expect(canvasMock.ctx.rotate).not.toHaveBeenCalled()
    expect(canvasMock.ctx.save).toHaveBeenCalledTimes(1)
    expect(canvasMock.ctx.restore).toHaveBeenCalledTimes(1)
  })

  it('多文字层按传入顺序画，导出偏移整体平移', () => {
    const ctx = canvasMock.ctx
    drawTextLayers(ctx as unknown as CanvasRenderingContext2D, [
      { kind: 'text', id: 'a', options: { text: '第一层', x: 0.5, y: 0.5, fontPx: 80 } },
      { kind: 'text', id: 'b', options: { text: '第二层', x: 0.2, y: 0.2, fontPx: 60 } },
    ] as never, 1000, 800, 12, 24)

    expect(ctx.translate).toHaveBeenCalledWith(12, 24)
    expect(ctx.fillText).toHaveBeenCalledTimes(2)   // 每层一行（字距 0）
    expect(ctx.save).toHaveBeenCalledTimes(3)        // 外层平移一次 + 每层各一次
    expect(ctx.restore).toHaveBeenCalledTimes(3)
  })

  it('几何工具入口把文字层合并成一张临时位图；没有层时返回原对象', async () => {
    const source = { width: 1000, height: 800, close: vi.fn() } as unknown as ImageBitmap
    const flattened = await textLayersToBitmap(source, [{
      kind: 'text', id: 'a', options: { text: '合并', x: 0.5, y: 0.5, fontPx: 80 },
    }] as never)
    expect(flattened).not.toBe(source)
    expect(canvasMock.ctx.drawImage).toHaveBeenCalledWith(source, 0, 0)
    expect(canvasMock.ctx.fillText).toHaveBeenCalled()
    expect(canvasMock.createImageBitmap).toHaveBeenCalledTimes(1)

    canvasMock.createImageBitmap.mockClear()
    expect(await textLayersToBitmap(source, [])).toBe(source)
    expect(canvasMock.createImageBitmap).not.toHaveBeenCalled()
  })
})
