import { MAX_DIMENSION, align32, fitWithin } from '../../shared/size.ts'
import type { Sizable } from './prepare'

/** 圈的半径 = 图片长边的这个比例。6% 是"一眼能看见、又不会盖住半个画面"的折中。 */
export const MARKER_RADIUS_RATIO = 0.06

export type NormPoint = { x: number; y: number }

/**
 * 归一化的点 → 图片上的像素坐标和半径。
 *
 * 半径按**长边**算：按短边算的话，一张 1000×200 的横图上圈会小得看不见，
 * 而立图又会大得离谱 —— 同一个比例在两种图上该看起来一样大。
 *
 * 越界的点夹回边界：用户在画布边缘点一下，不该画出一个跑到画面外的圈。
 */
export function markerGeometry(
  m: NormPoint, w: number, h: number,
): { cx: number; cy: number; r: number } {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  return {
    cx: Math.round(clamp01(m.x) * w),
    cy: Math.round(clamp01(m.y) * h),
    r: Math.max(8, Math.round(Math.max(w, h) * MARKER_RADIUS_RATIO)),
  }
}

/**
 * 把用户点的那个圈**画进图里**，返回一张可以送模型的画布。
 *
 * 为什么不把位置写成一句话告诉模型：spec §6.3 记着实测结论 ——
 * 「在图上画标记让模型只改标记处是可行的，**红圈本身也会被正确擦除**」。
 * 图上画圈比文字描述可靠得多。
 *
 * 尺寸走 `prepareForModel` 那一套（长边 2048、宽高对齐 32）——
 * 圈在**缩放之后**画，所以在最终送出去的图上位置和大小都还对。
 */
export function markImage(
  source: Sizable, m: NormPoint, maxDim = MAX_DIMENSION,
): HTMLCanvasElement {
  const fitted = fitWithin(source.width, source.height, maxDim)
  const width = align32(fitted.width)
  const height = align32(fitted.height)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })
  if (!ctx) throw new Error('拿不到 2D 上下文，画不了标记')

  ctx.drawImage(source, 0, 0, width, height)

  const { cx, cy, r } = markerGeometry(m, width, height)
  ctx.strokeStyle = '#ff3b30'
  ctx.lineWidth = Math.max(4, Math.round(r / 6))
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()

  return canvas
}
