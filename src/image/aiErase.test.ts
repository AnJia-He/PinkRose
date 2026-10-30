import { describe, expect, it } from 'vitest'
import {
  AI_ERASE_PROMPT,
  blendInpaintPixels,
  inpaintAreaTooLarge,
  planInpaintCrop,
} from './aiErase'

describe('AI 消除：裁切与回贴', () => {
  it('裁切框包住选区、留出上下文，并夹在原图内', () => {
    const plan = planInpaintCrop(1200, 800, {
      x0: 500, y0: 300, x1: 620, y1: 430, count: 120 * 130,
    })
    expect(plan.crop.x).toBeLessThanOrEqual(500)
    expect(plan.crop.y).toBeLessThanOrEqual(300)
    expect(plan.crop.x + plan.crop.w).toBeGreaterThanOrEqual(620)
    expect(plan.crop.y + plan.crop.h).toBeGreaterThanOrEqual(430)
    expect(plan.crop.x).toBeGreaterThanOrEqual(0)
    expect(plan.crop.y).toBeGreaterThanOrEqual(0)
    expect(plan.crop.x + plan.crop.w).toBeLessThanOrEqual(1200)
    expect(plan.crop.y + plan.crop.h).toBeLessThanOrEqual(800)
    expect(plan.size).toEqual({ width: 1024, height: 1024 })
    expect(plan.draw.w).toBeGreaterThan(0)
    expect(plan.draw.h).toBeGreaterThan(0)
  })

  it('选区贴着左上角时，方图里的落点仍然完整且在框内', () => {
    const plan = planInpaintCrop(640, 480, {
      x0: 0, y0: 0, x1: 32, y1: 32, count: 1024,
    })
    expect(plan.crop.x).toBe(0)
    expect(plan.crop.y).toBe(0)
    expect(plan.draw.x).toBeGreaterThanOrEqual(0)
    expect(plan.draw.y).toBeGreaterThanOrEqual(0)
    expect(plan.draw.x + plan.draw.w).toBeLessThanOrEqual(1024)
    expect(plan.draw.y + plan.draw.h).toBeLessThanOrEqual(1024)
  })

  it('掩码为 0 的像素一个字节都不动', () => {
    const base = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255])
    const patch = new Uint8ClampedArray([200, 210, 220, 0, 230, 240, 250, 0])
    blendInpaintPixels(base, patch, new Uint8Array([0, 0]))
    expect([...base]).toEqual([10, 20, 30, 255, 40, 50, 60, 255])
  })

  it('掩码为 255 的像素完全换成回图，alpha 仍保留原值', () => {
    const base = new Uint8ClampedArray([10, 20, 30, 255])
    const patch = new Uint8ClampedArray([200, 210, 220, 0])
    blendInpaintPixels(base, patch, new Uint8Array([255]))
    expect([...base]).toEqual([200, 210, 220, 255])
  })

  it('软边按覆盖率取中值', () => {
    const base = new Uint8ClampedArray([0, 0, 0, 255])
    const patch = new Uint8ClampedArray([200, 100, 40, 255])
    blendInpaintPixels(base, patch, new Uint8Array([128]))
    expect([...base]).toEqual([100, 50, 20, 255])
  })

  it('选区太大时拦下来，小选区放行', () => {
    expect(inpaintAreaTooLarge(1000, 1000, { x0: 0, y0: 0, x1: 800, y1: 800 })).toBe(true)
    expect(inpaintAreaTooLarge(1000, 1000, { x0: 100, y0: 100, x1: 500, y1: 500 })).toBe(false)
  })

  it('提示词明确指向红标，且不会让服务端追加“保留人物”', () => {
    expect(AI_ERASE_PROMPT).toContain('red overlay')
    expect(AI_ERASE_PROMPT).toContain('Do not preserve the person')
    expect(AI_ERASE_PROMPT).toContain('Keep everything else unchanged')
  })
})
