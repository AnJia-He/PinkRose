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

/**
 * Apple Pencil / stylus pressure scale. Mouse and touch stay exactly 1.
 * Pressure 0 still leaves a usable 35% brush; pressure 1 gives the full size.
 */
export function penPressureScale(pointerType: string | undefined, pressure: number | undefined): number {
  if (pointerType !== 'pen') return 1
  const p = Math.max(0, Math.min(1, Number.isFinite(pressure) ? pressure! : 0.5))
  return 0.35 + 0.65 * p
}

export function createMask(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height)
}

/** 覆盖度逐像素取反：0 ↔ 255，软边仍按 255-v 连续过渡。返回新数组。 */
export function invertMask(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) out[i] = 255 - mask[i]!
  return out
}

/** 按百分比缩放覆盖率（0–100）；100 返回副本，原掩码不动。 */
export function scaleMask(mask: Uint8Array, percent: number): Uint8Array {
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 100)) / 100
  const out = new Uint8Array(mask.length)
  if (p <= 0) return out
  if (p >= 1) return mask.slice()
  for (let i = 0; i < mask.length; i++) out[i] = Math.round(mask[i]! * p)
  return out
}

/**
 * 羽化覆盖度：沿横竖各做两次盒式模糊，边缘由硬切变成平滑过渡。
 * 半径 0 返回副本；原掩码不动，方便用户继续调滑杆而不会反复叠加。
 */
export function featherMask(
  mask: Uint8Array, width: number, height: number, radius: number,
): Uint8Array {
  const out = mask.slice()
  const r = Math.max(0, Math.min(255, Math.round(radius)))
  if (r === 0) return out
  const passR = Math.max(1, Math.round(r / 2))
  const win = passR * 2 + 1
  const tmp = new Uint8Array(out.length)
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < height; y++) {
      let sum = 0
      for (let k = -passR; k <= passR; k++) {
        sum += out[y * width + Math.max(0, Math.min(width - 1, k))]!
      }
      for (let x = 0; x < width; x++) {
        tmp[y * width + x] = Math.round(sum / win)
        sum -= out[y * width + Math.max(0, Math.min(width - 1, x - passR))]!
        sum += out[y * width + Math.max(0, Math.min(width - 1, x + passR + 1))]!
      }
    }
    // 竖向滑窗单独走一遍，避免在每列重复算窗口。
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = -passR; k <= passR; k++) {
        sum += tmp[Math.max(0, Math.min(height - 1, k)) * width + x]!
      }
      for (let y = 0; y < height; y++) {
        out[y * width + x] = Math.round(sum / win)
        sum -= tmp[Math.max(0, Math.min(height - 1, y - passR)) * width + x]!
        sum += tmp[Math.max(0, Math.min(height - 1, y + passR + 1)) * width + x]!
      }
    }
  }
  return out
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

/**
 * 一维滑动窗口取最大 / 最小（单调队列，O(N)）。
 *
 * `expandMask` 是逐像素扫邻域的写法，给它加"收缩"还得再扫一遍反方向；
 * 蒙版扩展 / 收缩要支持几十像素，12 MP 上按 O(N·r) 扫会明显卡。
 * 这里横竖各一趟，窗口里的极值用单调队列维护。
 */
function edgePass(
  src: Uint8Array, w: number, h: number, r: number,
  horizontal: boolean, mode: 'max' | 'min',
): Uint8Array {
  const out = new Uint8Array(src.length)
  const n = horizontal ? w : h
  const lines = horizontal ? h : w
  const dq = new Int32Array(n)
  const value = (i: number, line: number): number =>
    horizontal ? src[line * w + i]! : src[i * w + line]!
  const at = (i: number, line: number): number =>
    horizontal ? line * w + i : i * w + line
  const better = mode === 'max'
    ? (a: number, b: number) => a <= b
    : (a: number, b: number) => a >= b

  for (let line = 0; line < lines; line++) {
    let head = 0
    let tail = 0
    for (let i = 0; i < n + r; i++) {
      if (i < n) {
        const v = value(i, line)
        while (tail > head) {
          const prev = dq[tail - 1]!
          if (!better(value(prev, line), v)) break
          tail--
        }
        dq[tail++] = i
      }
      while (tail > head && dq[head]! < i - 2 * r) head++
      const o = i - r
      if (o >= 0) out[at(o, line)] = src[at(dq[head]!, line)]!
    }
  }
  return out
}

/** 灰度膨胀：邻域取最大，软边跟着外扩。 */
export function growMask(
  mask: Uint8Array, w: number, h: number, radius: number,
): Uint8Array {
  const r = Math.max(0, Math.min(64, Math.round(radius)))
  if (r <= 0) return mask.slice()
  const once = edgePass(mask, w, h, r, true, 'max')
  return edgePass(once, w, h, r, false, 'max')
}

/** 灰度腐蚀：邻域取最小，软边跟着内收。 */
export function shrinkMask(
  mask: Uint8Array, w: number, h: number, radius: number,
): Uint8Array {
  const r = Math.max(0, Math.min(64, Math.round(radius)))
  if (r <= 0) return mask.slice()
  const once = edgePass(mask, w, h, r, true, 'min')
  return edgePass(once, w, h, r, false, 'min')
}

/**
 * 蒙版扩展 / 收缩：`delta > 0` 外扩，`delta < 0` 内收，单位图片像素。
 * 0 返回副本（调用方可以照常 set，不会和原掩码互相影响）。
 */
export function adjustMaskEdge(
  mask: Uint8Array, w: number, h: number, delta: number,
): Uint8Array {
  const px = Math.round(delta)
  if (!Number.isFinite(px) || px === 0) return mask.slice()
  return px > 0 ? growMask(mask, w, h, px) : shrinkMask(mask, w, h, -px)
}
