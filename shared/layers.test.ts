import { describe, expect, it } from 'vitest'
import { DEFAULT_TEXT } from './text.ts'
import { DEFAULT_SHAPE } from './shape.ts'
import { DEFAULT_STICKER } from './sticker.ts'
import { normalizeEditLayers, sameEditLayers } from './layers.ts'

describe('文字 / 形状层协议', () => {
  it('同时接受文字层和形状层，按 kind 归一化', () => {
    const layers = normalizeEditLayers([
      { kind: 'text', id: 't1', options: { ...DEFAULT_TEXT, text: '你好' } },
      { kind: 'shape', id: 's1', options: { ...DEFAULT_SHAPE, kind: 'arrow', opacity: 60 } },
      { kind: 'sticker', id: 'k1', options: { ...DEFAULT_STICKER, shape: 'heart' }, image: null },
    ])
    expect(layers).toHaveLength(3)
    expect(layers[0]).toMatchObject({ kind: 'text', id: 't1', options: { text: '你好' } })
    expect(layers[1]).toMatchObject({ kind: 'shape', id: 's1', options: { kind: 'arrow', opacity: 60 } })
    expect(layers[2]).toMatchObject({ kind: 'sticker', id: 'k1', options: { shape: 'heart' } })
  })

  it('坏层 / 空文字 / 全透明形状 / 重复 id 只丢自己', () => {
    const layers = normalizeEditLayers([
      { kind: 'text', id: 'empty', options: { ...DEFAULT_TEXT, text: '  ' } },
      { kind: 'shape', id: 'invisible', options: { ...DEFAULT_SHAPE, opacity: 0 } },
      { kind: 'shape', id: 'ok', options: DEFAULT_SHAPE },
      { kind: 'shape', id: 'ok', options: { ...DEFAULT_SHAPE, kind: 'ellipse' } },
      { kind: 'shape' },
    ])
    expect(layers).toEqual([{ kind: 'shape', id: 'ok', options: DEFAULT_SHAPE }])
  })

  it('sameEditLayers 按 id / kind / 选项值比较，不看数组身份', () => {
    const a = [{ kind: 'shape' as const, id: 's', options: DEFAULT_SHAPE }]
    const b = [{ kind: 'shape' as const, id: 's', options: { ...DEFAULT_SHAPE } }]
    expect(sameEditLayers(a, b)).toBe(true)
    b[0]!.options.opacity = 50
    expect(sameEditLayers(a, b)).toBe(false)
  })

  it('自定义图片贴纸没有合法 data URL 时丢掉，有则保留', () => {
    const base = { kind: 'sticker' as const, id: 's', options: { ...DEFAULT_STICKER, source: 'image' as const } }
    expect(normalizeEditLayers([base])).toEqual([])
    const ok = normalizeEditLayers([{ ...base, image: 'data:image/png;base64,AAAA' }])
    expect(ok).toHaveLength(1)
    expect((ok[0] as { image?: string }).image).toBe('data:image/png;base64,AAAA')
  })

  it('★ 可回改局部层：掩码 + 参数归一化，坏的 / 全零的只丢自己', async () => {
    const local = {
      kind: 'local', id: 'l1',
      mask: 'data:image/png;base64,AAAA',
      maskWidth: 640, maskHeight: 480,
      feather: 42,
      options: { effect: 'tone', exposure: 30, contrast: 0, saturation: 0, temperature: 0 },
    }
    const layers = normalizeEditLayers([
      local,
      { ...local, id: 'noop', options: { effect: 'tone' } },
      { ...local, id: 'nomask', mask: 'https://example.com/x.png' },
      { ...local, id: 'bad-dims', maskWidth: 0, maskHeight: 0 },
      { ...local, id: 'l2', options: { effect: 'teeth', effectStrength: 70 } },
    ])
    expect(layers.map(l => l.id)).toEqual(['l1', 'l2'])
    expect(layers[0]).toMatchObject({
      kind: 'local', feather: 42, maskWidth: 640, maskHeight: 480,
      options: { effect: 'tone', exposure: 30 },
    })
    expect(layers[1]).toMatchObject({ options: { effect: 'teeth', effectStrength: 70 } })

    const [tone] = normalizeEditLayers([{
      ...local, id: 'tone-hs',
      options: {
        effect: 'tone', highlights: -30, shadows: 45, vibrance: 20, clarity: 10,
      },
    }])
    expect(tone.options).toMatchObject({
      highlights: -30, shadows: 45, vibrance: 20, clarity: 10,
    })
    const { normalizeLocalAdjustOptions } = await import('./local.ts')
    expect(normalizeLocalAdjustOptions({
      effect: 'tone', temperature: 12, tint: -24, whites: -18, blacks: 16, dehaze: 22,
    })).toMatchObject({
      temperature: 12, tint: -24, whites: -18, blacks: 16, dehaze: 22,
    })
  })

  it('★ 减淡 / 加深局部层：范围参数可持久化，坏值退回中间调', async () => {
    const { normalizeLocalAdjustOptions } = await import('./local.ts')
    expect(normalizeLocalAdjustOptions({
      effect: 'dodge', effectStrength: 75, toneRange: 'shadows',
    })).toMatchObject({
      effect: 'dodge', effectStrength: 75, toneRange: 'shadows',
    })
    expect(normalizeLocalAdjustOptions({
      effect: 'burn', effectStrength: 40, toneRange: 'not-a-range',
    })).toEqual({
      effect: 'burn', effectStrength: 40, toneRange: 'midtones',
    })
  })

  it('★ 可回改局部层：一版最多 8 层；掩码不同算改过', () => {
    const one = (i: number) => ({
      kind: 'local' as const, id: `l${i}`,
      mask: `data:image/png;base64,AAAA${i}`,
      maskWidth: 100, maskHeight: 100, feather: 0,
      options: { effect: 'tone' as const, exposure: 20, contrast: 0, saturation: 0, temperature: 0 },
    })
    const many = normalizeEditLayers(Array.from({ length: 12 }, (_, i) => one(i)))
    expect(many).toHaveLength(8)

    const a = [one(1)]
    const b = [{ ...one(1), mask: 'data:image/png;base64,BBBB' }]
    expect(sameEditLayers(a, b)).toBe(false)
  })

  it('★ 图层可见性：false 保留；显隐变化算改过，缺省仍是显示', () => {
    const layers = normalizeEditLayers([
      { kind: 'text', id: 't', options: { ...DEFAULT_TEXT, text: '隐藏' }, visible: false },
      { kind: 'shape', id: 's', options: DEFAULT_SHAPE, visible: true },
    ])
    expect(layers[0]).toMatchObject({ kind: 'text', visible: false })
    expect(layers[1]).toMatchObject({ kind: 'shape' })
    expect('visible' in layers[1]!).toBe(false)

    const shown = [{ kind: 'shape' as const, id: 's', options: DEFAULT_SHAPE }]
    const hidden = [{ kind: 'shape' as const, id: 's', options: DEFAULT_SHAPE, visible: false }]
    expect(sameEditLayers(shown, hidden)).toBe(false)
  })

  it('★ 色彩范围层：取色参数跟着层走；改了也算改过', () => {
    const base = {
      kind: 'local' as const, id: 'c1',
      mask: 'data:image/png;base64,AA', maskWidth: 100, maskHeight: 100, feather: 0,
      opacity: 60,
      options: { effect: 'tone' as const, exposure: 20 },
      color: {
        target: [200, 40, 40] as const, tolerance: 30, feather: 20, invert: true, edge: 8,
      },
    }
    const [layer] = normalizeEditLayers([base])
    expect(layer).toMatchObject({
      color: { target: [200, 40, 40], tolerance: 30, feather: 20, invert: true, edge: 8 },
      opacity: 60,
    })
    const changed = [{ ...base, color: { ...base.color, tolerance: 60 } }]
    expect(sameEditLayers([base], changed)).toBe(false)
    const flipped = [{ ...base, color: { ...base.color, invert: false } }]
    expect(sameEditLayers([base], flipped)).toBe(false)
    const edged = [{ ...base, color: { ...base.color, edge: 12 } }]
    expect(sameEditLayers([base], edged)).toBe(false)
    const faded = [{ ...base, opacity: 80 }]
    expect(sameEditLayers([base], faded)).toBe(false)
  })

  it('★ 相连色彩范围：点击种子随层保存，换种子算改过', () => {
    const base = {
      kind: 'local' as const, id: 'c2',
      mask: 'data:image/png;base64,AA', maskWidth: 100, maskHeight: 100, feather: 0,
      options: { effect: 'tone' as const, exposure: 20 },
      color: {
        target: [200, 40, 40] as const, tolerance: 30, feather: 20,
        connected: true, seed: [0.25, 0.75] as const,
      },
    }
    const [layer] = normalizeEditLayers([base])
    expect(layer).toMatchObject({
      color: {
        target: [200, 40, 40], tolerance: 30, feather: 20,
        connected: true, seed: [0.25, 0.75],
      },
    })
    expect(sameEditLayers([base], [{
      ...base, color: { ...base.color, seed: [0.8, 0.2] as const },
    }])).toBe(false)
  })

  it('★ 明暗范围层：选区参数跟着层走，回来还能继续调', () => {
    const base = {
      kind: 'local' as const, id: 'l1',
      mask: 'data:image/png;base64,AA', maskWidth: 100, maskHeight: 100, feather: 0,
      options: { effect: 'tone' as const, exposure: 20 },
      luminance: {
        range: 'highlights' as const, width: 35, feather: 20, invert: true, edge: 6,
      },
    }
    const [layer] = normalizeEditLayers([base])
    expect(layer).toMatchObject({
      luminance: {
        range: 'highlights', width: 35, feather: 20, invert: true, edge: 6,
      },
    })
    expect(sameEditLayers([base], [{
      ...base,
      luminance: { ...base.luminance, width: 60 },
    }])).toBe(false)
  })
})
