import { beforeEach, describe, expect, it, vi } from 'vitest'

const canvasMock = vi.hoisted(() => ({
  makeCanvas: vi.fn(),
  createImageBitmap: vi.fn(),
  ctx: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
}))

vi.mock('../core/canvas', () => ({ makeCanvas: canvasMock.makeCanvas }))

import { textToBitmap } from './text'

describe('textToBitmap 字距', () => {
  beforeEach(() => {
    const ctx = {
      drawImage: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
      fillText: vi.fn(), strokeText: vi.fn(),
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(),
      save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    }
    canvasMock.ctx = ctx
    canvasMock.makeCanvas.mockReset()
    canvasMock.makeCanvas.mockReturnValue({
      canvas: { width: 1000, height: 800 }, ctx,
    })
    canvasMock.createImageBitmap.mockReset()
    canvasMock.createImageBitmap.mockResolvedValue({ width: 1000, height: 800 })
    vi.stubGlobal('createImageBitmap', canvasMock.createImageBitmap)
  })

  it('字距 20 时逐字绘制，字与字之间多出 20px', async () => {
    await textToBitmap(
      { width: 1000, height: 800 } as ImageBitmap,
      { text: 'AB', x: 0.5, y: 0.5, fontPx: 100, letterSpacing: 20 },
    )
    const calls = canvasMock.ctx.fillText.mock.calls
    expect(calls.map(call => call[0])).toEqual(['A', 'B'])
    expect(calls[0]![1]).toBeCloseTo(480, 6)
    expect(calls[1]![1]).toBeCloseTo(510, 6)
  })
})
