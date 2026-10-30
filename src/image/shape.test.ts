import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHAPE, normalizeShapeOptions, shapeDrawing,
} from './shape.ts'

describe('normalizeShapeOptions', () => {
  it('端点夹到 0~1，线宽 / 圆角 / 不透明度按范围收口', () => {
    const o = normalizeShapeOptions({
      kind: 'ellipse',
      x1: -1, y1: 2, x2: 3, y2: -4,
      color: '#ABCDEF',
      strokePct: 99,
      fillOpacity: -5,
      radiusPct: 99,
      opacity: 150,
      blend: 'overlay',
    })
    expect(o).toMatchObject({
      kind: 'ellipse',
      x1: 0, y1: 1, x2: 1, y2: 0,
      color: '#abcdef',
      strokePct: 8,
      fillOpacity: 0,
      radiusPct: 30,
      opacity: 100,
      blend: 'overlay',
    })
  })

  it('未知形状 / 非 hex 颜色回默认值；缺字段逐项补默认', () => {
    const o = normalizeShapeOptions({ kind: 'star' as never, color: 'red' })
    expect(o.kind).toBe(DEFAULT_SHAPE.kind)
    expect(o.color).toBe(DEFAULT_SHAPE.color)
    expect(o.x1).toBe(DEFAULT_SHAPE.x1)
    expect(o.opacity).toBe(DEFAULT_SHAPE.opacity)
    expect(o.blend).toBe(DEFAULT_SHAPE.blend)
  })
})

describe('shapeDrawing', () => {
  it('矩形按两个端点归一化，线宽按短边百分比算', () => {
    const d = shapeDrawing(200, 100, {
      kind: 'rect', x1: 0.1, y1: 0.2, x2: 0.6, y2: 0.8, strokePct: 2,
    })
    expect(d.strokePx).toBe(2)
    expect(d.stroke).toContain('M 20 20')
    expect(d.stroke).toContain('H 120')
    expect(d.stroke).toContain('V 80')
    expect(d.fill).toBe(d.stroke)
  })

  it('圆角矩形用二次曲线，圆角不超过短边的一半', () => {
    const d = shapeDrawing(100, 100, {
      kind: 'rect', x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9, radiusPct: 90,
    })
    expect(d.stroke).toContain('Q')
    expect(d.stroke).not.toContain('M 10 10 H 90')
  })

  it('椭圆走两段圆弧；直线只描边不填充', () => {
    const ellipse = shapeDrawing(200, 100, {
      kind: 'ellipse', x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.8,
    })
    expect(ellipse.stroke).toContain('A 80 30')
    expect(ellipse.fill).toBe(ellipse.stroke)

    const line = shapeDrawing(200, 100, {
      kind: 'line', x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.8,
    })
    expect(line.stroke).toBe('M 20 20 L 180 80')
    expect(line.fill).toBeNull()
  })

  it('箭头用描边色填头；线在箭头底部收住，尖端不冒线', () => {
    const d = shapeDrawing(400, 300, {
      kind: 'arrow', x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, strokePct: 1,
    })
    expect(d.fillWithStroke).toBe(true)
    expect(d.fill).toMatch(/^M 360 150 L /)
    expect(d.stroke).toMatch(/^M 40 150 L /)
    expect(d.stroke).not.toContain('L 360 150')
  })

  it('零长度箭头不画一个没有方向的头', () => {
    const d = shapeDrawing(100, 100, {
      kind: 'arrow', x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5,
    })
    expect(d.fill).toBeNull()
    expect(d.stroke).toBe('M 50 50')
  })
})
