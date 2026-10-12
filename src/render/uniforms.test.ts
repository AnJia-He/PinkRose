import { describe, it, expect } from 'vitest'
import { UNIFORM_NAMES, uniformValues } from './uniforms'
import { ZERO } from '../../shared/adjustments'

describe('uniformValues', () => {
  it('15 个名字一个不少', () => {
    expect(UNIFORM_NAMES).toHaveLength(15)
    expect(new Set(UNIFORM_NAMES).size).toBe(15)
  })
  it('全零参数映射全零', () => {
    const v = uniformValues(ZERO)
    for (const n of UNIFORM_NAMES) expect(v[n]).toBe(0)
  })
  it('100 映射到 1（toUnit 在函数内做过）', () => {
    const v = uniformValues({ ...ZERO, exposure: 100 })
    expect(v.uExposure).toBe(1)
  })
})
