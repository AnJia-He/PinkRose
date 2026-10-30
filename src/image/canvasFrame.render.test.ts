import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const canvasMock = vi.hoisted(() => ({
  makeCanvas: vi.fn(),
  createImageBitmap: vi.fn(),
  ctx: null as unknown as Record<string, ReturnType<typeof vi.fn> | string | boolean | number>,
}))

vi.mock('../core/canvas', () => ({
  makeCanvas: canvasMock.makeCanvas,
}))

import {
  canvasFrameLayout, canvasFrameToBitmap, paintCanvasFrame,
} from './canvasFrame'

describe('paintCanvasFrame', () => {
  beforeEach(() => {
    const ctx: Record<string, ReturnType<typeof vi.fn> | string | boolean | number> = {
      fillRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(),
      fillStyle: '', filter: '', imageSmoothingEnabled: false, imageSmoothingQuality: 'high',
    }
    canvasMock.ctx = ctx
    canvasMock.makeCanvas.mockReset()
    canvasMock.makeCanvas.mockReturnValue({
      canvas: { width: 1500, height: 1500 },
      ctx,
    })
    canvasMock.createImageBitmap.mockReset()
    canvasMock.createImageBitmap.mockResolvedValue({ width: 1500, height: 1500 })
    vi.stubGlobal('createImageBitmap', canvasMock.createImageBitmap)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('纯色背景铺满画布，照片按布局居中绘制', () => {
    const layout = canvasFrameLayout(1200, 800, { aspect: '1:1', paddingPct: 10 })
    paintCanvasFrame(
      canvasMock.ctx as unknown as CanvasRenderingContext2D,
      {} as CanvasImageSource, 1200, 800, layout,
      { aspect: '1:1', paddingPct: 10, background: 'color', color: '#112233' },
    )
    expect(canvasMock.ctx.fillRect).toHaveBeenCalledWith(0, 0, 1500, 1500)
    expect(canvasMock.ctx.fillStyle).toBe('#112233')
    expect(canvasMock.ctx.drawImage).toHaveBeenCalledWith(
      expect.anything(), 150, 350, 1200, 800,
    )
  })

  it('模糊背景先画 cover 再画清晰照片；透明背景不铺底', () => {
    const layout = canvasFrameLayout(1200, 800, { aspect: '1:1' })
    paintCanvasFrame(
      canvasMock.ctx as unknown as CanvasRenderingContext2D,
      {} as CanvasImageSource, 1200, 800, layout,
      { aspect: '1:1', background: 'blur', color: '#ffffff' },
    )
    expect(canvasMock.ctx.fillRect).toHaveBeenCalledTimes(1)
    expect(canvasMock.ctx.save).toHaveBeenCalledTimes(1)
    expect(String(canvasMock.ctx.filter)).toContain('blur(')
    expect(canvasMock.ctx.drawImage).toHaveBeenCalledTimes(2)
    expect(canvasMock.ctx.restore).toHaveBeenCalledTimes(1)

    ;(canvasMock.ctx.fillRect as ReturnType<typeof vi.fn>).mockClear()
    ;(canvasMock.ctx.drawImage as ReturnType<typeof vi.fn>).mockClear()
    paintCanvasFrame(
      canvasMock.ctx as unknown as CanvasRenderingContext2D,
      {} as CanvasImageSource, 1200, 800, layout,
      { aspect: '1:1', background: 'transparent' },
    )
    expect(canvasMock.ctx.fillRect).not.toHaveBeenCalled()
    expect(canvasMock.ctx.drawImage).toHaveBeenCalledTimes(1)
  })

  it('落图使用布局尺寸并返回新位图', async () => {
    const out = await canvasFrameToBitmap(
      { width: 1200, height: 800 } as ImageBitmap,
      { aspect: '1:1', paddingPct: 10 },
    )
    expect(canvasMock.makeCanvas).toHaveBeenCalledWith(1500, 1500, '做不了这张画布')
    expect(out.bitmap).toBe(await canvasMock.createImageBitmap.mock.results[0]!.value)
  })
})
