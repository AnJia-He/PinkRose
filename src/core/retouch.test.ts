import { describe, expect, it } from 'vitest'
import {
  createMask, expandMask, maskBounds, stampBrush, stampStroke,
} from './retouch'

/**
 * 点修的**掩码工具**：笔刷盖章、笔画补点、外扩、以及"用哪个引擎"的选路。
 * 这些是纯函数 —— 涂抹的手感全在这儿，UI 只负责把指针位置喂进来。
 */

describe('createMask', () => {
  it('开出来一张全零的掩码，长度 = 宽 × 高', () => {
    const m = createMask(7, 5)
    expect(m.length).toBe(35)
    expect(m.every(v => v === 0)).toBe(true)
  })
})

describe('stampBrush', () => {
  it('画：圆心满强度 255，半径外一个字节都不动', () => {
    const w = 40, h = 40
    const m = createMask(w, h)
    stampBrush(m, w, h, 20, 20, 8, 'paint')
    expect(m[20 * w + 20]).toBe(255)
    // ⚠️ 判"圈外"要按**像素中心**算距离：x=12 的像素中心在 12.5，
    //    离圆心 7.5px —— 那还在半径 8 的软边里，非零是对的。
    expect(m[20 * w + 11]).toBe(0)   // 中心 11.5 → 距离 8.5 > 8，真圈外
    expect(m[0]).toBe(0)
    expect(m[39 * w + 39]).toBe(0)
  })

  it('软边：半径中段的覆盖介于 0 和 255 之间（不是硬邦邦一个圆）', () => {
    const w = 40, h = 40
    const m = createMask(w, h)
    stampBrush(m, w, h, 20, 20, 8, 'paint', 0.5)
    // 半径 8、软区从 4 起 → 6px 处应该落在过渡带里
    const v = m[20 * w + 26]!
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(255)
  })

  it('橡皮：擦过的地方减下去，干净处擦不出负数', () => {
    const w = 40, h = 40
    const m = createMask(w, h)
    stampBrush(m, w, h, 20, 20, 6, 'paint')
    expect(m[20 * w + 20]).toBe(255)
    stampBrush(m, w, h, 20, 20, 6, 'erase')
    expect(m[20 * w + 20]).toBe(0)
    stampBrush(m, w, h, 5, 5, 6, 'erase')     // 本来就空白的地方
    expect(m[5 * w + 5]).toBe(0)
  })

  it('圆心贴着画面边也安全：不抛错、圈内的画上、圈外不动', () => {
    const w = 20, h = 20
    const m = createMask(w, h)
    expect(() => stampBrush(m, w, h, 0, 0, 5, 'paint')).not.toThrow()
    expect(m[0]).toBe(255)
    expect(m[19 * w + 19]).toBe(0)
  })

  it('返回"有没有真的改动"，重复同一笔不算改动', () => {
    const w = 20, h = 20
    const m = createMask(w, h)
    expect(stampBrush(m, w, h, 10, 10, 4, 'paint')).toBe(true)
    expect(stampBrush(m, w, h, 10, 10, 4, 'paint')).toBe(false)
  })
})

describe('stampStroke', () => {
  it('★ 快速拖动不断线：起止两点之间一路都盖上章', () => {
    // 为什么单独立这条：指针事件是离散的，快速拖一下两点能隔着几百像素。
    // 不补中间的话笔画是一串孤立的点 —— 屏幕上还看不出来（红影淡淡一层），
    // 擦出来却是一段段漏的。
    const w = 100, h = 40
    const m = createMask(w, h)
    stampStroke(m, w, h, 10, 20, 90, 20, 3, 'paint')
    for (let x = 10; x <= 90; x++) {
      if (!m[20 * w + x]) throw new Error(`笔画在 x=${x} 处断了`)
    }
  })

  it('起止同点 = 盖一个章（不抛错、不改出界）', () => {
    const w = 20, h = 20
    const m = createMask(w, h)
    expect(() => stampStroke(m, w, h, 10, 10, 10, 10, 3, 'paint')).not.toThrow()
    expect(m[10 * w + 10]).toBe(255)
  })
})

describe('maskBounds', () => {
  it('空掩码 → null', () => {
    expect(maskBounds(createMask(10, 10), 10, 10)).toBeNull()
  })

  it('盖一个章 → 外接框和计数对得上', () => {
    const w = 30, h = 30
    const m = createMask(w, h)
    stampBrush(m, w, h, 10, 12, 4, 'paint')
    const b = maskBounds(m, w, h)!
    expect(b).not.toBeNull()
    expect(b.x0).toBeGreaterThanOrEqual(5)
    expect(b.x1).toBeLessThanOrEqual(15)
    expect(b.y0).toBeGreaterThanOrEqual(7)
    expect(b.y1).toBeLessThanOrEqual(17)
    expect(b.count).toBeGreaterThan(0)
    // 计数 = 非零像素个数
    let n = 0
    for (const v of m) if (v) n++
    expect(b.count).toBe(n)
  })
})

describe('expandMask', () => {
  it('往外扩 px 像素（灰度膨胀：软边跟着长，不是拍扁成硬块）', () => {
    const w = 9, h = 9
    const m = createMask(w, h)
    m[4 * w + 4] = 100
    const out = expandMask(m, w, h, 1)
    expect(out[4 * w + 4]).toBe(100)
    // 3px 之外不受影响
    expect(out[4 * w + 1]).toBe(0)
    // 相邻一格至少被抬到 100（膨胀取邻域最大）
    expect(out[4 * w + 5]).toBe(100)
    expect(out[3 * w + 4]).toBe(100)
  })

  it('空白掩码扩完还是空白；不改原数组', () => {
    const w = 5, h = 5
    const m = createMask(w, h)
    const out = expandMask(m, w, h, 2)
    expect(out.every(v => v === 0)).toBe(true)
    m[0] = 200
    expect(out[0]).toBe(0)
  })
})
