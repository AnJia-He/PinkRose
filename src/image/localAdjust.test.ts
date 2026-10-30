import { describe, it, expect } from 'vitest'
import { localAdjustPixels } from './localAdjust.ts'

function image(w: number, h: number, rgb: [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0]
    data[i * 4 + 1] = rgb[1]
    data[i * 4 + 2] = rgb[2]
    data[i * 4 + 3] = 255
  }
  return data
}

function rectMask(w: number, h: number, x0: number, y0: number, x1: number, y1: number) {
  const m = new Uint8Array(w * h)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 255
  return m
}

const px = (data: Uint8ClampedArray, w: number, x: number, y: number) => {
  const i = (y * w + x) * 4
  return [data[i]!, data[i + 1]!, data[i + 2]!] as const
}

describe('localAdjustPixels', () => {
  it('空掩码 / 全零调整 = 一个字节都不动', () => {
    const w = 32, h = 32
    const data = image(w, h, [100, 120, 140])
    const before = data.slice()
    expect(localAdjustPixels(data, w, h, new Uint8Array(w * h), { exposure: 80 }).covered).toBe(0)
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
    expect(localAdjustPixels(data, w, h, rectMask(w, h, 8, 8, 24, 24), {}).covered).toBe(16 * 16)
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
  })

  it('★ 掩码外逐字节不变、掩码内按覆盖率混合', () => {
    const w = 32, h = 32
    const data = image(w, h, [100, 120, 140])
    const before = data.slice()
    const mask = rectMask(w, h, 8, 8, 24, 24)
    localAdjustPixels(data, w, h, mask, { exposure: 100 })
    // 外面
    expect(px(data, w, 0, 0)).toEqual(px(before, w, 0, 0))
    // 里面亮了
    expect(px(data, w, 16, 16)[0]).toBeGreaterThan(px(before, w, 16, 16)[0] + 10)
    // alpha 不动
    expect(data[((16 * w) + 16) * 4 + 3]).toBe(255)
  })

  it('饱和度 -100 把彩色变灰', () => {
    const w = 32, h = 32
    const data = image(w, h, [200, 80, 40])
    localAdjustPixels(data, w, h, rectMask(w, h, 8, 8, 24, 24), { saturation: -100 })
    const [r, g, b] = px(data, w, 16, 16)
    expect(Math.abs(r - g)).toBeLessThanOrEqual(2)
    expect(Math.abs(g - b)).toBeLessThanOrEqual(2)
  })

  it('色温 +100 抬红压蓝', () => {
    const w = 32, h = 32
    const data = image(w, h, [120, 120, 120])
    localAdjustPixels(data, w, h, rectMask(w, h, 8, 8, 24, 24), { temperature: 100 })
    const [r, , b] = px(data, w, 16, 16)
    expect(r).toBeGreaterThan(120)
    expect(b).toBeLessThan(120)
  })

  it('局部色调 +100 偏洋红，-100 偏绿，掩码外不动', () => {
    const w = 32, h = 32
    const data = image(w, h, [120, 120, 120])
    const before = data.slice()
    const mask = rectMask(w, h, 8, 8, 24, 24)
    localAdjustPixels(data, w, h, mask, { tint: 100 })
    expect(px(data, w, 16, 16)[1]).toBeLessThan(120)
    expect(px(data, w, 0, 0)).toEqual(px(before, w, 0, 0))

    const green = before.slice()
    localAdjustPixels(green, w, h, mask, { tint: -100 })
    expect(px(green, w, 16, 16)[1]).toBeGreaterThan(120)
  })

  it('★ 局部高光 / 阴影：压高光不动暗部，提阴影不动亮部', () => {
    const w = 2, h = 1
    const data = new Uint8ClampedArray(8)
    data.set([30, 30, 30, 255, 230, 230, 230, 255])
    const mask = new Uint8Array([255, 255])

    const high = data.slice()
    localAdjustPixels(high, w, h, mask, { effect: 'tone', highlights: -100 })
    expect(px(high, w, 1, 0)[0]).toBeLessThan(220)
    expect(px(high, w, 0, 0)[0]).toBeGreaterThanOrEqual(25)

    const shadow = data.slice()
    localAdjustPixels(shadow, w, h, mask, { effect: 'tone', shadows: 100 })
    expect(px(shadow, w, 0, 0)[0]).toBeGreaterThan(35)
    expect(px(shadow, w, 1, 0)[0]).toBeLessThanOrEqual(235)
  })

  it('★ 局部白色 / 黑色色阶：只动对应端点，掩码外不变', () => {
    const w = 3, h = 1
    const data = new Uint8ClampedArray(12)
    data.set([
      20, 20, 20, 255,
      60, 60, 60, 255,
      230, 230, 230, 255,
    ])
    const before = data.slice()
    const mask = new Uint8Array([0, 255, 255])

    const white = data.slice()
    localAdjustPixels(white, w, h, mask, { whites: -100 })
    expect(px(white, w, 2, 0)[0]).toBeLessThan(220)
    expect(px(white, w, 1, 0)[0]).toBeGreaterThan(50)
    expect(px(white, w, 0, 0)).toEqual(px(before, w, 0, 0))

    const black = before.slice()
    localAdjustPixels(black, w, h, mask, { blacks: 100 })
    expect(px(black, w, 1, 0)[0]).toBeGreaterThan(65)
    expect(px(black, w, 2, 0)[0]).toBeLessThan(240)
    expect(px(black, w, 0, 0)).toEqual(px(before, w, 0, 0))
  })

  it('★ 局部去雾：正数拉开灰雾、负数加冷雾，掩码外不变', () => {
    const w = 5, h = 5
    const data = image(w, h, [200, 200, 200])
    const before = data.slice()
    const mask = new Uint8Array(w * h)
    mask[2 * w + 2] = 255

    const cleared = data.slice()
    localAdjustPixels(cleared, w, h, mask, { dehaze: 100 })
    expect(px(cleared, w, 2, 2)[0]).toBeGreaterThan(210)
    expect(px(cleared, w, 0, 0)).toEqual(px(before, w, 0, 0))

    const fogged = before.slice()
    localAdjustPixels(fogged, w, h, mask, { dehaze: -100 })
    const [r, , b] = px(fogged, w, 2, 2)
    expect(b).toBeGreaterThan(r)
    expect(px(fogged, w, 0, 0)).toEqual(px(before, w, 0, 0))
  })

  it('★ 减淡：中间调提亮但保留色彩关系，掩码外和强度 0 不动', () => {
    const w = 32, h = 32
    const data = image(w, h, [90, 120, 70])
    const before = data.slice()
    const mask = rectMask(w, h, 8, 8, 24, 24)
    localAdjustPixels(data, w, h, mask, {
      effect: 'dodge', effectStrength: 100, toneRange: 'midtones',
    })

    const [r, g, b] = px(data, w, 16, 16)
    const [br, bg, bb] = px(before, w, 16, 16)
    expect(r).toBeGreaterThan(br + 8)
    expect(g).toBeGreaterThan(bg + 8)
    expect(b).toBeGreaterThan(bb + 5)
    expect(g).toBeGreaterThan(r)
    expect(r).toBeGreaterThan(b)
    expect(px(data, w, 0, 0), '掩码外一个字节不动').toEqual(px(before, w, 0, 0))

    const zero = before.slice()
    localAdjustPixels(zero, w, h, mask, {
      effect: 'dodge', effectStrength: 0, toneRange: 'midtones',
    })
    expect(Buffer.from(zero)).toEqual(Buffer.from(before))
  })

  it('★ 加深：中间调压暗但保留色彩关系，掩码外不动', () => {
    const w = 32, h = 32
    const data = image(w, h, [170, 205, 145])
    const before = data.slice()
    const mask = rectMask(w, h, 8, 8, 24, 24)
    localAdjustPixels(data, w, h, mask, {
      effect: 'burn', effectStrength: 100, toneRange: 'midtones',
    })

    const [r, g, b] = px(data, w, 16, 16)
    const [br, bg, bb] = px(before, w, 16, 16)
    expect(r).toBeLessThan(br - 8)
    expect(g).toBeLessThan(bg - 8)
    expect(b).toBeLessThan(bb - 5)
    expect(g).toBeGreaterThan(r)
    expect(r).toBeGreaterThan(b)
    expect(px(data, w, 0, 0), '掩码外一个字节不动').toEqual(px(before, w, 0, 0))
  })

  it('★ 减淡 / 加深按亮度范围生效：阴影模式基本不动高光，高光模式基本不动阴影', () => {
    const w = 3, h = 1
    const data = new Uint8ClampedArray(12)
    data.set([
      30, 30, 30, 255,
      120, 120, 120, 255,
      230, 230, 230, 255,
    ])
    const mask = new Uint8Array([255, 255, 255])

    const dodgeShadows = data.slice()
    localAdjustPixels(dodgeShadows, w, h, mask, {
      effect: 'dodge', effectStrength: 100, toneRange: 'shadows',
    })
    expect(px(dodgeShadows, w, 0, 0)[0]).toBeGreaterThan(38)
    expect(px(dodgeShadows, w, 2, 0)[0]).toBeLessThanOrEqual(231)

    const burnHighlights = data.slice()
    localAdjustPixels(burnHighlights, w, h, mask, {
      effect: 'burn', effectStrength: 100, toneRange: 'highlights',
    })
    expect(px(burnHighlights, w, 2, 0)[0]).toBeLessThan(222)
    expect(px(burnHighlights, w, 0, 0)[0]).toBeGreaterThanOrEqual(29)
  })

  it('★ 纯黑像素：减淡能提亮，加深绝不能反过来提亮', () => {
    const w = 4, h = 1
    const data = new Uint8ClampedArray(w * 4)
    for (let x = 0; x < w; x++) data.set([0, 0, 0, 255], x * 4)
    const mask = new Uint8Array(w).fill(255)

    const dodged = data.slice()
    localAdjustPixels(dodged, w, h, mask, {
      effect: 'dodge', effectStrength: 100, toneRange: 'shadows',
    })
    expect(px(dodged, w, 1, 0)[0]).toBeGreaterThan(10)

    const burned = data.slice()
    localAdjustPixels(burned, w, h, mask, {
      effect: 'burn', effectStrength: 100, toneRange: 'shadows',
    })
    expect(px(burned, w, 1, 0)).toEqual([0, 0, 0])
  })

  it('★ 自然饱和度：灰一点的颜色抬得更多，已经很艳的颜色少动', () => {
    const w = 2, h = 1
    const data = new Uint8ClampedArray(8)
    data.set([120, 100, 95, 255, 250, 10, 10, 255])
    const mask = new Uint8Array([255, 255])
    const chroma = (v: readonly [number, number, number]) =>
      Math.max(...v) - Math.min(...v)

    const beforeMuted = chroma(px(data, w, 0, 0))
    const beforeVivid = chroma(px(data, w, 1, 0))
    localAdjustPixels(data, w, h, mask, { effect: 'tone', vibrance: 100 })
    const mutedGain = chroma(px(data, w, 0, 0)) - beforeMuted
    const vividGain = chroma(px(data, w, 1, 0)) - beforeVivid
    expect(mutedGain).toBeGreaterThan(4)
    expect(mutedGain).toBeGreaterThan(vividGain + 2)
  })

  it('★ 局部清晰度：边缘两侧对比拉开，平坦处和掩码外不动', () => {
    const w = 21, h = 1
    const data = new Uint8ClampedArray(w * 4)
    for (let x = 0; x < w; x++) {
      const v = x < 10 ? 80 : 180
      data.set([v, v, v, 255], x * 4)
    }
    const before = data.slice()
    const mask = new Uint8Array(w)
    for (let x = 7; x < 15; x++) mask[x] = 255
    localAdjustPixels(data, w, h, mask, { effect: 'tone', clarity: 100 })
    expect(px(data, w, 10, 0)[0]).toBeGreaterThan(px(before, w, 10, 0)[0])
    expect(px(data, w, 9, 0)[0]).toBeLessThan(px(before, w, 9, 0)[0])
    expect(px(data, w, 0, 0)).toEqual(px(before, w, 0, 0))
  })

  it('软边 128 = 大约一半效果', () => {
    const w = 32, h = 32
    const full = image(w, h, [100, 100, 100])
    const half = full.slice()
    const mask = new Uint8Array(w * h)
    for (let i = 0; i < mask.length; i++) mask[i] = 128
    localAdjustPixels(full, w, h, mask, { exposure: 100 })
    localAdjustPixels(half, w, h, mask, { exposure: 50 })
    // 同一个 128 覆盖率下，强度 100 比 50 更亮
    expect(px(full, w, 16, 16)[0]).toBeGreaterThan(px(half, w, 16, 16)[0])
    expect(px(full, w, 16, 16)[0]).toBeGreaterThan(100)
  })

  it('★ 牙齿模式：黄牙去黄提亮，掩码外不动', () => {
    const w = 32, h = 32
    const data = image(w, h, [200, 200, 120])
    const before = data.slice()
    localAdjustPixels(data, w, h, rectMask(w, h, 8, 8, 24, 24), {
      effect: 'teeth', effectStrength: 100,
    })
    expect(px(data, w, 0, 0)).toEqual(px(before, w, 0, 0))
    const [r, g, b] = px(data, w, 16, 16)
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    expect(b).toBeGreaterThan(120)
    expect(luma).toBeGreaterThan(193)
  })

  it('★ 亮眼模式：亮暗分离拉大（眼白更亮、暗部更深）', () => {
    const w = 32, h = 32
    const data = image(w, h, [60, 60, 60])
    for (let y = 0; y < h; y++) {
      for (let x = 16; x < w; x++) {
        const i = (y * w + x) * 4
        data[i] = 200; data[i + 1] = 200; data[i + 2] = 200
      }
    }
    const beforeDark = px(data, w, 4, 16)[0]
    const beforeBright = px(data, w, 28, 16)[0]
    localAdjustPixels(data, w, h, new Uint8Array(w * h).fill(255), {
      effect: 'eyes', effectStrength: 100,
    })
    const afterDark = px(data, w, 4, 16)[0]
    const afterBright = px(data, w, 28, 16)[0]
    expect(afterBright - afterDark).toBeGreaterThan(beforeBright - beforeDark)
  })

  it('★ 红眼模式：只压红色瞳孔，掩码内的中性灰和掩码外都不动', () => {
    const w = 32, h = 32
    const data = image(w, h, [120, 120, 120])
    for (let y = 10; y < 22; y++) {
      for (let x = 10; x < 18; x++) {
        const i = (y * w + x) * 4
        data[i] = 240; data[i + 1] = 40; data[i + 2] = 40
      }
    }
    const before = data.slice()
    const mask = rectMask(w, h, 8, 8, 24, 24)
    localAdjustPixels(data, w, h, mask, { effect: 'redeye', effectStrength: 100 })

    const pupil = px(data, w, 14, 16)
    expect(pupil[0]).toBeLessThanOrEqual(41)
    expect(pupil[1]).toBe(40)
    expect(pupil[2]).toBe(40)
    expect(px(data, w, 20, 16), '掩码里的中性灰一个字节不动').toEqual([120, 120, 120])
    expect(px(data, w, 0, 0), '掩码外一个字节不动').toEqual(px(before, w, 0, 0))
  })

  it('★ 发色模式：掩码内换色、明暗结构保留，掩码外一个字节不动', () => {
    const w = 32, h = 32
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        // 左半是深棕头发，右半是肤色背景。
        data[i] = x < 16 ? 52 : 206
        data[i + 1] = x < 16 ? 38 : 170
        data[i + 2] = x < 16 ? 30 : 148
        data[i + 3] = 255
      }
    }
    const before = data.slice()
    localAdjustPixels(data, w, h, rectMask(w, h, 0, 0, 16, 32), {
      effect: 'hair', effectStrength: 100, hairShade: 'wine',
    })
    expect(px(data, w, 20, 16), '掩码外一个字节不动').toEqual(px(before, w, 20, 16))
    const [r, g, b] = px(data, w, 8, 16)
    expect(r).toBeGreaterThan(g + 10)
    expect(r).toBeGreaterThan(b + 10)
    const l0 = 0.2126 * 52 + 0.7152 * 38 + 0.0722 * 30
    const l1 = 0.2126 * r + 0.7152 * g + 0.0722 * b
    expect(Math.abs(l1 - l0)).toBeLessThan(12)
  })

  it('★ 发色强度 0 = 一个字节都不动', () => {
    const w = 32, h = 32
    const data = image(w, h, [52, 38, 30])
    const before = data.slice()
    localAdjustPixels(data, w, h, rectMask(w, h, 8, 8, 24, 24), {
      effect: 'hair', effectStrength: 0, hairShade: 'blue',
    })
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
  })

  it('★ 眼影模式：掩码内偏粉、掩码外不动，强度 0 恒等', () => {
    const w = 32, h = 32
    const data = image(w, h, [190, 170, 160])
    const before = data.slice()
    localAdjustPixels(data, w, h, rectMask(w, h, 8, 8, 24, 24), {
      effect: 'eyeshadow', effectStrength: 100, eyeShadowShade: 'rose',
    })
    expect(px(data, w, 0, 0)).toEqual(px(before, w, 0, 0))
    const [r, g, b] = px(data, w, 16, 16)
    expect(r).toBeGreaterThan(g + 5)
    expect(r).toBeGreaterThan(b + 5)

    const zero = image(w, h, [190, 170, 160])
    const keep = zero.slice()
    localAdjustPixels(zero, w, h, rectMask(w, h, 8, 8, 24, 24), {
      effect: 'eyeshadow', effectStrength: 0, eyeShadowShade: 'violet',
    })
    expect(Buffer.from(zero)).toEqual(Buffer.from(keep))
  })

  it('★ 眉毛模式：深棕 / 红棕换色、掩码外不动，强度 0 恒等', () => {
    const w = 32, h = 32
    const brow = () => image(w, h, [75, 52, 40])
    const mask = rectMask(w, h, 8, 8, 24, 24)

    const brown = brow()
    const untouched = brown.slice()
    localAdjustPixels(brown, w, h, mask, {
      effect: 'eyebrow', effectStrength: 100, eyebrowShade: 'brown',
    })
    expect(px(brown, w, 0, 0), '掩码外一个字节不动').toEqual(px(untouched, w, 0, 0))

    const auburn = brow()
    localAdjustPixels(auburn, w, h, mask, {
      effect: 'eyebrow', effectStrength: 100, eyebrowShade: 'auburn',
    })
    const brownPx = px(brown, w, 16, 16)
    const auburnPx = px(auburn, w, 16, 16)
    expect(auburnPx).not.toEqual(brownPx)
    expect(auburnPx[0] - auburnPx[1]).toBeGreaterThan(27)

    const zero = brow()
    const keep = zero.slice()
    localAdjustPixels(zero, w, h, mask, {
      effect: 'eyebrow', effectStrength: 0, eyebrowShade: 'black',
    })
    expect(Buffer.from(zero)).toEqual(Buffer.from(keep))
  })

  it('★ 祛皱模式：掩码内细纹反差下降、亮度略升，掩码外不动', () => {
    const w = 32, h = 32
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const bright = x % 2 === 0 ? 145 : 75
        data[i] = bright
        data[i + 1] = Math.round(bright * 0.86)
        data[i + 2] = Math.round(bright * 0.76)
        data[i + 3] = 255
      }
    }
    const before = data.slice()
    const mask = rectMask(w, h, 8, 8, 24, 24)
    const luma = (d: Uint8ClampedArray, x: number, y: number) => {
      const [r, g, b] = px(d, w, x, y)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const spread = (d: Uint8ClampedArray) =>
      Math.abs(luma(d, 16, 16) - luma(d, 17, 16))

    localAdjustPixels(data, w, h, mask, { effect: 'wrinkle', effectStrength: 100 })

    expect(px(data, w, 0, 0)).toEqual(px(before, w, 0, 0))
    expect(spread(data)).toBeLessThan(spread(before))
    expect(luma(data, 16, 16) + luma(data, 17, 16))
      .toBeGreaterThan(luma(before, 16, 16) + luma(before, 17, 16))

    const zero = before.slice()
    localAdjustPixels(zero, w, h, mask, { effect: 'wrinkle', effectStrength: 0 })
    expect(Buffer.from(zero)).toEqual(Buffer.from(before))
  })

  it('★ 黑眼圈模式：比周围暗的眼下阴影提亮、蓝紫偏色收回，掩码外不动', () => {
    const w = 64, h = 64
    const data = image(w, h, [200, 165, 145])
    // 中间一块偏暗、偏蓝紫的眼下阴影，周围是正常肤色。
    for (let y = 24; y < 40; y++) {
      for (let x = 20; x < 44; x++) {
        const i = (y * w + x) * 4
        data[i] = 120; data[i + 1] = 105; data[i + 2] = 140
      }
    }
    const before = data.slice()
    const mask = rectMask(w, h, 12, 18, 52, 46)
    const luma = (d: Uint8ClampedArray, x: number, y: number) => {
      const [r, g, b] = px(d, w, x, y)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const beforeL = luma(before, 32, 32)
    const beforeCast = px(before, w, 32, 32)[2]
      - (px(before, w, 32, 32)[0] + px(before, w, 32, 32)[1]) / 2

    localAdjustPixels(data, w, h, mask, { effect: 'darkcircle', effectStrength: 100 })

    const after = px(data, w, 32, 32)
    const afterL = luma(data, 32, 32)
    const afterCast = after[2] - (after[0] + after[1]) / 2
    expect(px(data, w, 0, 0), '掩码外一个字节不动').toEqual(px(before, w, 0, 0))
    expect(afterL).toBeGreaterThan(beforeL + 8)
    expect(afterCast).toBeLessThan(beforeCast)
    // 没有明显暗沉的地方（正常肤色）不动：不是整块美白。
    expect(px(data, w, 14, 43), '正常肤色保持').toEqual(px(before, w, 14, 43))

    const zero = before.slice()
    localAdjustPixels(zero, w, h, mask, { effect: 'darkcircle', effectStrength: 0 })
    expect(Buffer.from(zero)).toEqual(Buffer.from(before))
  })

  it('★ 修容模式：掩码内压暗、保留纹理，掩码外和强度 0 不动', () => {
    const w = 32, h = 32
    const data = image(w, h, [190, 160, 140])
    const before = data.slice()
    const mask = rectMask(w, h, 8, 8, 24, 24)
    const luma = (d: Uint8ClampedArray, x: number, y: number) => {
      const [r, g, b] = px(d, w, x, y)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    localAdjustPixels(data, w, h, mask, {
      effect: 'contour', effectStrength: 100, contourShade: 'cool',
    })
    expect(luma(data, 16, 16)).toBeLessThan(luma(before, 16, 16) - 8)
    expect(px(data, w, 0, 0), '掩码外不动').toEqual(px(before, w, 0, 0))

    const zero = before.slice()
    localAdjustPixels(zero, w, h, mask, {
      effect: 'contour', effectStrength: 0, contourShade: 'warm',
    })
    expect(Buffer.from(zero)).toEqual(Buffer.from(before))
  })

  it('★ 高光模式：掩码内提亮并偏暖，接近纯白不继续堆，强度 0 不动', () => {
    const w = 32, h = 32
    const data = image(w, h, [150, 120, 110])
    const before = data.slice()
    const mask = rectMask(w, h, 8, 8, 24, 24)
    const luma = (d: Uint8ClampedArray, x: number, y: number) => {
      const [r, g, b] = px(d, w, x, y)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    localAdjustPixels(data, w, h, mask, {
      effect: 'highlight', effectStrength: 100, highlightShade: 'champagne',
    })
    const [r, , b] = px(data, w, 16, 16)
    expect(luma(data, 16, 16)).toBeGreaterThan(luma(before, 16, 16) + 8)
    expect(r).toBeGreaterThan(b)
    expect(px(data, w, 0, 0), '掩码外不动').toEqual(px(before, w, 0, 0))

    const zero = before.slice()
    localAdjustPixels(zero, w, h, mask, {
      effect: 'highlight', effectStrength: 0, highlightShade: 'peach',
    })
    expect(Buffer.from(zero)).toEqual(Buffer.from(before))
  })

  it('★ 卧蚕模式：眼下窄条柔和提亮、带一点暖色，掩码外不动', () => {
    const w = 32, h = 32
    const data = image(w, h, [176, 150, 138])
    const before = data.slice()
    const mask = rectMask(w, h, 8, 8, 24, 12)
    const luma = (d: Uint8ClampedArray, x: number, y: number) => {
      const [r, g, b] = px(d, w, x, y)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    localAdjustPixels(data, w, h, mask, {
      effect: 'aegyoSal', effectStrength: 100, aegyoSalShade: 'champagne',
    })
    const after = px(data, w, 16, 10)
    expect(luma(data, 16, 10)).toBeGreaterThan(luma(before, 16, 10) + 8)
    expect(after[0]).toBeGreaterThan(after[2])
    expect(px(data, w, 16, 0), '掩码外不动').toEqual(px(before, w, 16, 0))
    expect(data[((10 * w) + 16) * 4 + 3], 'alpha 不动').toBe(255)

    const zero = before.slice()
    localAdjustPixels(zero, w, h, mask, {
      effect: 'aegyoSal', effectStrength: 0, aegyoSalShade: 'peach',
    })
    expect(Buffer.from(zero)).toEqual(Buffer.from(before))
  })

  it('★ 眼线模式：沿涂抹区域压暗、不同色号结果不同，强度 0 不动', () => {
    const w = 32, h = 32
    const data = image(w, h, [190, 160, 140])
    const before = data.slice()
    const mask = rectMask(w, h, 8, 8, 24, 12)
    const luma = (d: Uint8ClampedArray, x: number, y: number) => {
      const [r, g, b] = px(d, w, x, y)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    localAdjustPixels(data, w, h, mask, {
      effect: 'eyeliner', effectStrength: 100, eyelinerShade: 'black',
    })
    expect(luma(data, 16, 10)).toBeLessThan(luma(before, 16, 10) - 35)
    expect(px(data, w, 16, 0), '掩码外不动').toEqual(px(before, w, 16, 0))

    const brown = before.slice()
    localAdjustPixels(brown, w, h, mask, {
      effect: 'eyeliner', effectStrength: 100, eyelinerShade: 'brown',
    })
    expect(px(brown, w, 16, 10)).not.toEqual(px(data, w, 16, 10))

    const zero = before.slice()
    localAdjustPixels(zero, w, h, mask, {
      effect: 'eyeliner', effectStrength: 0, eyelinerShade: 'charcoal',
    })
    expect(Buffer.from(zero)).toEqual(Buffer.from(before))
  })

  it('★ 美瞳模式：只染虹膜，眼白和瞳孔不动，强度 0 恒等', () => {
    const w = 32, h = 32
    const data = image(w, h, [200, 170, 150])
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) {
        const i = (y * w + x) * 4
        data[i] = 90; data[i + 1] = 100; data[i + 2] = 70
      }
    }
    // 眼白与瞳孔放在虹膜区域里，验证颜色门会把它们挡在外面。
    for (let y = 12; y < 16; y++) {
      for (let x = 12; x < 16; x++) {
        const i = (y * w + x) * 4
        data[i] = 246; data[i + 1] = 246; data[i + 2] = 246
      }
    }
    for (let y = 18; y < 21; y++) {
      for (let x = 18; x < 21; x++) {
        const i = (y * w + x) * 4
        data[i] = 8; data[i + 1] = 8; data[i + 2] = 8
      }
    }
    const before = data.slice()
    const mask = rectMask(w, h, 8, 8, 24, 24)
    localAdjustPixels(data, w, h, mask, {
      effect: 'iris', effectStrength: 100, irisShade: 'blue',
    })
    const iris = px(data, w, 10, 10)
    expect(iris[2]).toBeGreaterThan(iris[0] + 8)
    expect(px(data, w, 14, 14), '眼白不动').toEqual(px(before, w, 14, 14))
    expect(px(data, w, 19, 19), '瞳孔不动').toEqual(px(before, w, 19, 19))
    expect(px(data, w, 0, 0), '掩码外不动').toEqual(px(before, w, 0, 0))

    const zero = before.slice()
    localAdjustPixels(zero, w, h, mask, {
      effect: 'iris', effectStrength: 0, irisShade: 'violet',
    })
    expect(Buffer.from(zero)).toEqual(Buffer.from(before))
  })

  it('★ 去反光模式：只压涂选区域的高光，暗部与掩码外不动', () => {
    const w = 32, h = 32
    const data = image(w, h, [245, 232, 218])
    for (let y = 8; y < 16; y++) {
      for (let x = 8; x < 16; x++) {
        const i = (y * w + x) * 4
        data[i] = 70; data[i + 1] = 62; data[i + 2] = 54
      }
    }
    const before = data.slice()
    const mask = rectMask(w, h, 8, 8, 24, 24)
    localAdjustPixels(data, w, h, mask, { effect: 'antiglare', effectStrength: 100 })

    const luma = (d: Uint8ClampedArray, x: number, y: number) => {
      const [r, g, b] = px(d, w, x, y)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    expect(luma(data, 20, 20)).toBeLessThan(luma(before, 20, 20) - 5)
    expect(px(data, w, 12, 12), '暗部不动').toEqual(px(before, w, 12, 12))
    expect(px(data, w, 0, 0), '掩码外不动').toEqual(px(before, w, 0, 0))

    const zero = before.slice()
    localAdjustPixels(zero, w, h, mask, { effect: 'antiglare', effectStrength: 0 })
    expect(Buffer.from(zero)).toEqual(Buffer.from(before))
  })

  it('掩码尺寸对不上 → 抛', () => {
    const data = image(16, 16, [0, 0, 0])
    expect(() => localAdjustPixels(data, 16, 16, new Uint8Array(10), { exposure: 20 })).toThrow(/掩码尺寸/)
  })
})
