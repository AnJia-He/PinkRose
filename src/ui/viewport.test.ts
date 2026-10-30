/**
 * 照片查看的**缩放/平移**数学（★ 2026-10-06）。
 *
 * 这一层是纯函数，所以断言全是"数字对数字" —— 组件那边只管接线（手势、按钮、
 * 把结果贴到 `transform` 上）。数学单独成层有个具体理由：这套东西里最容易错的
 * 是**坐标系**（照片的、可视区的、屏幕的），而坐标系错了在屏幕上要么看不出来、
 * 要么看起来只是"有点怪"，只有拿数字钉才钉得住。
 */
import { describe, expect, it } from 'vitest'
import {
  FIT, clampView, fitBox, maxScale, oneToOne, panBy, pinchView, zoomTo,
  type Size, type View,
} from './viewport'

/** 一块 1000×800 的照片区。 */
const AREA: Size = { width: 1000, height: 800 }
/** 4000×3000 的横照片：被**宽度**顶着 → 1000×750。 */
const BIG: Size = { width: 4000, height: 3000 }
const BIG_FIT: Size = { width: 1000, height: 750 }

/** 把"照片上的某个点"摆到屏幕坐标上（以可视区左上角为原点）。
 *  测试用它验"锚点有没有跑"：同一个点，缩放前后算出来的屏幕位置必须一样。 */
const at = (v: View, u: number, axis: 'x' | 'y') =>
  (axis === 'x' ? AREA.width / 2 + v.x : AREA.height / 2 + v.y) + u * v.scale

describe('fitBox —— 适应窗口时照片多大', () => {
  it('等比缩到框里，被**短的那一边**顶着', () => {
    expect(fitBox(BIG, AREA)).toEqual({ width: 1000, height: 750 })
  })

  it('比框还小的照片**原样显示**，不放大（和 CSS 的 max-width/max-height 同一条）', () => {
    expect(fitBox({ width: 800, height: 600 }, AREA)).toEqual({ width: 800, height: 600 })
  })

  it('框还没量出来时给 0 —— 别让调用方拿它去做除数', () => {
    expect(fitBox(BIG, { width: 0, height: 0 })).toEqual({ width: 0, height: 0 })
  })
})

describe('oneToOne / maxScale —— 放大到哪儿为止', () => {
  it('100% 真实像素 = "适应窗口"的几倍', () => {
    expect(oneToOne(BIG, BIG_FIT)).toBeCloseTo(4)
  })

  it('大照片：给到 8 倍封顶（100% 是 4 倍，够用）', () => {
    expect(maxScale(BIG, BIG_FIT)).toBe(8)
  })

  it('★ 小照片：8 倍只是把 800px 拉成 6400px 的糊块 —— 上限压到真实像素的 4 倍', () => {
    const small = { width: 800, height: 600 }
    expect(maxScale(small, { width: 800, height: 600 })).toBe(4)
  })
})

describe('clampView —— 画面中心永远有照片（照片的边最多拉到正中间）', () => {
  it('适应窗口只有一个位置：正中间', () => {
    expect(clampView({ scale: 1, x: 99, y: -99 }, BIG_FIT)).toEqual({ scale: 1, x: 0, y: 0 })
  })

  it('放大之后，最多把照片的边拉到画面正中间（2 倍时是半张：1000×750）', () => {
    expect(clampView({ scale: 2, x: 9999, y: -9999 }, BIG_FIT))
      .toEqual({ scale: 2, x: 1000, y: -750 })
  })

  it('★ 最角上那一个点也能拉到正中间（用户 2026-10-06 晚亲自要的）', () => {
    // 右上角离照片中心正好是半张（1000×750）—— 拉到正中间要的平移量就是它，
    // 也就是说**它正好在允许范围的边界上**，不是被夹在门外。
    expect(clampView({ scale: 2, x: -1000, y: 750 }, BIG_FIT))
      .toEqual({ scale: 2, x: -1000, y: 750 })
  })

  it('还在范围内的视图原样返回同一个对象（手势里每帧都过一遍，别白换身份）', () => {
    const v: View = { scale: 2, x: 120, y: -30 }
    expect(clampView(v, BIG_FIT)).toBe(v)
  })
})

describe('zoomTo —— 放大时"指针底下那块别跑"', () => {
  it('★ 锚点那一点在屏幕上不动（滚轮缩放的全部意义）', () => {
    // 指针在可视区中心右边 250px 处（照片宽 1000，就是照片 75% 那一条）
    const anchor = { x: AREA.width / 2 + 250, y: AREA.height / 2 }
    const before = at(FIT, 250, 'x')
    const next = zoomTo(FIT, 2, anchor, BIG_FIT, AREA)
    expect(before).toBe(750)                 // 它的屏幕位置：中心 +250
    expect(next).toEqual({ scale: 2, x: -250, y: 0 })
    expect(at(next, 250, 'x')).toBeCloseTo(750)   // 缩放之后还是 750
  })

  it('以中心为锚点：中心底下那个点不动（哪怕照片已经被拖偏了）', () => {
    const v: View = { scale: 2, x: -250, y: 100 }
    const next = zoomTo(v, 4, { x: 500, y: 400 }, BIG_FIT, AREA)
    expect(next.scale).toBe(4)
    // 缩放前压在中心底下的是照片上这一条（中心往上 50 个"适应窗口"像素）
    const u = (400 - 400 - v.y) / v.scale
    expect(at(next, u, 'y')).toBeCloseTo(400)     // 缩放之后还压在中心
  })

  it('缩放下限是 1：不会缩得比"适应窗口"还小', () => {
    expect(zoomTo(FIT, 0.3, { x: 500, y: 400 }, BIG_FIT, AREA).scale).toBe(1)
  })

  it('上限由调用方给（`maxScale` 那两条线）', () => {
    expect(zoomTo(FIT, 100, { x: 500, y: 400 }, BIG_FIT, AREA, 6).scale).toBe(6)
  })

  it('★ 锚点在照片的角上：照样摆得准（"把边上的细节拉到中间"要的就是这一下）', () => {
    const next = zoomTo(FIT, 2, { x: 0, y: 0 }, BIG_FIT, AREA)
    expect(next).toEqual({ scale: 2, x: 500, y: 400 })
    // 照片左上角那一点仍然压在可视区左上角上（没被夹走）
    expect(at(next, -500, 'x')).toBeCloseTo(0)
    expect(at(next, -400, 'y')).toBeCloseTo(0)
  })
})

describe('panBy —— 拖着看', () => {
  it('给的是**相对按下那一刻**的总位移（不是每帧的增量）', () => {
    expect(panBy({ scale: 2, x: 0, y: 0 }, 30, -20, BIG_FIT))
      .toEqual({ scale: 2, x: 30, y: -20 })
  })

  it('拖过头就停在边界上（照片的边正好到画面正中间）', () => {
    expect(panBy({ scale: 2, x: 980, y: 0 }, 100, 0, BIG_FIT))
      .toEqual({ scale: 2, x: 1000, y: 0 })
  })
})

describe('pinchView —— 双指缩放 + 同时拖动', () => {
  it('两指拉开：按两指距离放大，指间那块细节跟着两指中心走', () => {
    const next = pinchView(
      FIT,
      { mid: { x: 500, y: 400 }, distance: 100 },
      { mid: { x: 650, y: 400 }, distance: 200 },
      BIG_FIT,
      AREA,
    )
    expect(next).toEqual({ scale: 2, x: 150, y: 0 })
    // 原来压在初始中心的那一点，现在落在新的两指中心上。
    expect(at(next, 0, 'x')).toBeCloseTo(650)
  })

  it('两指中点不动、距离不变：视图一点不抖', () => {
    const next = pinchView(
      FIT,
      { mid: { x: 500, y: 400 }, distance: 120 },
      { mid: { x: 500, y: 400 }, distance: 120 },
      BIG_FIT,
      AREA,
    )
    expect(next).toEqual(FIT)
  })

  it('两指收拢：最多回到适应窗口，不会缩到照片比屏幕还小', () => {
    const next = pinchView(
      { scale: 2, x: 150, y: 20 },
      { mid: { x: 500, y: 400 }, distance: 300 },
      { mid: { x: 500, y: 400 }, distance: 80 },
      BIG_FIT,
      AREA,
    )
    expect(next).toEqual(FIT)
  })

  it('已经放大时，两指同向拖动 = 平移（距离没变也不影响）', () => {
    const next = pinchView(
      { scale: 2, x: 0, y: 0 },
      { mid: { x: 500, y: 400 }, distance: 200 },
      { mid: { x: 530, y: 420 }, distance: 200 },
      BIG_FIT,
      AREA,
    )
    expect(next).toEqual({ scale: 2, x: 30, y: 20 })
  })

  it('放大上限仍由 maxScale 那条线管着', () => {
    const next = pinchView(
      FIT,
      { mid: { x: 500, y: 400 }, distance: 10 },
      { mid: { x: 500, y: 400 }, distance: 1000 },
      BIG_FIT,
      AREA,
      6,
    )
    expect(next.scale).toBe(6)
  })
})
