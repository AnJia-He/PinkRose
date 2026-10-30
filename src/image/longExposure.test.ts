import { describe, expect, it } from 'vitest'
import { blendLongExposurePixels, type LongExposureFrame } from './longExposure.ts'

function frame(width: number, height: number, rgba: [number, number, number, number]): LongExposureFrame {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4)
  return { data, width, height }
}

describe('longExposure', () => {
  it('丝滑模式取多帧平均，静态背景不被提亮', () => {
    const a = frame(2, 1, [20, 40, 60, 255])
    const b = frame(2, 1, [100, 120, 140, 255])
    const out = blendLongExposurePixels([a, b], 'smooth')
    expect([...out.slice(0, 4)]).toEqual([60, 80, 100, 255])
    expect([...out.slice(4, 8)]).toEqual([60, 80, 100, 255])
  })

  it('光轨模式逐通道取最亮值，亮线跨帧累积', () => {
    const a = frame(1, 1, [20, 40, 60, 255])
    const b = frame(1, 1, [100, 30, 80, 255])
    const out = blendLongExposurePixels([a, b], 'trail')
    expect([...out]).toEqual([100, 40, 80, 255])
  })

  it('照片尺寸对不上会明确报错', () => {
    expect(() => blendLongExposurePixels([
      frame(2, 1, [0, 0, 0, 255]),
      frame(1, 1, [0, 0, 0, 255]),
    ], 'smooth')).toThrow(/尺寸/)
  })
})
