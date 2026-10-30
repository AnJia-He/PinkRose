import { describe, it, expect } from 'vitest'
import { ZERO, type Adjustments } from '../../shared/adjustments.ts'
import {
  CURVE_POINTS, curvePoints, curveValueAt, paramForCurveY,
  CHANNEL_CURVE_KEYS, channelCurvePoints, channelCurveValueAt,
  paramForChannelCurveY, channelCurveActive, applyChannelCurvePreset,
} from './toneCurve.ts'

const at = (patch: Partial<Adjustments>) => ({ ...ZERO, ...patch })

describe('toneCurve', () => {
  it('中立点是五个等距控制点（0 / .25 / .5 / .75 / 1）', () => {
    expect(CURVE_POINTS).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(curvePoints(ZERO)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('抬黑场 / 压白场按各自方向走，且不会翻折', () => {
    const lifted = curvePoints(at({ curveBlack: 100, curveWhite: -100 }))
    expect(lifted[0]).toBeCloseTo(0.25)
    expect(lifted[4]).toBeCloseTo(0.75)
    expect(lifted).toEqual([...lifted].sort((a, b) => a - b))
  })

  it('中间调 +100 把中点抬到 .75；-100 压到 .25', () => {
    expect(curvePoints(at({ curveMidtones: 100 }))[2]).toBeCloseTo(0.75)
    expect(curvePoints(at({ curveMidtones: -100 }))[2]).toBeCloseTo(0.25)
  })

  it('控制点交叉时被夹成单调曲线（后面的点不许低于前面的点）', () => {
    const y = curvePoints(at({
      curveShadows: 100,
      curveMidtones: -100,
      curveHighlights: -100,
    }))
    for (let i = 1; i < y.length; i++) expect(y[i]!).toBeGreaterThanOrEqual(y[i - 1]!)
  })

  it('control points 处插值取精确值，段内是平滑的', () => {
    const v = at({ curveMidtones: 100 })
    for (const x of CURVE_POINTS) {
      const i = CURVE_POINTS.indexOf(x)
      expect(curveValueAt(v, x)).toBeCloseTo(curvePoints(v)[i]!)
    }
    expect(curveValueAt(v, 0.5)).toBeCloseTo(0.75)
    expect(curveValueAt(v, 0.45)).toBeGreaterThan(0.5)
    expect(curveValueAt(v, 0.45)).toBeLessThan(0.75)
  })

  it('拖点反解参数：在控制点上往返一致', () => {
    for (const i of [0, 1, 2, 3, 4] as const) {
      const y = curvePoints(at({ curveMidtones: 40 }))[i]!
      const param = paramForCurveY(i, y)
      expect(Number.isFinite(param)).toBe(true)
    }
    expect(paramForCurveY(2, 0.75)).toBeCloseTo(100)
    expect(paramForCurveY(2, 0.25)).toBeCloseTo(-100)
    expect(paramForCurveY(0, -1)).toBe(0)
    expect(paramForCurveY(4, 2)).toBe(0)
  })

  it('★ RGB 分通道：红 / 绿 / 蓝各有五个独立控制点', () => {
    expect(CHANNEL_CURVE_KEYS.red).toEqual([
      'curveRedBlack', 'curveRedShadows', 'curveRedMidtones', 'curveRedHighlights', 'curveRedWhite',
    ])
    expect(channelCurvePoints(ZERO, 'red')).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(channelCurvePoints(ZERO, 'green')).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(channelCurvePoints(ZERO, 'blue')).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('★ 红色中间调 +100 只改红通道，绿 / 蓝 / 整体曲线不动', () => {
    const v = at({ curveRedMidtones: 100 })
    expect(channelCurvePoints(v, 'red')[2]).toBeCloseTo(0.75)
    expect(channelCurvePoints(v, 'green')[2]).toBeCloseTo(0.5)
    expect(channelCurvePoints(v, 'blue')[2]).toBeCloseTo(0.5)
    expect(curvePoints(v)[2]).toBeCloseTo(0.5)
    expect(channelCurveValueAt(v, 'red', 0.5)).toBeCloseTo(0.75)
    expect(channelCurveValueAt(v, 'green', 0.5)).toBeCloseTo(0.5)
  })

  it('★ RGB 曲线的拖点反解和总开关各走各的', () => {
    expect(paramForChannelCurveY('red', 2, 0.75)).toBeCloseTo(100)
    expect(paramForChannelCurveY('blue', 4, 2)).toBe(0)
    expect(channelCurveActive(ZERO, 'red')).toBe(false)
    expect(channelCurveActive(at({ curveGreenMidtones: 30 }), 'green')).toBe(true)
    expect(channelCurveActive(at({ curveGreenMidtones: 30 }), 'red')).toBe(false)
  })

  it('★ 曲线预设只改当前通道，保留曝光和其余通道', () => {
    const before = at({
      exposure: 17,
      curveMidtones: 23,
      curveGreenMidtones: -35,
    })
    const next = applyChannelCurvePreset(before, 'red', 'contrast')
    expect(next.exposure).toBe(17)
    expect(next.curveMidtones).toBe(23)
    expect(next.curveGreenMidtones).toBe(-35)
    expect(CHANNEL_CURVE_KEYS.red.some(key => next[key] !== before[key])).toBe(true)
    expect(CHANNEL_CURVE_KEYS.green.every(key => next[key] === before[key])).toBe(true)
    const points = channelCurvePoints(next, 'red')
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!).toBeGreaterThanOrEqual(points[i - 1]!)
    }
  })
})
