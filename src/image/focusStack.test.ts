import { describe, expect, it } from 'vitest'
import {
  createFocusWinners, focusCanvasSize, focusStackFilename, resolveFocusPixels,
  sharpnessMap, updateFocusWinners,
} from './focusStack.ts'

describe('焦点堆栈', () => {
  it('成片高度受上限和 12 MP 目标面积约束', () => {
    expect(focusCanvasSize(4000, 3000, 1600)).toEqual({ width: 2133, height: 1600 })
    expect(focusCanvasSize(4000, 3000, 5000).height).toBe(2400)
    const wide = focusCanvasSize(4000, 1000, 2400)
    expect(wide.height).toBeLessThan(2400)
    expect(wide.width * wide.height).toBeLessThanOrEqual(12_000_000)
  })

  it('清晰度图能区分纹理区和纯色区', () => {
    const w = 32, h = 16
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const v = x < w / 2 ? ((x + y) % 2 ? 255 : 0) : 128
        data[i] = v
        data[i + 1] = v
        data[i + 2] = v
        data[i + 3] = 255
      }
    }
    const sharp = sharpnessMap(data, w, h)
    let left = 0, right = 0
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        if (x < w / 2) left += sharp[y * w + x]!
        else right += sharp[y * w + x]!
      }
    }
    expect(left).toBeGreaterThan(right * 5)
    expect(() => sharpnessMap(new Uint8ClampedArray(4), 2, 2)).toThrow(/尺寸/)
  })

  it('逐像素保留更清楚的一帧，接近时做柔和混合', () => {
    const frameA = {
      width: 4,
      height: 1,
      data: new Uint8ClampedArray([
        255, 0, 0, 255, 255, 0, 0, 255, 20, 20, 20, 255, 20, 20, 20, 255,
      ]),
    }
    const frameB = {
      width: 4,
      height: 1,
      data: new Uint8ClampedArray([
        10, 10, 10, 255, 10, 10, 10, 255, 0, 255, 0, 255, 0, 255, 0, 255,
      ]),
    }
    const winners = createFocusWinners(4)
    updateFocusWinners(winners, frameA, new Float32Array([10, 10, 0, 0]))
    updateFocusWinners(winners, frameB, new Float32Array([0, 0, 10, 10]))
    const out = resolveFocusPixels(winners)
    expect([...out.slice(0, 4)]).toEqual([255, 0, 0, 255])
    expect([...out.slice(8, 12)]).toEqual([0, 255, 0, 255])

    const equal = createFocusWinners(1)
    updateFocusWinners(equal, {
      width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 255, 255]),
    }, new Float32Array([1]))
    updateFocusWinners(equal, {
      width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]),
    }, new Float32Array([1]))
    const blended = resolveFocusPixels(equal)
    expect(blended[0]).toBeGreaterThan(90)
    expect(blended[2]).toBeGreaterThan(90)
  })

  it('文件名带工作流和时间戳', () => {
    expect(focusStackFilename('image/webp', new Date('2026-10-19T08:07:00')))
      .toBe('PinkRose-focus-20261019-0807.webp')
  })
})
