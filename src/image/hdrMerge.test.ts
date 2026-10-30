import { describe, expect, it } from 'vitest'
import {
  estimateHdrShift, fuseHdrPixels, hdrCanvasSize, hdrFilename,
  type HdrFrame, type HdrGray,
} from './hdrMerge.ts'

function sceneFrame(exposure: number, w = 96, h = 64): HdrFrame {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const base = x < w / 2 ? 0.15 : 0.88
      const texture = (((x * 37 + y * 19) % 11) - 5) / 100
      data[i] = Math.round(Math.max(0, Math.min(1, (base + texture) * exposure)) * 255)
      data[i + 1] = Math.round(Math.max(0, Math.min(1, (base + texture) * exposure)) * 245)
      data[i + 2] = Math.round(Math.max(0, Math.min(1, (base + texture) * exposure)) * 230)
      data[i + 3] = 255
    }
  }
  return { data, width: w, height: h }
}

function meanR(f: HdrFrame, x0: number, x1: number): number {
  let sum = 0, n = 0
  for (let y = 0; y < f.height; y++) {
    for (let x = x0; x < x1; x++) {
      sum += f.data[(y * f.width + x) * 4]!
      n++
    }
  }
  return sum / n
}

describe('HDR 合成', () => {
  it('融合后阴影提亮、高光保住，输出不透明', () => {
    const dark = sceneFrame(0.25)
    const mid = sceneFrame(1)
    const bright = sceneFrame(4)
    const merged = fuseHdrPixels([dark, mid, bright], 'natural')
    const out: HdrFrame = { data: merged, width: 96, height: 64 }
    expect(meanR(out, 0, 48)).toBeGreaterThan(meanR(dark, 0, 48) + 8)
    expect(meanR(out, 48, 96)).toBeLessThan(meanR(mid, 48, 96) - 8)
    let opaque = true
    for (let i = 3; i < merged.length; i += 4) if (merged[i] !== 255) opaque = false
    expect(opaque).toBe(true)
  })

  it('风格会改变输出，但不会把像素打乱', () => {
    const frames = [sceneFrame(0.25), sceneFrame(1), sceneFrame(4)]
    const natural = fuseHdrPixels(frames, 'natural')
    const dramatic = fuseHdrPixels(frames, 'dramatic')
    let diff = 0
    for (let i = 0; i < natural.length; i += 4) diff += Math.abs(natural[i]! - dramatic[i]!)
    expect(diff).toBeGreaterThan(100)
  })

  it('估计机位抖动：内容右移 4 / 下移 2 → 绘制偏移 -4 / -2', () => {
    const w = 80, h = 60
    const ref: HdrGray = { data: new Uint8ClampedArray(w * h), width: w, height: h }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        ref.data[y * w + x] = ((x * 73856093) ^ (y * 19349663)) >>> 24
      }
    }
    const moving: HdrGray = { data: new Uint8ClampedArray(w * h), width: w, height: h }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = x - 4, sy = y - 2
        moving.data[y * w + x] = sx >= 0 && sx < w && sy >= 0 && sy < h
          ? ref.data[sy * w + sx]!
          : 0
      }
    }
    const found = estimateHdrShift(ref, moving, 6, 6)
    expect(found.x).toBe(-4)
    expect(found.y).toBe(-2)
    expect(found.score).toBeGreaterThan(0.8)
  })

  it('输出尺寸跟高度走，并对超大图降高度', () => {
    expect(hdrCanvasSize(3000, 2000, 1600)).toEqual({ width: 2400, height: 1600 })
    const huge = hdrCanvasSize(160000, 8000, 2000)
    expect(huge.width * huge.height).toBeLessThanOrEqual(16_000_000)
  })

  it('文件名跟着格式走', () => {
    const at = new Date('2026-10-18T10:25:00')
    expect(hdrFilename('image/jpeg', at)).toBe('PinkRose-hdr-20261018-1025.jpg')
    expect(hdrFilename('image/webp', at)).toBe('PinkRose-hdr-20261018-1025.webp')
  })
})
