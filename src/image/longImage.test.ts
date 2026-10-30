import { describe, expect, it, vi } from 'vitest'

const { drawCalls, state } = vi.hoisted(() => ({
  drawCalls: [] as unknown[][],
  state: { blobs: 0 },
}))

vi.mock('../core/canvas', () => ({
  makeCanvas: (width: number, height: number) => {
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      clip: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn((...args: unknown[]) => { drawCalls.push(args) }),
      fillStyle: '',
    }
    const canvas = {
      width,
      height,
      toBlob: (cb: (blob: Blob | null) => void, type: string) => {
        cb(new Blob([new Uint8Array([state.blobs++])], { type }))
      },
    }
    return {
      canvas: canvas as unknown as HTMLCanvasElement,
      ctx: ctx as unknown as CanvasRenderingContext2D,
    }
  },
}))

import {
  DEFAULT_LONG_IMAGE_OPTIONS, LONG_IMAGE_MAX_EDGE, exportLongImage,
  longImageFilename, longImagePlan, renderLongImageCanvas,
} from './longImage.ts'

const SOURCES = [
  { image: {} as CanvasImageSource, width: 1200, height: 800 },
  { image: {} as CanvasImageSource, width: 800, height: 600 },
]

describe('长图拼接几何', () => {
  it('纵向：固定宽度、按原比例累加高度和间距', () => {
    const plan = longImagePlan(SOURCES, {
      ...DEFAULT_LONG_IMAGE_OPTIONS, direction: 'vertical', gap: 12, fixedEdge: 1080,
    })
    expect(plan.width).toBe(1080)
    expect(plan.frames[0]).toEqual({ x: 0, y: 0, w: 1080, h: 720 })
    expect(plan.frames[1]).toEqual({ x: 0, y: 732, w: 1080, h: 810 })
    expect(plan.height).toBe(1542)
    expect(plan.scale).toBe(1)
  })

  it('横向：固定高度、按原比例累加宽度和间距', () => {
    const plan = longImagePlan(SOURCES, {
      ...DEFAULT_LONG_IMAGE_OPTIONS, direction: 'horizontal', gap: 12, fixedEdge: 800,
    })
    expect(plan.height).toBe(800)
    expect(plan.frames[0]).toMatchObject({ x: 0, y: 0, w: 1200, h: 800 })
    expect(plan.frames[1]).toMatchObject({ x: 1212, y: 0, w: 1067, h: 800 })
    expect(plan.width).toBe(2279)
  })

  it('总长超过画布上限时整体缩小，仍然保持顺序', () => {
    const tall = Array.from({ length: 4 }, () => ({
      image: {} as CanvasImageSource, width: 1000, height: 10000,
    }))
    const plan = longImagePlan(tall, {
      ...DEFAULT_LONG_IMAGE_OPTIONS, direction: 'vertical', gap: 0, fixedEdge: 1080,
    })
    expect(plan.height).toBeLessThanOrEqual(LONG_IMAGE_MAX_EDGE)
    expect(plan.scale).toBeLessThan(1)
    expect(plan.frames).toHaveLength(4)
  })

  it('固定边会放大 390px 宽的手机截图', () => {
    const plan = longImagePlan([
      { width: 390, height: 844 },
      { width: 390, height: 844 },
    ], {
      ...DEFAULT_LONG_IMAGE_OPTIONS, direction: 'vertical', gap: 0, fixedEdge: 1080,
    })
    expect(plan.width).toBe(1080)
    expect(plan.frames[0]!.h).toBe(Math.round(844 * 1080 / 390))
  })

  it('文件名按格式走，非法字符会被压掉', () => {
    expect(longImageFilename('a/b:c.PNG', 'image/jpeg')).toBe('a_b_c_long.jpg')
    expect(longImageFilename('截图.png', 'image/png')).toBe('截图_long.png')
  })
})

describe('长图渲染 / 导出', () => {
  it('每个来源只画一次，画布尺寸等于 plan', () => {
    drawCalls.length = 0
    const canvas = renderLongImageCanvas(SOURCES, {
      ...DEFAULT_LONG_IMAGE_OPTIONS, direction: 'vertical', gap: 12, fixedEdge: 1080,
    })
    expect(canvas.width).toBe(1080)
    expect(canvas.height).toBe(1542)
    expect(drawCalls).toHaveLength(2)
    expect(drawCalls[0]![1]).toBe(0)
    expect(drawCalls[1]![2]).toBe(732)
  })

  it('导出拿到实际尺寸和按格式命名的文件', async () => {
    const made = await exportLongImage(SOURCES, {
      ...DEFAULT_LONG_IMAGE_OPTIONS, direction: 'vertical', format: 'image/png',
    }, '截图.png')
    expect(made.filename).toBe('截图_long.png')
    expect(made.width).toBe(1080)
    expect(made.height).toBe(1542)
    expect(made.blob.type).toBe('image/png')
  })
})
