import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WATERMARK, drawWatermark, hasWatermark, loadTextWatermark,
  saveTextWatermark, watermarkLayout,
  watermarkLogoLayout, watermarkTileLayout,
} from './watermark.ts'

const opts = (patch: Partial<typeof DEFAULT_WATERMARK> = {}) => ({
  ...DEFAULT_WATERMARK, text: 'PinkRose', ...patch,
})

describe('watermarkLayout', () => {
  it('右下角：字号按短边算，位置在右下留白内', () => {
    const l = watermarkLayout('PinkRose', 1200, 800, opts({ sizePct: 4 }))
    expect(l.size).toBe(32)
    expect(l.x).toBeGreaterThan(600)
    expect(l.y).toBeGreaterThan(400)
    expect(l.x + l.width).toBeLessThanOrEqual(1200)
    expect(l.y).toBeLessThanOrEqual(800)
  })

  it('居中和左上角也能正确定位', () => {
    const center = watermarkLayout('水印', 1000, 800, opts({ position: 'center' }))
    expect(center.x).toBeLessThan(500)
    expect(center.x + center.width / 2).toBeCloseTo(500, 0)
    const top = watermarkLayout('水印', 1000, 800, opts({ position: 'top-left' }))
    expect(top.x).toBe(20)
    expect(top.y).toBeLessThan(100)
  })

  it('字号百分比会钳在 1~12，空文字也能得到稳定布局', () => {
    expect(watermarkLayout('x', 1000, 800, opts({ sizePct: 99 })).size).toBe(96)
    expect(watermarkLayout('x', 1000, 800, opts({ sizePct: 0 })).size).toBe(8)
    expect(watermarkLayout('', 1000, 800, opts()).width).toBeGreaterThanOrEqual(8)
  })
})

describe('Logo and tiled watermarks', () => {
  it('Logo 按画面宽度缩放、保持比例，右下角不越界', () => {
    const layout = watermarkLogoLayout(1200, 800, 600, 300, opts({ logoSizePct: 20 }))
    expect(layout.w).toBe(240)
    expect(layout.h).toBe(120)
    expect(layout.x + layout.w).toBeLessThanOrEqual(1200)
    expect(layout.y + layout.h).toBeLessThanOrEqual(800)
  })

  it('平铺位置交错覆盖整张画面', () => {
    const boxes = watermarkTileLayout(1200, 800, 120, 30)
    const centers = boxes.map(b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 }))
    expect(boxes.length).toBeGreaterThan(20)
    expect(centers.some(p => p.x > 0 && p.x < 1200 && p.y > 0 && p.y < 800)).toBe(true)
    expect(new Set(centers.map(p => Math.round(p.y))).size).toBeGreaterThan(5)
  })

  it('文字为空不画；Logo 模式下有图才画', () => {
    expect(hasWatermark({ ...DEFAULT_WATERMARK, text: '   ' }, null)).toBe(false)
    expect(hasWatermark({ ...DEFAULT_WATERMARK, kind: 'logo' }, null)).toBe(false)
    expect(hasWatermark(
      { ...DEFAULT_WATERMARK, kind: 'logo' },
      { source: {} as CanvasImageSource, width: 64, height: 32, name: 'logo.png' },
    )).toBe(true)
  })

  it('文字水印按所选字体绘制，不再固定系统黑体', () => {
    const fillText = vi.fn()
    const ctx = {
      save: vi.fn(), restore: vi.fn(), fillText,
      font: '', textBaseline: '', fillStyle: '',
      shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
      globalAlpha: 1, translate: vi.fn(), rotate: vi.fn(),
    }
    const canvas = {
      width: 1200,
      height: 800,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement

    drawWatermark(canvas, opts({ text: 'PinkRose', font: 'serif' }))
    expect(ctx.font).toContain('Songti SC')
    expect(fillText).toHaveBeenCalledWith('PinkRose', expect.any(Number), expect.any(Number))
  })

  it('文字水印样式会记在本机；清空文字会删掉偏好，Logo 模式不清掉文字偏好', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    }
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, value: storage,
    })
    try {
      saveTextWatermark(opts({
        text: 'PinkRose',
        font: 'serif',
        position: 'top-left',
        opacity: 45,
        sizePct: 7,
        color: '#ffcc00',
        tile: true,
      }))
      expect(loadTextWatermark()).toMatchObject({
        text: 'PinkRose',
        font: 'serif',
        position: 'top-left',
        opacity: 45,
        sizePct: 7,
        color: '#ffcc00',
        tile: true,
        kind: 'text',
      })
      saveTextWatermark(opts({ text: 'PinkRose', kind: 'logo' }))
      expect(loadTextWatermark().text).toBe('PinkRose')
      saveTextWatermark(opts({ text: '   ' }))
      expect(loadTextWatermark().text).toBe('')
    } finally {
      delete (globalThis as { localStorage?: Storage }).localStorage
    }
  })
})
