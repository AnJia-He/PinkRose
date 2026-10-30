import { describe, it, expect } from 'vitest'
import { defaultSmoothRadius, smoothPixels } from './smooth.ts'

/**
 * 磨皮画笔引擎（`smoothPixels` 纯函数那一半）—— 用合成图钉住四条契约：
 *   ① 掩码外**逐字节不变**（和 `spotHeal` 同款："0 = 一个字节都不动"）；
 *   ② 掩码内**真的变糊**（噪声方差明显下降）；
 *   ③ **高反差边保得住**（黑白的直边不会被磨成一条斜坡）——
 *      这正是"磨皮"和"模糊"的分界线，没有这条，算法退化成高斯模糊也能全绿；
 *   ④ 强度 0 / 空掩码 = 恒等。
 */

/** 确定性伪随机（LCG）—— 测试里不许用 Math.random：失败要能重放。 */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 造一张 w×h 的 RGBA 图（全不透明）。 */
function makeImage(w: number, h: number, px: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const [r, g, b] = px(x, y)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return data
}

/** 掩码：中间一块（含边界软边由 stampBrush 负责；这里直接给硬边就够）。 */
function rectMask(w: number, h: number, x0: number, y0: number, x1: number, y1: number) {
  const m = new Uint8Array(w * h)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 255
  return m
}

/** 某块区域里 R 通道的标准差（"糊没糊"的度量）。 */
function stddevR(data: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0
  let sum2 = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = data[(y * w + x) * 4]!
      sum += v
      sum2 += v * v
      n++
    }
  }
  const mean = sum / n
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean))
}

function meanChannel(data: Uint8ClampedArray, channel: number): number {
  let sum = 0
  for (let i = channel; i < data.length; i += 4) sum += data[i]!
  return sum / (data.length / 4)
}

describe('defaultSmoothRadius', () => {
  it('短边 0.3%，夹在 3~24', () => {
    expect(defaultSmoothRadius(2048, 2048)).toBe(6)
    expect(defaultSmoothRadius(4000, 3000)).toBe(9)
    expect(defaultSmoothRadius(200, 200)).toBe(3)     // 下限
    expect(defaultSmoothRadius(20000, 10000)).toBe(24) // 上限
  })
})

describe('smoothPixels', () => {
  it('空掩码 = 什么都没做（covered 0、逐字节不变）', () => {
    const w = 32, h = 32
    const data = makeImage(w, h, () => [120, 80, 60])
    const before = data.slice()
    const r = smoothPixels(data, w, h, new Uint8Array(w * h))
    expect(r.covered).toBe(0)
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
  })

  it('强度 0 = 恒等（掩码里也不许动一个字节）', () => {
    const w = 32, h = 32
    const data = makeImage(w, h, (x) => [100 + (x % 7), 90, 80])
    const before = data.slice()
    const r = smoothPixels(data, w, h, rectMask(w, h, 8, 8, 24, 24), { strength: 0 })
    expect(r.covered).toBeGreaterThan(0)
    expect(Buffer.from(data)).toEqual(Buffer.from(before))
  })

  it('★ 掩码外逐字节不变、掩码内变糊（毛孔级噪声方差明显下降）', () => {
    const w = 64, h = 64
    const rand = rng(42)
    const data = makeImage(w, h, () => {
      const n = Math.round((rand() - 0.5) * 24) // ±12 的颗粒（近似皮肤纹理）
      return [200 + n, 150 + n, 130 + n]
    })
    const before = data.slice()
    const mask = rectMask(w, h, 16, 16, 48, 48)
    const r = smoothPixels(data, w, h, mask, { strength: 100, radius: 3 })
    expect(r.covered).toBe(32 * 32)

    // ① 掩码外一个字节都不许动
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x >= 16 && x < 48 && y >= 16 && y < 48) continue
        const i = (y * w + x) * 4
        expect(data[i]).toBe(before[i])
        expect(data[i + 1]).toBe(before[i + 1])
        expect(data[i + 2]).toBe(before[i + 2])
      }
    }

    // ② 掩码中心（离边界 ≥ 半径，不受软过渡影响）方差明显下降
    const sBefore = stddevR(before, w, 22, 22, 42, 42)
    const sAfter = stddevR(data, w, 22, 22, 42, 42)
    expect(sBefore).toBeGreaterThan(3)              // 哨兵：输入真的带颗粒
    expect(sAfter).toBeLessThan(sBefore * 0.55)     // 磨掉了
  })

  it('★ 高反差边保得住：黑白直边两侧的深处仍是原值（不是高斯模糊）', () => {
    const w = 64, h = 64
    const data = makeImage(w, h, (x) => (x < 32 ? [60, 60, 60] : [200, 200, 200]))
    smoothPixels(data, w, h, rectMask(w, h, 0, 0, 64, 64), { strength: 100, radius: 4 })
    // 离边 ≥ 半径的两侧深处：基本保持原样（留 6 个灰度容差给数值误差）
    for (const x of [4, 12, 25]) {
      const v = data[(32 * w + x) * 4]!
      expect(Math.abs(v - 60), `x=${x} 被磨成了 ${v}`).toBeLessThanOrEqual(6)
    }
    for (const x of [39, 52, 60]) {
      const v = data[(32 * w + x) * 4]!
      expect(Math.abs(v - 200), `x=${x} 被磨成了 ${v}`).toBeLessThanOrEqual(6)
    }
  })

  it('★ 导向亮度只负责结构：磨完三通道均值都不漂（不整体提亮 / 偏色）', () => {
    const w = 64, h = 64
    const rand = rng(99)
    const data = makeImage(w, h, () => {
      const n = Math.round((rand() - 0.5) * 70) // 高反差颗粒，局部方差接近 EPS
      return [190 + n, 145 + n, 125 + n]
    })
    const before = [meanChannel(data, 0), meanChannel(data, 1), meanChannel(data, 2)]
    smoothPixels(data, w, h, new Uint8Array(w * h).fill(255), { strength: 100, radius: 3 })
    const after = [meanChannel(data, 0), meanChannel(data, 1), meanChannel(data, 2)]
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(after[c]! - before[c]!), `通道 ${c} 均值漂了`).toBeLessThan(1.5)
    }
  })

  it('软边掩码按覆盖率混合（128 = 磨一半）', () => {
    const w = 32, h = 32
    const rand = rng(7)
    const data = makeImage(w, h, () => {
      const n = Math.round((rand() - 0.5) * 24)
      return [180 + n, 140 + n, 120 + n]
    })
    const half = new Uint8Array(w * h).fill(128)
    const r = smoothPixels(data, w, h, half, { strength: 100, radius: 3 })
    expect(r.covered).toBe(w * h)
    // 覆盖率 128 只是"记账的像素数"口径 —— 外接框覆盖全图，照常算
    // （这里只钉它不抛、不把 alpha 弄坏）
    expect(data[3]).toBe(255)
  })

  it('★ 纹理：0 最平、60 保留一部分、100 = 原样（逐字节不动）', () => {
    const w = 64, h = 64
    const rand = rng(11)
    const original = makeImage(w, h, () => {
      const n = Math.round((rand() - 0.5) * 24)
      return [200 + n, 150 + n, 130 + n]
    })
    const mask = rectMask(w, h, 16, 16, 48, 48)
    const flat = original.slice()
    const kept = original.slice()
    const intact = original.slice()

    smoothPixels(flat, w, h, mask, { strength: 100, radius: 3, texture: 0 })
    smoothPixels(kept, w, h, mask, { strength: 100, radius: 3, texture: 60 })
    smoothPixels(intact, w, h, mask, { strength: 100, radius: 3, texture: 100 })

    const sOrig = stddevR(original, w, 22, 22, 42, 42)
    const sFlat = stddevR(flat, w, 22, 22, 42, 42)
    const sKept = stddevR(kept, w, 22, 22, 42, 42)
    expect(sFlat).toBeLessThan(sKept)
    expect(sKept).toBeLessThan(sOrig)
    expect(Buffer.from(intact), '纹理 100 就是恒等').toEqual(Buffer.from(original))
  })

  it('掩码尺寸对不上 → 抛（别静默磨错地方）', () => {
    const data = makeImage(16, 16, () => [0, 0, 0])
    expect(() => smoothPixels(data, 16, 16, new Uint8Array(10))).toThrow(/掩码尺寸/)
  })
})
