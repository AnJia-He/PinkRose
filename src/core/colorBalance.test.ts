import { describe, it, expect } from 'vitest'
import { axesToWheel, wheelToAxes } from './colorBalance.ts'

const zero = { cbCyanRed: 0, cbMagentaGreen: 0, cbYellowBlue: 0 }

describe('三轴 ↔ 色轮', () => {
  it('零轴在圆心', () => {
    expect(axesToWheel(zero)).toEqual({ x: 0, y: 0 })
  })

  it('★ 拖到"红"方向 → 青—红轴为正，且三轴零和', () => {
    const a = wheelToAxes(1, 0)
    expect(a.cbCyanRed).toBeGreaterThan(0)
    expect(Math.abs(a.cbCyanRed + a.cbMagentaGreen + a.cbYellowBlue)).toBeLessThanOrEqual(2)
  })

  it('★ 往返一致（轴 → 轮 → 轴，误差 ±2 以内）', () => {
    const cases = [
      { cbCyanRed: 60, cbMagentaGreen: -30, cbYellowBlue: -30 },
      { cbCyanRed: -20, cbMagentaGreen: 10, cbYellowBlue: 10 },
      { cbCyanRed: 0, cbMagentaGreen: -45, cbYellowBlue: 45 },
    ]
    for (const c of cases) {
      const { x, y } = axesToWheel(c)
      const back = wheelToAxes(x, y)
      expect(Math.abs(back.cbCyanRed - c.cbCyanRed), JSON.stringify(c)).toBeLessThanOrEqual(2)
      expect(Math.abs(back.cbMagentaGreen - c.cbMagentaGreen)).toBeLessThanOrEqual(2)
      expect(Math.abs(back.cbYellowBlue - c.cbYellowBlue)).toBeLessThanOrEqual(2)
    }
  })

  it('超出圆外的点被钳回圆内（拖到角上不会爆表）', () => {
    const a = wheelToAxes(3, 3)
    for (const v of Object.values(a)) expect(Math.abs(v)).toBeLessThanOrEqual(100)
  })
})
