import { describe, expect, it } from 'vitest'
import {
  MAX_STRAIGHTEN, clampRect, cropOutputSize, effectiveAngle, fitAspect, inscribedRect, nextCropGuide,
  rectFromSize, rotatedBounds, type CropSpec,
} from './crop'

const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol)

/**
 * 把矩形四角（相对照片中心）**转回原图坐标系**，检查是否都还在 ±w/2 × ±h/2 之内。
 * 这是"不碰空角"那句承诺的直接验证 —— 角戳出去就说明裁进了空白区。
 */
const cornersInside = (
  size: { w: number; h: number }, imgW: number, imgH: number, angleDeg: number,
) => {
  const c = Math.cos((angleDeg * Math.PI) / 180)
  const s = Math.sin((angleDeg * Math.PI) / 180)
  for (const cx of [-size.w / 2, size.w / 2]) {
    for (const cy of [-size.h / 2, size.h / 2]) {
      const bx = cx * c + cy * s
      const by = -cx * s + cy * c
      expect(Math.abs(bx)).toBeLessThanOrEqual(imgW / 2 + 1e-6)
      expect(Math.abs(by)).toBeLessThanOrEqual(imgH / 2 + 1e-6)
    }
  }
}

describe('nextCropGuide', () => {
  it('按 关 → 三分 → 黄金分割 → 对角线 循环', () => {
    expect(nextCropGuide('off')).toBe('thirds')
    expect(nextCropGuide('thirds')).toBe('golden')
    expect(nextCropGuide('golden')).toBe('diagonal')
    expect(nextCropGuide('diagonal')).toBe('off')
  })
})

describe('rotatedBounds —— 转过来之后占多大一块', () => {
  it('不转就是原来那块', () => {
    expect(rotatedBounds(1000, 500, 0)).toEqual({ w: 1000, h: 500 })
  })
  it('90 度：长宽对调（不会多出空白角）', () => {
    expect(rotatedBounds(1000, 500, 90)).toEqual({ w: 500, h: 1000 })
  })
  it('15 度：两头都长大', () => {
    const b = rotatedBounds(1000, 500, 15)
    expect(b.w).toBeGreaterThan(1000)
    expect(b.h).toBeGreaterThan(500)
  })
})

describe('inscribedRect —— 转完之后，不露空角的最大矩形', () => {
  it('★ 不转 = 整张（归一化就是 1×1）', () => {
    const b = rotatedBounds(1000, 500, 0)
    const r = inscribedRect(1000, 500, 0)
    close(r.w / b.w, 1); close(r.h / b.h, 1)
  })
  it('★ 90 度也是整张（转直角不会露角）', () => {
    const b = rotatedBounds(1000, 500, 90)
    const r = inscribedRect(1000, 500, 90)
    close(r.w / b.w, 1); close(r.h / b.h, 1)
  })
  it('★ 转 1 度就要缩一点；转 15 度缩得更多（单调）', () => {
    const a1 = inscribedRect(1000, 500, 1)
    const a15 = inscribedRect(1000, 500, 15)
    expect(a1.w).toBeLessThan(1000)
    expect(a15.w).toBeLessThan(a1.w)
  })
  it('★ 内接矩形不许超过原图（面积意义上：它就是"能留下的最大一块"）', () => {
    for (const deg of [1, 5, 15, -15, -7.5]) {
      const r = inscribedRect(1000, 500, deg)
      expect(r.w * r.h).toBeLessThanOrEqual(1000 * 500 + 1e-6)
      expect(r.w).toBeGreaterThan(0); expect(r.h).toBeGreaterThan(0)
    }
  })
})

describe('inscribedRect —— 竖图不许把宽高转置（★ 评审抓的 Critical）', () => {
  it('★ 竖图不转 = 整张照片本身（800×1200，不是 1200×800）', () => {
    expect(inscribedRect(800, 1200, 0)).toEqual({ w: 800, h: 1200 })
  })
  it('★ 竖图转 15° = 533.65×1099.34，四角都还在照片里（不许戳出去）', () => {
    const r = inscribedRect(800, 1200, 15)
    close(r.w, 533.654, 1e-3); close(r.h, 1099.339, 1e-3)
    cornersInside(r, 800, 1200, 15)
  })
})

describe('inscribedRect —— 两支冷门分支的覆盖（评审补的，都不是 bug）', () => {
  it('角度折过 90° 之后对称：@97 == @83（"转 90° 再矫正 +7°"就是这个形状）', () => {
    const a = inscribedRect(1000, 500, 97)
    const b = inscribedRect(1000, 500, 83)
    close(a.w, b.w); close(a.h, b.h)
    expect(a.w).toBeGreaterThan(0); expect(a.h).toBeGreaterThan(0)
    expect(a.w * a.h).toBeLessThanOrEqual(1000 * 500 + 1e-6)
    cornersInside(a, 1000, 500, 97)
  })
  it('3:1 的长条 @15 走"贴住短边"那一支，四角仍在照片里', () => {
    const r = inscribedRect(3000, 1000, 15)
    close(r.w, 1931.852, 1e-3); close(r.h, 517.638, 1e-3)
    cornersInside(r, 3000, 1000, 15)
  })
})

describe('fitAspect / rectFromSize / clampRect', () => {
  it('给了比例档就按它收（装得下为前提）', () => {
    // 可用区 800×600，要 1:1 → 600×600
    expect(fitAspect({ w: 800, h: 600 }, 1)).toEqual({ w: 600, h: 600 })
    // 要 16:9 → 800×450
    expect(fitAspect({ w: 800, h: 600 }, 16 / 9)).toEqual({ w: 800, h: 450 })
  })
  it('自由档原样返回', () => {
    expect(fitAspect({ w: 800, h: 600 }, null)).toEqual({ w: 800, h: 600 })
  })
  it('居中的归一化矩形', () => {
    expect(rectFromSize({ w: 400, h: 300 }, { w: 800, h: 600 }))
      .toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
  })
  it('夹进 0~1；太小的框给一个下限（别让它缩成 0）', () => {
    expect(clampRect({ x: -1, y: 2, w: 5, h: 5 })).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    const tiny = clampRect({ x: .5, y: .5, w: 0.0001, h: 0.0001 })
    expect(tiny.w).toBeCloseTo(0.02); expect(tiny.h).toBeCloseTo(0.02)
  })
})

describe('cropOutputSize —— 裁出来多少像素', () => {
  const spec = (rect: [number, number, number, number], angle = 0): CropSpec =>
    ({ rect: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] }, angle })
  it('不转、整张 → 就是原图尺寸', () => {
    expect(cropOutputSize(spec([0, 0, 1, 1]), 0, 1200, 800)).toEqual({ width: 1200, height: 800 })
  })
  it('裁一半 → 一半像素', () => {
    expect(cropOutputSize(spec([0, 0, .5, .5]), 0, 1200, 800)).toEqual({ width: 600, height: 400 })
  })
  it('★ 转 90 度 → 长宽对调', () => {
    expect(cropOutputSize(spec([0, 0, 1, 1]), 1, 1200, 800)).toEqual({ width: 800, height: 1200 })
  })
  it('★ 转完之后**不许放大**：像素总数不超过原图', () => {
    // 15 度时外框比原图大，内接矩形几乎占满外框 —— 不设上限就会输出比原图更大的图
    const r = inscribedRect(1200, 800, MAX_STRAIGHTEN)
    const b = rotatedBounds(1200, 800, MAX_STRAIGHTEN)
    const out = cropOutputSize({ rect: rectFromSize(r, b), angle: MAX_STRAIGHTEN }, 0, 1200, 800)
    expect(out.width * out.height).toBeLessThanOrEqual(1200 * 800 + 1)
    expect(out.width).toBeGreaterThan(0)
  })
  it('★★ 上面那顶帽子真会被踩到：满框转 15°（本该 1366×1083）要削回原图以内', () => {
    // 把 cropOutputSize 里那个 if 删掉，套件本来照样全绿 —— 这条专治那个盲区：
    // 满框 1×1、转 15°，外框 1366×1083，超了 1200×800 的额度，非削不可。
    const out = cropOutputSize({ rect: { x: 0, y: 0, w: 1, h: 1 }, angle: 15 }, 0, 1200, 800)
    expect(out.width * out.height).toBeLessThanOrEqual(1200 * 800 + 1)
    expect(out.width).toBeGreaterThan(0); expect(out.height).toBeGreaterThan(0)
  })
  it('effectiveAngle 把 90 度整转和矫正角合起来', () => {
    expect(effectiveAngle(spec([0, 0, 1, 1], 7), 1)).toBe(97)
    expect(effectiveAngle(spec([0, 0, 1, 1], -7), 3)).toBe(263)
  })
})
