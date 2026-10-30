import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const canvasMock = vi.hoisted(() => ({
  makeCanvas: vi.fn(),
  createImageBitmap: vi.fn(),
  drawImage: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  rotate: vi.fn(),
  scale: vi.fn(),
  beginPath: vi.fn(),
  rect: vi.fn(),
  clip: vi.fn(),
  context: {} as Record<string, unknown>,
}))

vi.mock('../core/canvas', () => ({
  makeCanvas: canvasMock.makeCanvas,
}))

import { stickerToBitmap } from './sticker'

describe('自定义图片贴纸', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const ctx = {
        drawImage: canvasMock.drawImage,
        save: canvasMock.save, restore: canvasMock.restore,
        translate: canvasMock.translate, rotate: canvasMock.rotate,
        scale: canvasMock.scale,
        beginPath: canvasMock.beginPath, rect: canvasMock.rect, clip: canvasMock.clip,
        globalAlpha: 1, globalCompositeOperation: 'source-over',
        shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
    }
    canvasMock.context = ctx
    canvasMock.makeCanvas.mockReturnValue({
      canvas: { width: 1000, height: 800 },
      ctx,
    })
    canvasMock.createImageBitmap.mockReset()
    canvasMock.createImageBitmap.mockResolvedValue({ width: 1000, height: 800 })
    vi.stubGlobal('createImageBitmap', canvasMock.createImageBitmap)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('按最长边缩进短边百分比方框，保持图片比例并居中', async () => {
    const photo = { width: 1000, height: 800 } as ImageBitmap
    const custom = { width: 200, height: 100 } as ImageBitmap
    await stickerToBitmap(photo, {
      source: 'image', x: 0.5, y: 0.5, sizePct: 20, rotation: 0,
    }, custom)
    expect(canvasMock.drawImage).toHaveBeenNthCalledWith(1, photo, 0, 0)
    expect(canvasMock.translate).toHaveBeenCalledWith(500, 400)
    expect(canvasMock.drawImage).toHaveBeenNthCalledWith(2, custom, -80, -40, 160, 80)
  })

  it('选了图片来源却没有图片时不静默画一个星形', async () => {
    await expect(stickerToBitmap(
      { width: 1000, height: 800 } as ImageBitmap,
      { source: 'image', sizePct: 20 },
      null,
    )).rejects.toThrow(/先选一张图片/)
  })

  it('填满 + 不透明度 + 混合模式 + 翻转：裁切到方框并按合成模式画', async () => {
    const photo = { width: 1000, height: 800 } as ImageBitmap
    const custom = { width: 200, height: 100 } as ImageBitmap
    await stickerToBitmap(photo, {
      source: 'image', x: 0.5, y: 0.5, sizePct: 20,
      fit: 'cover', opacity: 50, blend: 'multiply', flipH: true,
    }, custom)
    expect(canvasMock.rect).toHaveBeenCalledWith(-80, -80, 160, 160)
    expect(canvasMock.clip).toHaveBeenCalledTimes(1)
    expect(canvasMock.scale).toHaveBeenCalledWith(-1, 1)
    expect(canvasMock.drawImage).toHaveBeenNthCalledWith(2, custom, -160, -80, 320, 160)
    expect(canvasMock.context.globalAlpha).toBeCloseTo(0.5)
    expect(canvasMock.context.globalCompositeOperation).toBe('multiply')
  })
})
