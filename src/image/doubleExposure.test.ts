import { describe, expect, it } from 'vitest'
import { BLEND_COMPOSITE, coverRect } from './doubleExposure.ts'

describe('double exposure helpers', () => {
  it('cover 横图：按高度铺满，左右居中裁切', () => {
    expect(coverRect(1000, 500, 400, 400)).toEqual({
      x: -200, y: 0, width: 800, height: 400,
    })
  })

  it('cover 竖图：按宽度铺满，上下居中裁切', () => {
    expect(coverRect(500, 1000, 400, 400)).toEqual({
      x: 0, y: -200, width: 400, height: 800,
    })
  })

  it('四种混合模式都映射到 Canvas 的合成操作', () => {
    expect(BLEND_COMPOSITE).toEqual({
      normal: 'source-over', screen: 'screen', multiply: 'multiply', overlay: 'overlay',
    })
  })
})
