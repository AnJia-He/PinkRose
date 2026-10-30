import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const canvasMock = vi.hoisted(() => ({
  makeCanvas: vi.fn(),
}))

vi.mock('../core/canvas', () => ({
  makeCanvas: canvasMock.makeCanvas,
}))

import { detectSubjectBox } from './smartCrop'

function imageData(
  w: number,
  h: number,
  px: (x: number, y: number) => [number, number, number],
) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const [r, g, b] = px(x, y)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return { data, width: w, height: h }
}

beforeEach(() => {
  canvasMock.makeCanvas.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('detectSubjectBox', () => {
  it('在低分辨率工作图上找主体，返回原图归一化外接框', async () => {
    const source = { width: 1280, height: 800 } as ImageBitmap
    canvasMock.makeCanvas.mockImplementation((_w: number, _h: number) => {
      const workW = 640
      const workH = 400
      return {
        canvas: { width: workW, height: workH },
        ctx: {
          drawImage: vi.fn(),
          getImageData: vi.fn(() => imageData(workW, workH, (x, y) =>
            x >= 380 && x < 540 && y >= 90 && y < 340
              ? [215, 70, 45]
              : [35, 145, 205])),
        },
      }
    })

    const box = await detectSubjectBox(source)
    expect(canvasMock.makeCanvas).toHaveBeenCalledWith(
      640, 400, expect.any(String), expect.any(Object),
    )
    expect(box).not.toBeNull()
    expect(box!.x0).toBeGreaterThan(0.55)
    expect(box!.x1).toBeLessThanOrEqual(0.85)
    expect(box!.y0).toBeGreaterThan(0.15)
    expect(box!.y1).toBeLessThanOrEqual(0.9)
  })

  it('找不到可信主体时返回 null，不硬给一个画面中央的假主体', async () => {
    canvasMock.makeCanvas.mockImplementation(() => ({
      canvas: { width: 100, height: 80 },
      ctx: {
        drawImage: vi.fn(),
        getImageData: vi.fn(() => imageData(100, 80, () => [40, 150, 205])),
      },
    }))
    const box = await detectSubjectBox({ width: 100, height: 80 } as ImageBitmap)
    expect(box).toBeNull()
  })
})
