/**
 * 相机实时取景的像素级辅助显示，直接作用在 RGBA 像素副本上。
 *
 * - 对焦峰值：亮度横向 / 纵向梯度超过阈值的位置涂红。
 * - 斑马纹：亮度达到阈值的位置画成白色斜条，提醒可能过曝。
 * - 伪色：把亮度映射成曝光区间色，便于判断中间调和高光余量。
 *
 * 两者都返回改动像素数，0 表示这一帧不需要额外覆盖。
 */
const luma = (r: number, g: number, b: number) =>
  0.2126 * r + 0.7152 * g + 0.0722 * b

export function paintFocusPeaking(
  data: Uint8ClampedArray, w: number, h: number, threshold = 48,
): number {
  if (w < 3 || h < 3 || data.length !== w * h * 4) return 0
  const gray = new Float32Array(w * h)
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    gray[p] = luma(data[i]!, data[i + 1]!, data[i + 2]!)
  }
  let changed = 0
  const t = Math.max(1, threshold)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      const gx = Math.abs(gray[p + 1]! - gray[p - 1]!)
      const gy = Math.abs(gray[p + w]! - gray[p - w]!)
      if (gx + gy < t) continue
      const i = p * 4
      data[i] = 255
      data[i + 1] = 44
      data[i + 2] = 44
      data[i + 3] = 255
      changed++
    }
  }
  return changed
}

export function paintZebra(
  data: Uint8ClampedArray, w: number, h: number, threshold = 240,
): number {
  if (w <= 0 || h <= 0 || data.length !== w * h * 4) return 0
  let changed = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x % 4 >= 2) continue
      const i = (y * w + x) * 4
      if (luma(data[i]!, data[i + 1]!, data[i + 2]!) < threshold) continue
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      changed++
    }
  }
  return changed
}

/**
 * 伪色曝光：蓝 → 青 → 绿 → 中性灰 → 黄 → 橙 → 品红。
 * 颜色以 82% 覆盖原图，保留一点原始明暗结构，不把画面完全涂死。
 */
export function paintFalseColor(data: Uint8ClampedArray, w: number, h: number): number {
  if (w <= 0 || h <= 0 || data.length !== w * h * 4) return 0
  const zones: [number, [number, number, number]][] = [
    [24, [38, 54, 255]],
    [64, [0, 205, 220]],
    [112, [32, 190, 90]],
    [176, [150, 150, 150]],
    [224, [255, 220, 64]],
    [248, [255, 112, 40]],
    [255, [255, 48, 210]],
  ]
  for (let i = 0; i < data.length; i += 4) {
    const light = luma(data[i]!, data[i + 1]!, data[i + 2]!)
    const zone = zones.find(([limit]) => light <= limit)?.[1] ?? zones[zones.length - 1]![1]
    data[i] = Math.round(data[i]! * 0.18 + zone[0] * 0.82)
    data[i + 1] = Math.round(data[i + 1]! * 0.18 + zone[1] * 0.82)
    data[i + 2] = Math.round(data[i + 2]! * 0.18 + zone[2] * 0.82)
    data[i + 3] = 255
  }
  return w * h
}

/** 实时取景放大：返回原图里要画到画布上的裁切区域。 */
export function liveZoomCrop(
  width: number, height: number, zoom: number,
  focusX = 0.5, focusY = 0.5,
): { x: number; y: number; w: number; h: number } {
  const imageW = Math.max(1, Math.round(width))
  const imageH = Math.max(1, Math.round(height))
  const z = Math.max(1, Math.min(8, Number.isFinite(zoom) ? zoom : 1))
  const w = Math.max(1, Math.round(imageW / z))
  const h = Math.max(1, Math.round(imageH / z))
  const x = Math.max(0, Math.min(
    imageW - w,
    Math.round(Math.max(0, Math.min(1, focusX)) * imageW - w / 2),
  ))
  const y = Math.max(0, Math.min(
    imageH - h,
    Math.round(Math.max(0, Math.min(1, focusY)) * imageH - h / 2),
  ))
  return { x, y, w, h }
}

/**
 * 100% 对焦放大镜的取景区域：在实时取景原生像素上截一块不超过
 * 320×200 的中心区域，再按同样大小画到放大镜画布。这样放大镜里
 * 一个源像素对应一个画布像素，不是把整帧再平滑拉大。
 */
export function liveLoupeCrop(
  width: number, height: number, focusX = 0.5, focusY = 0.5,
  maxWidth = 320, maxHeight = 200,
): { x: number; y: number; w: number; h: number } {
  const imageW = Math.max(1, Math.round(width))
  const imageH = Math.max(1, Math.round(height))
  const mw = Math.max(1, Math.round(maxWidth))
  const mh = Math.max(1, Math.round(maxHeight))
  const zoom = Math.max(1, imageW / mw, imageH / mh)
  const w = Math.max(1, Math.min(imageW, Math.round(imageW / zoom)))
  const h = Math.max(1, Math.min(imageH, Math.round(imageH / zoom)))
  const x = Math.max(0, Math.min(
    imageW - w,
    Math.round(Math.max(0, Math.min(1, focusX)) * imageW - w / 2),
  ))
  const y = Math.max(0, Math.min(
    imageH - h,
    Math.round(Math.max(0, Math.min(1, focusY)) * imageH - h / 2),
  ))
  return { x, y, w, h }
}
