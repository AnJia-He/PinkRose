import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_POSTER, drawPoster, POSTER_TEMPLATES, type PosterSource,
} from './poster.ts'

function context() {
  const gradient = () => ({ addColorStop: vi.fn() })
  return {
    save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), fill: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), arcTo: vi.fn(), closePath: vi.fn(), clip: vi.fn(),
    drawImage: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    createLinearGradient: vi.fn(gradient), createRadialGradient: vi.fn(gradient),
    measureText: vi.fn((text: string) => ({ width: [...text].length * 10 })),
    font: '', textAlign: 'center', textBaseline: 'middle', fillStyle: '#000',
    strokeStyle: '#000', lineWidth: 1, lineJoin: 'round',
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
  }
}

const source = { width: 900, height: 1200 } as PosterSource

describe('社交封面', () => {
  it('四种模板尺寸分别是 3:4 / 1:1 / 9:16 / 3:4', () => {
    expect(POSTER_TEMPLATES.map(t => t.id)).toEqual([
      'xiaohongshu', 'moments', 'story', 'magazine',
    ])
    expect(POSTER_TEMPLATES.map(t => [t.width, t.height])).toEqual([
      [1080, 1440], [1080, 1080], [1080, 1920], [1080, 1440],
    ])
  })

  it('每种模板都画出照片、文字和强调线', () => {
    for (const template of POSTER_TEMPLATES) {
      const ctx = context()
      expect(() => drawPoster(
        ctx as unknown as CanvasRenderingContext2D,
        source,
        template.width,
        template.height,
        { ...DEFAULT_POSTER, template: template.id, date: '2026.10.20' },
      )).not.toThrow()
      expect(ctx.drawImage).toHaveBeenCalled()
      expect(ctx.fillText).toHaveBeenCalled()
      expect(ctx.fillRect).toHaveBeenCalled()
    }
  })

  it('标题过长会折行，而不是整行溢出', () => {
    const ctx = context()
    drawPoster(
      ctx as unknown as CanvasRenderingContext2D,
      source, 1080, 1440,
      {
        ...DEFAULT_POSTER,
        title: '这是一个明显超过一行宽度的很长很长的标题，用来确认它会自动折行',
      },
    )
    expect(ctx.fillText.mock.calls.length).toBeGreaterThan(1)
  })
})
