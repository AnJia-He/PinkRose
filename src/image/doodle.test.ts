import { describe, expect, it, vi } from 'vitest'
import { drawDoodle, type DoodleContext, type DoodleStroke } from './doodle.ts'

function context() {
  return {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), arc: vi.fn(),
    stroke: vi.fn(), fill: vi.fn(),
    globalAlpha: 1, strokeStyle: '#000', fillStyle: '#000',
    lineWidth: 1, lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
  }
}

describe('涂鸦画笔', () => {
  it('按短边百分比算笔刷，归一化坐标映到画布像素', () => {
    const ctx = context()
    const stroke: DoodleStroke = {
      points: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.6 }],
      color: '#ff4d4d', sizePct: 10, opacity: 50,
    }
    drawDoodle(ctx as unknown as DoodleContext, 200, 100, [stroke])
    expect(ctx.lineWidth).toBe(10)
    expect(ctx.strokeStyle).toBe('#ff4d4d')
    expect(ctx.globalAlpha).toBeCloseTo(0.5)
    expect(ctx.moveTo).toHaveBeenCalledWith(20, 20)
    expect(ctx.lineTo).toHaveBeenCalledWith(100, 60)
    expect(ctx.stroke).toHaveBeenCalledTimes(1)
    expect(ctx.restore).toHaveBeenCalledTimes(1)
  })

  it('单点画成圆点', () => {
    const ctx = context()
    drawDoodle(ctx as unknown as DoodleContext, 100, 200, [{
      points: [{ x: 0.5, y: 0.5 }], color: '#fff', sizePct: 4, opacity: 100,
    }])
    expect(ctx.arc).toHaveBeenCalledWith(50, 100, 2, 0, Math.PI * 2)
    expect(ctx.fill).toHaveBeenCalledTimes(1)
    expect(ctx.stroke).not.toHaveBeenCalled()
  })

  it('Apple Pencil pressure: each segment keeps its own width', () => {
    const ctx = context()
    const widths: number[] = []
    let lineWidth = 1
    Object.defineProperty(ctx, 'lineWidth', {
      configurable: true,
      get: () => lineWidth,
      set: (v: number) => { lineWidth = v; widths.push(v) },
    })
    drawDoodle(ctx as unknown as DoodleContext, 100, 100, [{
      points: [
        { x: 0, y: 0, pressure: 0 },
        { x: 0.5, y: 0.5, pressure: 0.5 },
        { x: 1, y: 1, pressure: 1 },
      ],
      color: '#000', sizePct: 10, opacity: 100,
    }])
    expect(ctx.stroke).toHaveBeenCalledTimes(2)
    expect(widths.at(-2)).toBeCloseTo(5.125)
    expect(widths.at(-1)).toBeCloseTo(8.375)
  })

  it('空笔画什么都不画；不透明度钳到 0~100', () => {
    const ctx = context()
    drawDoodle(ctx as unknown as DoodleContext, 100, 100, [])
    expect(ctx.stroke).not.toHaveBeenCalled()
    expect(ctx.fill).not.toHaveBeenCalled()
    drawDoodle(ctx as unknown as DoodleContext, 100, 100, [{
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: '#000', sizePct: 2, opacity: 150,
    }])
    expect(ctx.globalAlpha).toBe(1)
  })
})
