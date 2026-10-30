import { describe, expect, it, vi } from 'vitest'
import { drawLight, LIGHT_PRESETS, type LightOptions } from './light.ts'

function context() {
  const gradient = () => ({ addColorStop: vi.fn() })
  return {
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    fillRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    createLinearGradient: vi.fn((..._args: number[]) => gradient()),
    createRadialGradient: vi.fn((..._args: number[]) => gradient()),
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
  }
}

describe('光效', () => {
  it('五种预设都有名字', () => {
    expect(LIGHT_PRESETS.map(p => p.id)).toEqual(['sun', 'leak', 'bokeh', 'neon', 'relight'])
    expect(new Set(LIGHT_PRESETS.map(p => p.label)).size).toBe(5)
  })

  it('强度 0 = 什么都不画', () => {
    const ctx = context()
    drawLight(ctx as unknown as CanvasRenderingContext2D, 300, 200, {
      preset: 'sun', intensity: 0,
    })
    expect(ctx.fillRect).not.toHaveBeenCalled()
    expect(ctx.fill).not.toHaveBeenCalled()
  })

  it('五种预设分别画到画布上，混合状态会恢复', () => {
    for (const p of LIGHT_PRESETS) {
      const ctx = context()
      drawLight(ctx as unknown as CanvasRenderingContext2D, 300, 200, {
        preset: p.id, intensity: 80,
      } as LightOptions)
      expect(ctx.fillRect.mock.calls.length + ctx.fill.mock.calls.length, p.id)
        .toBeGreaterThan(0)
      expect(ctx.restore).toHaveBeenCalled()
    }
  })

  it('方向光：角度改变光源位置，冷暖改变高光染色；强度 0 仍然不动', () => {
    const top = context()
    drawLight(top as unknown as CanvasRenderingContext2D, 300, 200, {
      preset: 'relight', intensity: 80, angle: 0, warmth: 0,
    })
    const right = context()
    drawLight(right as unknown as CanvasRenderingContext2D, 300, 200, {
      preset: 'relight', intensity: 80, angle: 90, warmth: 100,
    })
    expect(top.createRadialGradient.mock.calls.length).toBe(2)
    expect(right.createRadialGradient.mock.calls.length).toBe(2)
    expect(top.createRadialGradient.mock.calls[0]![0])
      .not.toBe(right.createRadialGradient.mock.calls[0]![0])
    expect(top.fillRect).toHaveBeenCalled()

    const off = context()
    drawLight(off as unknown as CanvasRenderingContext2D, 300, 200, {
      preset: 'relight', intensity: 0, angle: 90, warmth: 100,
    })
    expect(off.fillRect).not.toHaveBeenCalled()
  })
})
