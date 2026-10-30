import { describe, expect, it } from 'vitest'
import { assessCull, cullMetrics } from './cull.ts'

const checker = (w: number, h: number) => {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = (x + y) % 2 ? 235 : 20
  }
  return out
}

const flat = (w: number, h: number, v = 128) => new Float32Array(w * h).fill(v)

describe('cull metrics', () => {
  it('sees sharp checkerboard as sharper than a flat patch', () => {
    const sharp = cullMetrics(checker(32, 32), 32, 32)
    const blurry = cullMetrics(flat(32, 32), 32, 32)
    expect(sharp.sharpness).toBeGreaterThan(blurry.sharpness)
    expect(sharp.exposure).toBeGreaterThan(0)
  })

  it('penalizes clipped / extreme exposure', () => {
    const mid = cullMetrics(flat(32, 32, 128), 32, 32)
    const black = cullMetrics(flat(32, 32, 0), 32, 32)
    expect(mid.exposure).toBeGreaterThan(black.exposure)
    expect(black.clipping).toBe(1)
  })
})

describe('assessCull', () => {
  it('keeps the sharp normal-exposure shot and flags the flat one for review', () => {
    const verdicts = assessCull([
      cullMetrics(checker(32, 32), 32, 32),
      cullMetrics(flat(32, 32), 32, 32),
    ])
    expect(verdicts[0]!.keep).toBe(true)
    expect(verdicts[1]!.keep).toBe(false)
    expect(verdicts[1]!.reason).toContain('模糊')
  })

  it('does not guess on an empty batch', () => {
    expect(assessCull([])).toEqual([])
  })
})
