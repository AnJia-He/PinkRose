import { describe, it, expect } from 'vitest'
import { fitToLimit, type RenderLimit } from './limits'

/**
 * `fitToLimit` 决定「这张照片要缩到多少才能在本设备上画出来」。
 *
 * 它同时守两条约束：单边上限（所有平台都有）和面积上限（只有 iOS 有）。
 * 两条都是**硬约束**——算错一像素、把它顶回上限之上，渲染就会静默失败，
 * 用户拿到一块白画布，而保存按钮还会把白像素当成品导出去。
 *
 * 所以这一组测试的重心不在「缩得准不准」，而在「**缩完一定在限内**」。
 * 每个断言旁边写了能让它变红的那个改动。
 */

const ANDROID: RenderLimit = { maxSide: 4096, maxArea: null }
const DESKTOP: RenderLimit = { maxSide: 8192, maxArea: null }
const IPHONE: RenderLimit = { maxSide: 8192, maxArea: 16777216 }

/** 结果必须落在限内——这是这个函数存在的全部理由。 */
function within(w: number, h: number, limit: RenderLimit): boolean {
  return w <= limit.maxSide && h <= limit.maxSide &&
    (limit.maxArea === null || w * h <= limit.maxArea)
}

describe('fitToLimit', () => {
  it('在限内的尺寸原样返回，不"顺手"缩小', () => {
    // 改成「反正不大，统一缩一下更保险」这条就红。
    // 不能顺手缩：缩一次就是永久损失一次画质，而绝大多数照片根本不需要。
    expect(fitToLimit(4032, 3024, ANDROID)).toEqual({ width: 4032, height: 3024 })
    expect(fitToLimit(1200, 800, ANDROID)).toEqual({ width: 1200, height: 800 })
    expect(fitToLimit(512, 512, ANDROID)).toEqual({ width: 512, height: 512 })
  })

  it('正好等于上限的原样返回 —— 上限是「不超过」，不是「小于」', () => {
    // 边界这一格单独钉，是因为「留一像素余量更保险」是很自然的写法，
    // 而它只在**正好贴着上限**时才露出来。
    //
    // 实测过：把 `>` 写成 `>=` 这条**不会**红 —— longest === maxSide 时
    // k = maxSide/longest 恰好是 1.0，两种写法结果一样，那是个等价变异。
    // 真正能让它红的是 `k = (limit.maxSide - 1) / longest` 这种"保守"实现：
    // 4096 会变成 4095。上面那条「原样返回」的测试反而抓不到它，
    // 因为 1200×800 离上限远，那段代码根本不会执行。
    expect(fitToLimit(4096, 3072, ANDROID)).toEqual({ width: 4096, height: 3072 })
    expect(fitToLimit(3072, 4096, ANDROID)).toEqual({ width: 3072, height: 4096 })
  })

  it('单边超了，按长边缩，并保持宽高比', () => {
    // 用户那台手机的真实数字：4928×6560 撞上单边 4096。
    // 把比例算成 maxSide/宽（而不是 maxSide/长边）这条就红。
    const r = fitToLimit(4928, 6560, ANDROID)
    expect(r).toEqual({ width: 3076, height: 4096 })
    expect(within(r.width, r.height, ANDROID)).toBe(true)
    // 横图方向也不能搞反：这里只有宽超了
    expect(fitToLimit(6560, 4928, ANDROID)).toEqual({ width: 4096, height: 3076 })
  })

  it('面积超了，按面积缩（iPhone 那条没人报得出来的上限）', () => {
    // 这张图单边完全合格（6560 < 8192），只有面积超。
    // 去掉 maxArea 那一段，这条就红。
    const r = fitToLimit(4928, 6560, IPHONE)
    expect(within(r.width, r.height, IPHONE)).toBe(true)
  })

  it('⚠️ 取整不能把它顶回上限之上', () => {
    // 这是整个函数最容易写错的一处，而且错了不会有任何提示。
    //
    // 按面积缩完是 3550.12…×4725.81…，用 Math.round 会得到 3550×4726 =
    // 16,777,300 —— 比 16777216 的**上限还大 84 像素**。于是渲染照样静默失败，
    // 我们却在上面刚保证过"缩了就没事了"。
    //
    // 把 Math.floor 改成 Math.round，下面**第一条**断言立刻红。这正是它存在的理由。
    // （第二条是钉住具体数字的，防止实现悄悄改成"多缩一截保平安"。）
    const r = fitToLimit(4928, 6560, IPHONE)
    expect(r.width * r.height).toBeLessThanOrEqual(16777216)
    expect(r).toEqual({ width: 3550, height: 4725 })
  })

  it('两条上限同时超时，按更狠的那条缩', () => {
    // 取 min 才对。写成「先按单边缩、缩完不管面积」这条就红：
    // 50MP 在 iPhone 上单边合格（8000 < 8192）但面积超一倍。
    const r = fitToLimit(8000, 6250, IPHONE)
    expect(within(r.width, r.height, IPHONE)).toBe(true)
    expect(r.width).toBeLessThan(8000)
  })

  it('极端长条图：短边缩到 0 就废了，最少留 1 像素', () => {
    // 10000×1 按 4096 缩，短边是 0.4096。少了 Math.max(1, …) 这条就红，
    // 而且红得很难看——画布高 0 会直接抛错。
    const r = fitToLimit(10000, 1, ANDROID)
    expect(r).toEqual({ width: 4096, height: 1 })
    expect(within(r.width, r.height, ANDROID)).toBe(true)
  })

  it('把各种尺寸横扫一遍：缩完必须**永远**在限内', () => {
    // 上面每条钉一个具体数字，这条钉的是"规律本身"。
    // 只对某几个尺寸做特判、没真正按比例算的实现，会在这一片里露出来。
    const sizes = [
      [1, 1], [3, 8000], [8000, 3], [1, 20000], [20000, 1],
      [4928, 6560], [6560, 4928], [12000, 9000], [4097, 1],
      [16777216, 1], [9999, 9999], [2, 16777217],
    ] as const
    for (const limit of [ANDROID, DESKTOP, IPHONE]) {
      for (const [w, h] of sizes) {
        const r = fitToLimit(w, h, limit)
        expect(r.width, `${w}×${h} 缩成了 ${r.width}×${r.height}`)
          .toBeGreaterThanOrEqual(1)
        expect(r.height, `${w}×${h} 缩成了 ${r.width}×${r.height}`)
          .toBeGreaterThanOrEqual(1)
        expect(within(r.width, r.height, limit),
          `${w}×${h} → ${r.width}×${r.height} 仍然超出 ${JSON.stringify(limit)}`)
          .toBe(true)
      }
    }
  })
})
