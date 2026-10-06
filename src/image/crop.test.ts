// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { cropToBitmap } from './crop'

describe('cropToBitmap', () => {
  it('拿不到 2D 上下文时说人话，不静默返回空图', async () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(cropToBitmap({} as ImageBitmap, { rect: { x: 0, y: 0, w: 1, h: 1 }, angle: 0 }, 0))
      .rejects.toThrow(/裁剪/)
    spy.mockRestore()
  })
})
