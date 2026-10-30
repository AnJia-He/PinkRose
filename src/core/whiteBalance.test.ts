import { describe, expect, it } from 'vitest'
import {
  applyWhiteBalanceChannels, whiteBalanceFromSample,
} from './whiteBalance.ts'

describe('whiteBalanceFromSample', () => {
  it('中性灰 → 一组全零参数', () => {
    expect(whiteBalanceFromSample([128, 128, 128])).toEqual({
      temperature: 0, tint: 0,
    })
  })

  it('★ 暖偏色 → 负色温；换算后红绿蓝三条通道拉回同一档', () => {
    const wb = whiteBalanceFromSample([200, 190, 170])!
    expect(wb.temperature).toBeLessThan(0)
    const [r, g, b] = applyWhiteBalanceChannels([200, 190, 170], wb)
    expect(Math.abs(r - g)).toBeLessThan(0.006)
    expect(Math.abs(b - g)).toBeLessThan(0.006)
  })

  it('★ 绿偏色 → 正色调补洋红；不顺手改明暗', () => {
    const wb = whiteBalanceFromSample([145, 178, 145])!
    expect(wb.tint).toBeGreaterThan(0)
    const [r, g, b] = applyWhiteBalanceChannels([145, 178, 145], wb)
    expect(g).toBeLessThan(178 / 255)
    expect(Math.abs(r - g)).toBeLessThan(0.006)
    expect(Math.abs(b - g)).toBeLessThan(0.006)
  })

  it('太黑 / 太白 / 彩色太重 → 不给假结果', () => {
    expect(whiteBalanceFromSample([8, 8, 8])).toBeNull()
    expect(whiteBalanceFromSample([252, 252, 252])).toBeNull()
    expect(whiteBalanceFromSample([240, 70, 60])).toBeNull()
  })
})
