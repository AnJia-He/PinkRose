import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STICKER, normalizeStickerOptions, stickerLayout, STICKER_PATHS,
} from './sticker.ts'

describe('sticker', () => {
  it('选项夹取：位置 0~1、大小 2~60、旋转 ±180、颜色 #rrggbb、未知形状回星', () => {
    const a = normalizeStickerOptions({
      shape: 'nope' as never, x: -1, y: 2, sizePct: 999,
      rotation: 999, color: 'red',
    })
    expect(a.shape).toBe('star')
    expect(a.x).toBe(0)
    expect(a.y).toBe(1)
    expect(a.sizePct).toBe(60)
    expect(a.rotation).toBe(180)
    expect(a.color).toBe('#ffffff')
    expect(normalizeStickerOptions({ color: '#a1b2c3' }).color).toBe('#a1b2c3')
  })

  it('不透明度 / 混合模式 / 图片填充 / 翻转都收口到合法值', () => {
    const a = normalizeStickerOptions({
      opacity: 150, blend: 'screen', fit: 'cover', flipH: true, flipV: true,
    })
    expect(a.opacity).toBe(100)
    expect(a.blend).toBe('screen')
    expect(a.fit).toBe('cover')
    expect(a.flipH).toBe(true)
    expect(a.flipV).toBe(true)
    expect(normalizeStickerOptions({ opacity: -10, blend: 'nope' as never }).opacity).toBe(0)
    expect(normalizeStickerOptions({ blend: 'nope' as never }).blend).toBe('normal')
  })

  it('来源只认 shape / image，未知值回内置图形', () => {
    expect(normalizeStickerOptions({}).source).toBe('shape')
    expect(normalizeStickerOptions({ source: 'image' }).source).toBe('image')
    expect(normalizeStickerOptions({ source: 'nope' as never }).source).toBe('shape')
  })

  it('布局：大小按短边算、位置按宽高归一化', () => {
    const l = stickerLayout(1000, 800, {
      ...DEFAULT_STICKER, x: 0.25, y: 0.75, sizePct: 20, rotation: 30,
    })
    expect(l).toEqual({ cx: 250, cy: 600, size: 160, rotation: 30 })
  })

  it('十二种形状都有非空 path', () => {
    for (const shape of [
      'star', 'heart', 'sparkle', 'arrow', 'speech',
      'flower', 'cloud', 'crown', 'music', 'lightning', 'check', 'sun',
    ] as const) {
      expect(STICKER_PATHS[shape].length).toBeGreaterThan(10)
    }
  })
})
