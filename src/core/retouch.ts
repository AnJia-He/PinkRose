/**
 * 点修的**掩码工具**（★ 2026-10-07）：笔刷盖章、笔画补点、外扩、选路。
 *
 * 全部是纯函数（jsdom 里能直接喂坐标问结果，涂抹手感不靠挂组件验）。
 * UI（`ui/RetouchOverlay`）只做两件事：把指针换算成**图片像素坐标**喂进来、
 * 把掩码画成屏幕上的红色预览。
 *
 * 掩码约定：width×height 的 `Uint8Array`，**0 = 不擦，越大擦得越实**
 * （255 = 全擦）。它是"覆盖率"不是"开关"—— 软笔刷的过渡带靠它，
 * 引擎那边也按覆盖率混合（见 `image/heal.ts` 的 amount）。
 */

export type BrushMode = 'paint' | 'erase'

/** 默认笔刷半径（图片像素）：短边的 3%，夹在 8~120px 之间。
 *  ★ 2026-10-08 从 `App.tsx` 搬进来（纯算式；App 的 `openRetouch` 和
 *  `ui/RetouchControls` 两处都要用）。 */
export function defaultBrushRadius(w: number, h: number): number {
  return Math.max(8, Math.min(120, Math.round(Math.min(w, h) * 0.03)))
}

/** 笔刷滑杆的上限（图片像素）：短边的 25%。（同 `defaultBrushRadius`，10-08 搬。） */
export function maxBrushRadius(w: number, h: number): number {
  return Math.max(24, Math.round(Math.min(w, h) * 0.25))
}

export function createMask(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height)
}

/** 盖章中心到像素中心的距离 → 覆盖率（0–255）。软区走 smoothstep，别用线性 ——
 *  线性过渡在视觉上是"一圈灰边"，smoothstep 才像笔刷。 */
function coverage(d: number, radius: number, hardness: number): number {
  if (radius <= 0) return 0
  const t = d / radius
  if (t <= hardness) return 255
  if (t >= 1) return 0
  const u = (1 - t) / (1 - hardness)
  return Math.round(255 * u * u * (3 - 2 * u))
}

/**
 * 盖一个圆形章（`cx/cy` 是图片像素坐标，可以是小数）。返回"有没有真的改动"。
 *
 * 画笔 = 取大（反复涂同一处不会越涂越深）；橡皮 = 减（擦过的地方真的下去）。
 */
export function stampBrush(
  mask: Uint8Array, w: number, h: number,
  cx: number, cy: number, radius: number, mode: BrushMode, hardness = 0.5,
): boolean {
  if (radius < 0.5) return false
  const r = radius
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(w - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(h - 1, Math.ceil(cy + r))
  let changed = false
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cov = coverage(Math.hypot(x + 0.5 - cx, y + 0.5 - cy), r, hardness)
      if (!cov) continue
      const i = y * w + x
      const before = mask[i]!
      const after = mode === 'paint' ? Math.max(before, cov) : Math.max(0, before - cov)
      if (after !== before) {
        mask[i] = after
        changed = true
      }
    }
  }
  return changed
}

/**
 * 两点之间补一路章（**快速拖动不断线**）：指针事件是离散的，拖快了相邻两点
 * 能隔着几百像素 —— 不插值的话屏幕上看着是一笔，擦出来是一段段漏的。
 * 步距取半径的 1/4，够密也不浪费。
 */
export function stampStroke(
  mask: Uint8Array, w: number, h: number,
  ax: number, ay: number, bx: number, by: number,
  radius: number, mode: BrushMode, hardness = 0.5,
): boolean {
  const dist = Math.hypot(bx - ax, by - ay)
  const spacing = Math.max(1, radius / 4)
  const steps = Math.max(1, Math.ceil(dist / spacing))
  let changed = false
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    if (stampBrush(mask, w, h, ax + (bx - ax) * t, ay + (by - ay) * t, radius, mode, hardness)) {
      changed = true
    }
  }
  return changed
}

/** 掩码的非零外接框 + 计数。空掩码 → null。 */
export function maskBounds(
  mask: Uint8Array, w: number, h: number,
): { x0: number; y0: number; x1: number; y1: number; count: number } | null {
  let x0 = w, y0 = h, x1 = 0, y1 = 0, count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue
      count++
      if (x < x0) x0 = x
      if (x + 1 > x1) x1 = x + 1
      if (y < y0) y0 = y
      if (y + 1 > y1) y1 = y + 1
    }
  }
  return count ? { x0, y0, x1, y1, count } : null
}

/**
 * **灰度膨胀**：把掩码外扩 `px` 像素（邻域取最大，软边跟着长）。
 *
 * 为什么擦之前要外扩：用户围着东西涂一圈，贴边那一细条最容易没涂到 ——
 * 不扩就会留一圈"没擦干净的边"。外扩量是**故意的多擦**，宁可多一点点。
 * 分两趟（横着取最大、竖着取最大）等价于方形邻域取最大，省一半的活。
 */
export function expandMask(mask: Uint8Array, w: number, h: number, px: number): Uint8Array {
  if (px <= 0) return mask.slice()
  const tmp = new Uint8Array(mask.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0
      const lo = Math.max(0, x - px)
      const hi = Math.min(w - 1, x + px)
      for (let k = lo; k <= hi; k++) {
        const v = mask[y * w + k]!
        if (v > m) m = v
      }
      tmp[y * w + x] = m
    }
  }
  const out = new Uint8Array(mask.length)
  for (let y = 0; y < h; y++) {
    const lo = Math.max(0, y - px)
    const hi = Math.min(h - 1, y + px)
    for (let x = 0; x < w; x++) {
      let m = 0
      for (let k = lo; k <= hi; k++) {
        const v = tmp[k * w + x]!
        if (v > m) m = v
      }
      out[y * w + x] = m
    }
  }
  return out
}
