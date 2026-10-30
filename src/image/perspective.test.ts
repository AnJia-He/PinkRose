import { describe, expect, it } from 'vitest'
import { defaultPerspectiveQuad, type PerspectiveQuad } from '../core/perspective.ts'
import { warpPerspectivePixels } from './perspective.ts'

function pixels(w: number, h: number) {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      d[i] = 10 + x * 40; d[i + 1] = 20 + y * 40; d[i + 2] = 90; d[i + 3] = 200 + x
    }
  }
  return d
}

describe('warpPerspectivePixels', () => {
  it('恒等四角 = 逐字节不变', () => {
    const src = pixels(8, 6)
    const out = warpPerspectivePixels(src, 8, 6, defaultPerspectiveQuad())
    expect(out.width).toBe(8)
    expect(out.height).toBe(6)
    expect(Buffer.from(out.data)).toEqual(Buffer.from(src))
  })

  it('★ 凹进一个角后输出外接框缩小，alpha 仍保留', () => {
    const quad: PerspectiveQuad = [
      { x: 0.2, y: 0.2 }, { x: 0.9, y: 0.1 }, { x: 0.8, y: 0.9 }, { x: 0.1, y: 0.8 },
    ]
    const src = pixels(20, 20)
    const out = warpPerspectivePixels(src, 20, 20, quad)
    expect(out.width).toBe(16)
    expect(out.height).toBe(16)
    expect(out.data[3]).toBeGreaterThanOrEqual(200)
    expect(out.data.length).toBe(16 * 16 * 4)
  })
})
