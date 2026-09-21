import { describe, it, expect } from 'vitest'
import { align32, fitWithin, MAX_DIMENSION } from './decode'

describe('fitWithin', () => {
  it('长边超过上限时等比缩小', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 })
  })

  it('已经在范围内就不放大', () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 })
  })

  it('竖图按高度缩', () => {
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 })
  })

  it('正方形', () => {
    expect(fitWithin(4096, 4096, 2048)).toEqual({ width: 2048, height: 2048 })
  })
})

describe('align32', () => {
  it('已经是 32 的倍数就不动', () => {
    expect(align32(1024)).toBe(1024)
  })

  it('不是 32 的倍数就取最近的', () => {
    expect(align32(1200)).toBe(1216)   // 1200/32=37.5 -> 38*32
    expect(align32(1000)).toBe(992)    // 1000/32=31.25 -> 31*32
  })

  it('低于 512 时抬到 512', () => {
    expect(align32(300)).toBe(512)
  })

  it('高于 4096 时压到 4096', () => {
    expect(align32(9000)).toBe(4096)
  })

  it('结果一定是 32 的倍数', () => {
    for (const n of [1, 300, 511, 513, 1000, 1200, 2047, 4095, 9999]) {
      expect(align32(n) % 32).toBe(0)
    }
  })
})

describe('MAX_DIMENSION', () => {
  it('是 2048（spec §4.4）', () => {
    expect(MAX_DIMENSION).toBe(2048)
  })
})
