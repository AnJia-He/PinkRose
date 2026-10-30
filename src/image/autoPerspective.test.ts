import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  width: 480,
  height: 320,
  data: new Uint8ClampedArray(480 * 320 * 4),
  drawImage: vi.fn(),
}))

function fillArchitecture() {
  const { width, height, data } = state
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 28
    data[i * 4 + 1] = 34
    data[i * 4 + 2] = 42
    data[i * 4 + 3] = 255
  }
  const line = (x0: number, x1: number) => {
    for (let y = 0; y < height; y++) {
      const x = Math.round(x0 + (x1 - x0) * y / Math.max(1, height - 1))
      for (let dx = -1; dx <= 1; dx++) {
        const i = (y * width + Math.max(0, Math.min(width - 1, x + dx))) * 4
        data[i] = 238
        data[i + 1] = 241
        data[i + 2] = 246
      }
    }
  }
  line(width * 0.28, width * 0.16)
  line(width * 0.72, width * 0.84)
}

vi.mock('../core/canvas', () => ({
  makeCanvas: (width: number, height: number) => ({
    canvas: { width, height },
    ctx: {
      imageSmoothingQuality: 'low',
      drawImage: state.drawImage,
      getImageData: () => ({ data: state.data }),
    },
  }),
}))

import { detectAutoPerspective } from './autoPerspective.ts'

describe('自动透视像素入口', () => {
  beforeEach(() => {
    state.drawImage.mockClear()
    fillArchitecture()
  })

  it('从底图取样并返回四角，不依赖当前调色画布', () => {
    const source = { width: 1200, height: 800 } as ImageBitmap
    const quad = detectAutoPerspective(source)
    expect(quad).not.toBeNull()
    expect(state.drawImage).toHaveBeenCalledWith(source, 0, 0, 480, 320)
    expect(Math.abs(quad![0].x - 0.28)).toBeLessThan(0.04)
  })
})
