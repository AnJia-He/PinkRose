import { describe, it, expect } from 'vitest'
import { rgbaToSamples } from './sample'

describe('rgbaToSamples', () => {
  it('每 4 个字节取一个像素，丢掉 alpha', () => {
    expect(rgbaToSamples(new Uint8ClampedArray([
      10, 20, 30, 255,
      40, 50, 60, 128,
    ]))).toEqual([[10, 20, 30], [40, 50, 60]])
  })

  it('空输入给空数组，不抛', () => {
    expect(rgbaToSamples(new Uint8ClampedArray([]))).toEqual([])
  })

  it('六个像素、每个通道都不一样 —— 步长写错就露馅', () => {
    // canvas 的 RGBA 是交织的四字节：步长写成 3（当成 RGB）或 1 都会在这一组红。
    const data = new Uint8ClampedArray(24)
    for (let i = 0; i < 24; i++) data[i] = i * 10
    const out = rgbaToSamples(data)
    expect(out).toHaveLength(6)
    expect(out[0]).toEqual([0, 10, 20])
    expect(out[5]).toEqual([200, 210, 220])
  })
})
