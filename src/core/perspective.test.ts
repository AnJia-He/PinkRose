import { describe, expect, it } from 'vitest'
import {
  defaultPerspectiveQuad, isIdentityPerspective, mapUnitSquare, movePerspectiveHandle,
  perspectiveBounds, squareToQuad, type PerspectiveQuad,
} from './perspective.ts'

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('四角透视算式', () => {
  it('恒等四边形：四个角映射回原图四角，边界不变', () => {
    const quad = defaultPerspectiveQuad()
    expect(isIdentityPerspective(quad)).toBe(true)
    const m = squareToQuad(quad, 400, 300)
    const tl = mapUnitSquare(m, 0, 0)
    const tr = mapUnitSquare(m, 1, 0)
    const br = mapUnitSquare(m, 1, 1)
    const bl = mapUnitSquare(m, 0, 1)
    near(tl.x, 0); near(tl.y, 0)
    near(tr.x, 400); near(tr.y, 0)
    near(br.x, 400); near(br.y, 300)
    near(bl.x, 0); near(bl.y, 300)
    expect(perspectiveBounds(quad, 400, 300)).toMatchObject({
      x0: 0, y0: 0, x1: 400, y1: 300, width: 400, height: 300,
    })
  })

  it('★ 梯形四角精确映射到输出四角', () => {
    const quad: PerspectiveQuad = [
      { x: 0.2, y: 0.1 }, { x: 0.8, y: 0.05 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.8 },
    ]
    const m = squareToQuad(quad, 1000, 800)
    const corners = [mapUnitSquare(m, 0, 0), mapUnitSquare(m, 1, 0), mapUnitSquare(m, 1, 1), mapUnitSquare(m, 0, 1)]
    near(corners[0]!.x, 200); near(corners[0]!.y, 80)
    near(corners[1]!.x, 800); near(corners[1]!.y, 40)
    near(corners[2]!.x, 900); near(corners[2]!.y, 720)
    near(corners[3]!.x, 100); near(corners[3]!.y, 640)
  })

  it('拖角时保持左右 / 上下次序，不交叉', () => {
    const quad = defaultPerspectiveQuad()
    const moved = movePerspectiveHandle(quad, 0, { x: 1, y: 1 })
    expect(moved[0].x).toBeLessThanOrEqual(moved[1].x - 0.02)
    expect(moved[0].y).toBeLessThanOrEqual(moved[3].y - 0.02)
    expect(isIdentityPerspective(moved)).toBe(false)
  })
})
