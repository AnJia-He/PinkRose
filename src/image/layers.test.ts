import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  makeCanvas: vi.fn(),
  text: vi.fn(),
  shape: vi.fn(),
}))

vi.mock('../core/canvas', () => ({ makeCanvas: calls.makeCanvas }))
vi.mock('./text', () => ({ drawTextOptions: calls.text }))
vi.mock('./shape', () => ({ drawShapeOptions: calls.shape }))

import { compositeEditLayers, drawEditLayers, editLayersToBitmap } from './layers'
import { DEFAULT_TEXT } from '../../shared/text.ts'
import { DEFAULT_SHAPE } from '../../shared/shape.ts'

describe('通用编辑层合成', () => {
  it('按 kind 分别交给文字 / 形状绘制，并在导出偏移外统一平移', () => {
    const ctx = { save: vi.fn(), restore: vi.fn(), translate: vi.fn() }
    drawEditLayers(ctx as never, [
      { kind: 'text', id: 't', options: DEFAULT_TEXT },
      { kind: 'shape', id: 's', options: DEFAULT_SHAPE },
    ], 1000, 800, 12, 24)
    expect(ctx.translate).toHaveBeenCalledWith(12, 24)
    expect(calls.text).toHaveBeenCalledWith(ctx, DEFAULT_TEXT, 1000, 800)
    expect(calls.shape).toHaveBeenCalledWith(ctx, DEFAULT_SHAPE, 1000, 800)
    expect(ctx.save).toHaveBeenCalledTimes(1)
    expect(ctx.restore).toHaveBeenCalledTimes(1)
  })

  it('没有层时原样返回；有层时复制一张画布再叠', async () => {
    const source = { width: 10, height: 8 } as CanvasImageSource & { width: number; height: number }
    expect(compositeEditLayers(source, [])).toBe(source)
    expect(await editLayersToBitmap(source as ImageBitmap, [])).toBe(source)

    const ctx = {
      drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(),
    }
    const canvas = { width: 10, height: 8 }
    calls.makeCanvas.mockReturnValue({ canvas, ctx })
    calls.makeCanvas.mockClear()
    expect(compositeEditLayers(source, [
      { kind: 'shape', id: 's', options: DEFAULT_SHAPE },
    ])).toBe(canvas)
    expect(ctx.drawImage).toHaveBeenCalledWith(source, 0, 0)
  })

  it('★ 隐藏的层不画；局部层也不进叠图', () => {
    calls.text.mockClear()
    calls.shape.mockClear()
    const ctx = { save: vi.fn(), restore: vi.fn(), translate: vi.fn() }
    drawEditLayers(ctx as never, [
      { kind: 'text', id: 'hidden', options: DEFAULT_TEXT, visible: false },
      { kind: 'shape', id: 'shown', options: DEFAULT_SHAPE },
      {
        kind: 'local', id: 'local',
        mask: 'data:image/png;base64,AA', maskWidth: 100, maskHeight: 100, feather: 0,
        options: { effect: 'tone', exposure: 20 },
      },
    ], 1000, 800)
    expect(calls.text).not.toHaveBeenCalled()
    expect(calls.shape).toHaveBeenCalledTimes(1)
  })
})
