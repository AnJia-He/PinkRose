import { describe, it, expect } from 'vitest'
import { coverCrop } from './lutPreview.ts'

describe('coverCrop', () => {
  it('横图：裁左右', () => {
    expect(coverCrop(400, 200, 100, 100)).toEqual({ sx: 100, sy: 0, sw: 200, sh: 200 })
  })
  it('竖图：裁上下', () => {
    expect(coverCrop(200, 400, 100, 100)).toEqual({ sx: 0, sy: 100, sw: 200, sh: 200 })
  })
  it('正好方形：一个像素都不裁', () => {
    expect(coverCrop(300, 300, 100, 100)).toEqual({ sx: 0, sy: 0, sw: 300, sh: 300 })
  })
})
