import { describe, expect, it } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import {
  WHITE_BALANCE_PRESETS, applyWhiteBalancePreset, activeWhiteBalancePreset,
} from './whiteBalancePresets.ts'

describe('白平衡预设', () => {
  it('包含日光 / 阴天 / 阴影 / 钨丝灯 / 荧光灯', () => {
    expect(WHITE_BALANCE_PRESETS.map(p => p.label))
      .toEqual(['日光', '阴天', '阴影', '钨丝灯', '荧光灯'])
  })

  it('只写色温和色调，保留曝光与其他参数', () => {
    const before = { ...ZERO, exposure: 17, tint: 9, saturation: 22 }
    const next = applyWhiteBalancePreset(before, 'shade')
    expect(next.exposure).toBe(17)
    expect(next.saturation).toBe(22)
    expect(next.temperature).toBeGreaterThan(0)
    expect(next.tint).toBeGreaterThan(0)
    expect(activeWhiteBalancePreset(next)).toBe('shade')
  })

  it('手动改过白平衡后不再点亮任何预设', () => {
    const preset = WHITE_BALANCE_PRESETS.find(p => p.id === 'cloudy')!
    expect(activeWhiteBalancePreset({
      ...ZERO, temperature: preset.temperature + 1, tint: preset.tint,
    })).toBeNull()
  })
})
