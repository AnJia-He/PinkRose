import { describe, expect, it } from 'vitest'
import {
  findPanoramaOverlap, panoramaFilename, panoramaLayout, panoramaLayoutVertical,
  type PanoramaGray,
} from './panorama'

/**
 * 独立一点的灰度噪声。用 `x * A ^ y * B` 直接取模会在相邻位移上出现
 * 近似周期（实测 50px 的真重叠与 61px 的假重叠相关性都在 0.9999），
 * 夹具自己先把答案搅浑了。这里多过一轮 32 位混合，真重叠才是唯一峰值。
 */
const hash = (x: number, y: number) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 24
}

function strip(width: number, offset: number, height = 32): PanoramaGray {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = hash(x + offset, y)
  }
  return { data, width, height }
}

function verticalStrip(height: number, offset: number, width = 32): PanoramaGray {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = hash(x, y + offset)
  }
  return { data, width, height }
}

describe('全景拼接', () => {
  it('在候选中找到真实的 50px 重叠', () => {
    const left = strip(120, 0)
    const right = strip(100, 70)
    const found = findPanoramaOverlap(left, right, 10, 80)
    expect(found.px).toBeGreaterThanOrEqual(47)
    expect(found.px).toBeLessThanOrEqual(53)
    expect(found.score).toBeGreaterThan(0.8)
  })

  it('按宽度和重叠量从左到右排位置', () => {
    const layout = panoramaLayout([100, 80, 60], [20, 10], 400)
    expect(layout.width).toBe(210)
    expect(layout.height).toBe(400)
    expect(layout.placements).toEqual([
      { x: 0, y: 0, width: 100, height: 400, overlap: 0 },
      { x: 80, y: 0, width: 80, height: 400, overlap: 20 },
      { x: 150, y: 0, width: 60, height: 400, overlap: 10 },
    ])
  })

  it('纵向：在上下两张的接缝里找到 50px 重叠', () => {
    const left = verticalStrip(120, 0)
    const right = verticalStrip(100, 70)
    const found = findPanoramaOverlap(left, right, 10, 80, 'vertical')
    expect(found.px).toBeGreaterThanOrEqual(47)
    expect(found.px).toBeLessThanOrEqual(53)
    expect(found.score).toBeGreaterThan(0.8)
  })

  it('纵向排版：从上到下累加高度，宽度固定', () => {
    const layout = panoramaLayoutVertical([100, 80, 60], [20, 10], 400)
    expect(layout.width).toBe(400)
    expect(layout.height).toBe(210)
    expect(layout.placements).toEqual([
      { x: 0, y: 0, width: 400, height: 100, overlap: 0 },
      { x: 0, y: 80, width: 400, height: 80, overlap: 20 },
      { x: 0, y: 150, width: 400, height: 60, overlap: 10 },
    ])
  })

  it('文件名跟着格式走', () => {
    const at = new Date('2026-10-18T09:05:00')
    expect(panoramaFilename('image/jpeg', at)).toBe('PinkRose-panorama-20261018-0905.jpg')
    expect(panoramaFilename('image/png', at)).toBe('PinkRose-panorama-20261018-0905.png')
  })
})
