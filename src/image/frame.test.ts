import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FRAME, frameFractions, frameLayout, normalizeFrameOptions,
} from './frame.ts'

describe('frame', () => {
  it('选项：宽度夹到 0~20、颜色只认 #rrggbb、样式不认识的回纯色', () => {
    expect(normalizeFrameOptions({
      style: 'nope' as never, color: 'red', widthPct: 99,
    })).toEqual({ style: 'solid', color: '#ffffff', widthPct: 20 })
    expect(normalizeFrameOptions({ color: '#a1b2c3', widthPct: -5 }))
      .toMatchObject({ color: '#a1b2c3', widthPct: 0 })
    expect(normalizeFrameOptions({})).toEqual(DEFAULT_FRAME)
  })

  it('正方形纯色边：四边占短边同样的比例', () => {
    const f = frameFractions(1000, 1000, { ...DEFAULT_FRAME, widthPct: 10 })
    expect(f.left).toBeCloseTo(0.1)
    expect(f.top).toBeCloseTo(0.1)
    expect(f.right).toBeCloseTo(0.1)
    expect(f.bottom).toBeCloseTo(0.1)
  })

  it('横图按短边算边宽：左右比例比上下小', () => {
    const f = frameFractions(2000, 1000, { ...DEFAULT_FRAME, widthPct: 10 })
    expect(f.left).toBeCloseTo(0.05)
    expect(f.top).toBeCloseTo(0.1)
    expect(f.right).toBeCloseTo(0.05)
    expect(f.bottom).toBeCloseTo(0.1)
  })

  it('拍立得下边更厚，胶片只压上下两条', () => {
    const p = frameFractions(1000, 1000, { ...DEFAULT_FRAME, style: 'polaroid', widthPct: 10 })
    expect(p.bottom).toBeCloseTo(0.25)
    expect(p.bottom).toBeGreaterThan(p.top)
    const f = frameFractions(1000, 1000, { ...DEFAULT_FRAME, style: 'film', widthPct: 10 })
    expect(f.left).toBe(0)
    expect(f.right).toBe(0)
    expect(f.top).toBeCloseTo(0.14)
    expect(f.bottom).toBeCloseTo(0.14)
  })

  it('像素框和比例框对得上，照片始终有正面积', () => {
    const l = frameLayout(1200, 800, { ...DEFAULT_FRAME, style: 'polaroid', widthPct: 12 })
    expect(l.photo).toEqual({ x: 96, y: 96, w: 1008, h: 464 })
    expect(l.photo.w).toBeGreaterThan(0)
    expect(l.photo.h).toBeGreaterThan(0)
  })
})
