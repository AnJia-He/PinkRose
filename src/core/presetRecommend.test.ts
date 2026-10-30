import { describe, expect, it } from 'vitest'
import type { Rgb } from './colorMatch'
import { recommendPreset } from './presetRecommend.ts'

const repeated = (rgb: Rgb, count = 80): Rgb[] =>
  Array.from({ length: count }, () => [rgb[0], rgb[1], rgb[2]])

describe('preset recommendation', () => {
  it('does not guess without samples', () => {
    expect(recommendPreset([])).toBeNull()
  })

  it('recognizes monochrome, night and portrait starts', () => {
    expect(recommendPreset(repeated([128, 128, 128]))?.id).toBe('bw')
    expect(recommendPreset(repeated([8, 10, 18]))?.id).toBe('night')
    expect(recommendPreset(repeated([205, 155, 135]))?.id).toBe('portrait')
  })

  it('uses low contrast / bright blue for a clean start', () => {
    const samples = [
      ...repeated([170, 190, 210], 40),
      ...repeated([180, 200, 220], 40),
    ]
    expect(recommendPreset(samples)?.id).toBe('jp-clean')
  })

  it('separates vivid color, moody contrast and blue-green landscape', () => {
    expect(recommendPreset(repeated([120, 30, 180]))?.id).toBe('vivid')

    const moody = [
      ...repeated([5, 5, 5], 40),
      ...repeated([200, 210, 220], 40),
    ]
    expect(recommendPreset(moody)?.id).toBe('moody')

    const landscape = [
      ...repeated([60, 140, 200], 40),
      ...repeated([100, 180, 100], 40),
    ]
    expect(recommendPreset(landscape)?.id).toBe('landscape')
  })
})
