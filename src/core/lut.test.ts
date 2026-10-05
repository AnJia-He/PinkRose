// src/core/lut.test.ts
import { describe, it, expect } from 'vitest'
import type { Cube } from '../../shared/lut.ts'
import { applyLut, sampleCube } from './lut.ts'
import { applyTone } from './tone.ts'
import { toUnit, ZERO } from '../../shared/adjustments.ts'

/** 由函数造一个 size 级 cube（红变最快）。 */
function makeCube(size: number, fn: (r: number, g: number, b: number) => [number, number, number]): Cube {
  const rgba = new Uint8Array(size * size * size * 4)
  let o = 0
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const v = fn(r / (size - 1), g / (size - 1), b / (size - 1))
        rgba[o++] = Math.round(v[0] * 255)
        rgba[o++] = Math.round(v[1] * 255)
        rgba[o++] = Math.round(v[2] * 255)
        rgba[o++] = 255
      }
  return { size, rgba, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: null }
}

const identity = (n = 2) => makeCube(n, (r, g, b) => [r, g, b])
/** 红蓝对调，用来验方向 */
const swapRB = (n = 2) => makeCube(n, (r, g, b) => [b, g, r])

describe('applyLut', () => {
  it('强度 0 = 逐像素不变（含钳制语义）', () => {
    const cube = swapRB()
    for (const px of [[0, 0, 0], [0.25, 0.5, 0.75], [1, 1, 1], [0.123, 0.987, 0.5]] as const) {
      expect(applyLut(cube, [...px], 0)).toEqual([...px])
    }
  })

  it('强度 100 = 完全查表（红蓝对调能对上）', () => {
    const [r, g, b] = applyLut(swapRB(), [0, 0.5, 1], 100)
    expect(r).toBeCloseTo(1, 2)
    expect(g).toBeCloseTo(0.5, 2)
    expect(b).toBeCloseTo(0, 2)
  })

  it('强度在中间就是线性混合', () => {
    const half = applyLut(swapRB(4), [0.2, 0.5, 0.8], 50)
    expect(half[0]).toBeCloseTo((0.2 + 0.8) / 2, 2)
  })

  it('恒等表在任何强度下都不变', () => {
    const [r, g, b] = applyLut(identity(4), [0.3, 0.6, 0.9], 100)
    expect(r).toBeCloseTo(0.3, 2)
    expect(g).toBeCloseTo(0.6, 2)
    expect(b).toBeCloseTo(0.9, 2)
  })

  it('三线性：2 级恒等表在中间点插值正确', () => {
    const [r, g, b] = sampleCube(identity(2), 0.5, 0.25, 0.75)
    expect(r).toBeCloseTo(0.5, 2)
    expect(g).toBeCloseTo(0.25, 2)
    expect(b).toBeCloseTo(0.75, 2)
  })

  it('domain 参与换算', () => {
    const cube = identity(2)
    cube.domainMax = [2, 2, 2]
    // 输入 2（顶层）应命中表里最后一格 = 白
    const [r] = sampleCube(cube, 2, 2, 2)
    expect(r).toBeCloseTo(1, 2)
  })
})

describe('管线顺序（契约）', () => {
  it('LUT 在参数之后：两种顺序的结果必须不同（把这行反过来 = 红）', () => {
    // ⚠️ 曲线要选**真的**强非线性（这里是 gamma 0.25）。
    // 不能拿"分段斜线 + 截断"那种（如 min(1, r*1.8)）冒充强非线性：它几乎线性，
    // 先用后用的差只有 0.0046，钉不住这条契约（计划里给的正是这一条，实测红）。
    const cube = makeCube(4, (r, g, b) => [Math.pow(r, 0.25), Math.pow(g, 0.25), Math.pow(b, 0.25)])
    const u = toUnit({ ...ZERO, exposure: 40 })
    const px: [number, number, number] = [0.3, 0.55, 0.2]
    const correctOrder = applyLut(cube, applyTone(px, u), 100)
    const wrongOrder = applyTone(applyLut(cube, px, 100), u)
    const diff = correctOrder.map((v, i) => Math.abs(v - wrongOrder[i]!)).reduce((a, b) => a + b, 0)
    expect(diff).toBeGreaterThan(0.05)   // 差别要明显（实测 ~0.099），别拿噪声当断言
  })
})
