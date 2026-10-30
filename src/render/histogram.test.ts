import { describe, expect, it } from 'vitest'
import { computeHistogram } from './histogram'

const rgba = (...px: [number, number, number][]) => {
  const out = new Uint8Array(px.length * 4)
  px.forEach(([r, g, b], i) => {
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = 255
  })
  return out
}

describe('computeHistogram', () => {
  it('三条通道各归各的柱，峰值归一到 1', () => {
    const h = computeHistogram(rgba([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]), 4)
    expect(h.r).toHaveLength(4)
    expect(h.g).toHaveLength(4)
    expect(h.b).toHaveLength(4)
    expect(h.r[3]).toBeCloseTo(1)
    expect(h.g[3]).toBeCloseTo(1)
    expect(h.b[3]).toBeCloseTo(1)
    expect(Math.max(...h.r)).toBeCloseTo(1)
    expect(Math.max(...h.g)).toBeCloseTo(1)
    expect(Math.max(...h.b)).toBeCloseTo(1)
  })

  it('暗部 / 高光溢出只数三通道同时贴边的像素', () => {
    const h = computeHistogram(rgba(
      [0, 0, 0], [2, 1, 0], [255, 255, 255], [252, 252, 252], [255, 0, 0],
    ))
    expect(h.shadowClip).toBeCloseTo(2 / 5)
    expect(h.highlightClip).toBeCloseTo(2 / 5)
  })

  it('低柱也被归一化得看得见（不是线性把尾巴压成 0）', () => {
    const h = computeHistogram(rgba(
      [0, 0, 0], [0, 0, 0], [0, 0, 0], [128, 0, 0], [255, 0, 0],
    ), 4)
    expect(h.r[2]).toBeGreaterThan(0.5)
    expect(h.r[3]).toBeGreaterThan(0.5)
  })

  it('波形按列给出亮度分位，矢量示波器把中性灰放在中心', () => {
    const h = computeHistogram(rgba(
      [0, 0, 0], [255, 255, 255],
      [128, 128, 128], [128, 128, 128],
    ), 64, 4, 1)
    expect(h.waveform).toHaveLength(48)
    expect(h.waveform[0]!.high).toBeLessThan(0.1)
    expect(h.waveform[12]!.high).toBeGreaterThan(0.9)
    expect(h.waveform[24]!.mid).toBeCloseTo(0.5, 1)
    expect(h.vectorscope.length).toBeGreaterThan(0)
    expect(h.vectorscope[0]!.x).toBeCloseTo(0.5, 1)
    expect(h.vectorscope[0]!.y).toBeCloseTo(0.5, 1)
    expect(h.vectorscope[0]!.density).toBeLessThanOrEqual(1)
  })

  it('空输入 / 非法柱数安全处理', () => {
    const empty = computeHistogram(new Uint8Array(0))
    expect(empty.r).toEqual([])
    expect(empty.waveform).toEqual([])
    expect(empty.vectorscope).toEqual([])
    expect(empty.shadowClip).toBe(0)
    expect(empty.highlightClip).toBe(0)
    expect(() => computeHistogram(new Uint8Array(4), 1)).toThrow()
  })
})
