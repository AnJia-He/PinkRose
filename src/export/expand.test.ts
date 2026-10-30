import { describe, expect, it } from 'vitest'
import { expandedSize } from './expand.ts'

describe('expandedSize', () => {
  it('横图扩 1:1：补高，不裁原图', () => {
    expect(expandedSize(1200, 800, '1:1')).toEqual({ width: 1200, height: 1200 })
  })

  it('竖图扩 16:9：补宽，不裁原图', () => {
    expect(expandedSize(800, 1200, '16:9')).toEqual({ width: 2133, height: 1200 })
  })

  it('比例符合目标', () => {
    const size = expandedSize(1000, 1000, '9:16')
    expect(size.width / size.height).toBeCloseTo(9 / 16, 2)
    expect(size.width).toBe(1000)
  })
})
