import { describe, it, expect } from 'vitest'
import { PRESETS } from './presets'
import { PARAM_KEYS } from '../../shared/adjustments.ts'

describe('PRESETS', () => {
  it('至少 5 个预设', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(5)
  })

  it('id 唯一', () => {
    const ids = PRESETS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个预设都有中文标签', () => {
    for (const p of PRESETS) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.label).toMatch(/[一-龥]/)
    }
  })

  it('每个预设的每个字段都是数，且都在 [-100, 100] 内（条数不写死 —— 表里有几根就查几根）', () => {
    for (const p of PRESETS) {
      for (const k of PARAM_KEYS) {
        expect(typeof p.adjustments[k]).toBe('number')
        expect(p.adjustments[k]).toBeGreaterThanOrEqual(-100)
        expect(p.adjustments[k]).toBeLessThanOrEqual(100)
      }
    }
  })

  it('预设之间不是完全相同的', () => {
    const seen = new Set(PRESETS.map(p => JSON.stringify(p.adjustments)))
    expect(seen.size).toBe(PRESETS.length)
  })
})
