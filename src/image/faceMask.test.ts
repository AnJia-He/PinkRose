import { describe, expect, it } from 'vitest'
import { faceMask } from './faceMask'

const face = { x: 300, y: 120, w: 420, h: 520, confidence: 0.9 }

describe('faceMask', () => {
  it('脸中心是全覆盖，脸框外是 0', () => {
    const mask = faceMask(1200, 800, face)
    expect(mask[400 * 1200 + 510]).toBe(255)
    expect(mask[0]).toBe(0)
    expect(mask[700 * 1200 + 1100]).toBe(0)
  })

  it('边缘有软过渡，不是硬切', () => {
    const mask = faceMask(1200, 800, face)
    const centerX = 510
    const edgeX = centerX + Math.round(420 * 0.56 * 0.9)
    const midX = centerX + Math.round(420 * 0.56 * 0.8)
    expect(mask[400 * 1200 + edgeX]!).toBeLessThan(mask[400 * 1200 + midX]!)
    expect(mask[400 * 1200 + midX]!).toBeLessThan(255)
    expect(mask[400 * 1200 + centerX]).toBe(255)
  })

  it('空脸框 / 零尺寸返回空蒙版，不崩', () => {
    expect(faceMask(0, 0, face).length).toBe(0)
    expect(faceMask(12, 12, { x: 0, y: 0, w: 0, h: 0, confidence: 0 }).every(v => v === 0)).toBe(true)
  })
})
