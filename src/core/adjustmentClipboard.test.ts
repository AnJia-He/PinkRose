import { describe, expect, it } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import {
  decodeAdjustmentClipboard, encodeAdjustmentClipboard, makeAdjustmentClipboard,
} from './adjustmentClipboard.ts'

describe('adjustmentClipboard', () => {
  it('参数会被钳制，滤镜引用会被归一化', () => {
    const clip = makeAdjustmentClipboard(
      { ...ZERO, exposure: 180, saturation: -130 },
      { lutId: 7, amount: 140 },
    )
    expect(clip.params.exposure).toBe(100)
    expect(clip.params.saturation).toBe(-100)
    expect(clip.lut).toEqual({ lutId: 7, amount: 100 })
  })

  it('编码后能解回同一套参数', () => {
    const clip = makeAdjustmentClipboard(
      { ...ZERO, exposure: 22, temperature: -14 }, null,
    )
    const back = decodeAdjustmentClipboard(encodeAdjustmentClipboard(clip))
    expect(back?.params.exposure).toBe(22)
    expect(back?.params.temperature).toBe(-14)
    expect(back?.lut).toBeNull()
  })

  it('坏 JSON / 错版本 / 缺参数都安全退回 null', () => {
    expect(decodeAdjustmentClipboard('')).toBeNull()
    expect(decodeAdjustmentClipboard('{bad')).toBeNull()
    expect(decodeAdjustmentClipboard('{"version":2,"params":{}}')).toBeNull()
    expect(decodeAdjustmentClipboard('{"version":1}')).toBeNull()
  })

  it('老数据缺的新参数按中立值补 0', () => {
    const back = decodeAdjustmentClipboard(
      '{"version":1,"params":{"exposure":30},"lut":null}',
    )
    expect(back?.params.exposure).toBe(30)
    expect(back?.params.skinRosy).toBe(0)
    expect(back?.params.vignette).toBe(0)
  })
})
