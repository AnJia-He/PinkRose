/**
 * 裁剪 / 旋转 / 水平矫正的**算式**（★ 2026-10-06）。纯函数，不碰 DOM。
 *
 * 坐标系只有一套，后面每处注释都按它说话：
 *   · **底图**：用户手上那张 `base`，`imgW × imgH`。
 *   · **外框（bounds）**：底图转 `θ` 之后占的那块**轴对齐**矩形
 *     （`rotatedBounds`）。转过的照片有四个空角，外框把它们也框进来。
 *   · **裁剪框**：`CropRect`，**相对外框**归一化的 0~1。
 *     ——为什么要拿"外框"当基准：照片在界面上转、框不转，
 *     所以框量出来的那条边就是外框那条边（`Canvas` 量到的盒子就是外框）。
 *
 * ⚠️ 一条硬规矩（v1）：**角度一变，框重置成"居中的最大内接矩形"** ——
 *    内接矩形按定义不碰空角。
 *    ——但**这一层只负责给出这个"居中的最大内接矩形"**：框**不会被拖出这个区域，
 *      是 T4 的活**（T4 把拖动限制在内接区内，所以"用户怎么拖都不会裁出空白角"
 *      这句话最终才成立）。别看漏了这根接力棒。
 *    代价是"转完再去抠一个角"这一版做不了，写在 spec 的已知边界里。
 */
export type CropRect = { x: number; y: number; w: number; h: number }
export type CropSpec = {
  rect: CropRect
  angle: number
  /** 水平翻转（左右镜像）。不改尺寸，只改画出来的像素方向。 */
  flipH?: boolean
  /** 垂直翻转（上下镜像）。 */
  flipV?: boolean
}
export type CropGuide = 'off' | 'thirds' | 'golden' | 'diagonal'

/** 构图参考线循环：关 → 三分 → 黄金分割 → 对角线 → 关。 */
export function nextCropGuide(guide: CropGuide): CropGuide {
  return guide === 'off' ? 'thirds'
    : guide === 'thirds' ? 'golden'
      : guide === 'golden' ? 'diagonal'
        : 'off'
}
export const MAX_STRAIGHTEN = 15
/** 框的最小边长（归一化）：别让它缩成一条线。
 *  ★ 2026-10-06（T4）：**导出了** —— `ui/CropOverlay` 拖把手时要在内接区里
 *  再夹一道最小边，抄一个 0.02 过去就是同一个数有两个来源。 */
export const MIN_SIDE = 0.02

const rad = (deg: number) => (deg * Math.PI) / 180

/**
 * ⚠️ 浮点陷阱：90° 的 `cos` 不是 0，是 6.1e-17。照原样乘进去，
 *    `rotatedBounds(1000, 500, 90)` 会吐 500.00000000000006 —— 转个直角
 *    长宽居然没精确对调。规则上直角就该精确对调，所以在源头把
 *    贴近 0 / 1 的三角函数值拍成整数（**本产品里** 1e-12 以内的值只可能是
 *    "本该是直角/不转"；离整直角 ~5.7e-11° 以内的角也会落进这个窗口，无害）。
 */
const snap = (x: number) => (Math.abs(x) < 1e-12 ? 0 : Math.abs(x - 1) < 1e-12 ? 1 : x)

export function rotatedBounds(w: number, h: number, angleDeg: number): { w: number; h: number } {
  const c = snap(Math.abs(Math.cos(rad(angleDeg))))
  const s = snap(Math.abs(Math.sin(rad(angleDeg))))
  return { w: w * c + h * s, h: w * s + h * c }
}

/** 转 `angleDeg` 之后，**不碰空角**的最大轴对齐矩形（居中，单位像素）。 */
export function inscribedRect(w: number, h: number, angleDeg: number): { w: number; h: number } {
  const a = Math.abs(rad(angleDeg)) % Math.PI
  const side = a > Math.PI / 2 ? Math.PI - a : a
  const c = Math.abs(Math.cos(side))
  const s = Math.abs(Math.sin(side))
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  const widthIsLonger = w >= h
  // 窄长条 + 大角度：内接矩形会退化成"贴住短边"的那一支（经典解的第一种情形）
  if (short <= 2 * s * c * long || Math.abs(s - c) < 1e-10) {
    const x = 0.5 * short
    return widthIsLonger ? { w: x / s, h: x / c } : { w: x / c, h: x / s }
  }
  const cos2 = c * c - s * s
  // ⚠️ 别按"哪边更长"分两种情况 —— 这两个式子在 w↔h 互换下**自己会跟着对调**，
  //    再分情况就把每一张竖图的宽高转置了（评审抓的 Critical）：
  //    inscribedRect(800, 1200, 0) 本该是 {800, 1200}，转置了就吐 {1200, 800}，
  //    转 15° 时四角还会戳出照片 200px —— 正是"不许裁出空白角"要防的。
  return { w: (w * c - h * s) / cos2, h: (h * c - w * s) / cos2 }
}

/** 按比例档收（装得下为前提）。`null` = 自由，原样返回。 */
export function fitAspect(r: { w: number; h: number }, aspect: number | null): { w: number; h: number } {
  if (aspect === null) return r
  let w = r.w
  let h = w / aspect
  if (h > r.h) { h = r.h; w = h * aspect }
  return { w, h }
}

/** 居中的归一化矩形。 */
export function rectFromSize(size: { w: number; h: number }, bounds: { w: number; h: number }): CropRect {
  const w = size.w / bounds.w
  const h = size.h / bounds.h
  return clampRect({ x: (1 - w) / 2, y: (1 - h) / 2, w, h })
}

export function clampRect(r: CropRect): CropRect {
  const w = Math.min(1, Math.max(MIN_SIDE, r.w))
  const h = Math.min(1, Math.max(MIN_SIDE, r.h))
  const x = Math.min(1 - w, Math.max(0, r.x))
  const y = Math.min(1 - h, Math.max(0, r.y))
  return { x, y, w, h }
}

export function effectiveAngle(spec: CropSpec, turns: number): number {
  return turns * 90 + spec.angle
}

/**
 * 裁出来是多少像素。
 * ⚠️ **最后要扣一顶"不许放大"的帽子**：转 15 度时外框比原图大，框又几乎占满
 * 外框 —— 不扣的话输出会比原图还大（等于把用户的原图放大了一遍，白占空间还糊）。
 */
export function cropOutputSize(
  spec: CropSpec, turns: number, imgW: number, imgH: number,
): { width: number; height: number } {
  const b = rotatedBounds(imgW, imgH, effectiveAngle(spec, turns))
  let width = Math.round(spec.rect.w * b.w)
  let height = Math.round(spec.rect.h * b.h)
  const budget = imgW * imgH
  if (width * height > budget) {
    const k = Math.sqrt(budget / (width * height))
    width = Math.max(1, Math.floor(width * k))
    height = Math.max(1, Math.floor(height * k))
  }
  return { width: Math.max(1, width), height: Math.max(1, height) }
}
