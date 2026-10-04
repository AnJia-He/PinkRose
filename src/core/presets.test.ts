import { describe, it, expect } from 'vitest'
import { PRESETS } from './presets'
import { PARAM_KEYS, PARAM_RANGE } from '../../shared/adjustments.ts'

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

  it('每个预设的每个字段都是数，且都落在**它自己那条**的范围里（条数不写死 —— 表里有几根就查几根）', () => {
    for (const p of PRESETS) {
      for (const k of PARAM_KEYS) {
        expect(typeof p.adjustments[k], `${p.id}.${k} 不是数`).toBe('number')
        // ★ 2026-10-04 终审勘误：原来两条硬编码的 ±100 —— 色相（0~360）和
        // 强度（0~100）本来就不在 [-100, 100] 里，这条断言对那三根是**错的**
        // （当下全 0 所以绿着）。改成按 `PARAM_RANGE` 各自核：范围表改了它跟着走。
        const [lo, hi] = PARAM_RANGE[k]
        expect(p.adjustments[k], `${p.id}.${k} 低于下界`).toBeGreaterThanOrEqual(lo)
        expect(p.adjustments[k], `${p.id}.${k} 高于上界`).toBeLessThanOrEqual(hi)
      }
    }
  })

  it('预设之间不是完全相同的', () => {
    const seen = new Set(PRESETS.map(p => JSON.stringify(p.adjustments)))
    expect(seen.size).toBe(PRESETS.length)
  })
})
