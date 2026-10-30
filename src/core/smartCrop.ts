/**
 * 主体感知构图的纯几何。
 *
 * `subjectBoundsFromCoverage` 只回答“主体落在原图哪里”；`smartCropRect`
 * 把主体中心换算到裁剪外框的坐标里，在不放大、不越界的前提下把现有裁剪框
 * 移过去。像素检测在 `image/smartCrop.ts`，这里不碰 DOM。
 */
import { rotatedBounds, type CropRect } from './crop'

export type SubjectBounds = {
  x0: number
  y0: number
  x1: number
  y1: number
  count: number
  ratio: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * 从**主体覆盖率**（0 = 不是主体，255 = 确定是主体）算归一化外接框。
 * 默认只认过半覆盖，避免软边和背景噪点把框撑大。
 */
export function subjectBoundsFromCoverage(
  coverage: Uint8Array, width: number, height: number, threshold = 128,
): SubjectBounds | null {
  if (coverage.length !== width * height) {
    throw new Error(`主体覆盖率尺寸和照片对不上（覆盖率 ${coverage.length} 字节，照片 ${width}×${height}）`)
  }
  let x0 = width
  let y0 = height
  let x1 = 0
  let y1 = 0
  let count = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (coverage[y * width + x]! < threshold) continue
      count++
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x + 1 > x1) x1 = x + 1
      if (y + 1 > y1) y1 = y + 1
    }
  }
  if (!count) return null
  return {
    x0: x0 / width,
    y0: y0 / height,
    x1: x1 / width,
    y1: y1 / height,
    count,
    ratio: count / (width * height),
  }
}

/**
 * 保持当前裁剪框的大小，把它平移到主体中心。
 *
 * 主体中心先按旋转约定换算到旋转外框坐标（和 `image/crop.ts` 的输出一致），
 * 然后夹进 `inner`。主体过大或靠近边缘时，框只移动到能到的最远处，既不会
 * 裁出空角，也不会为了“居中”把主体中心露在框外。
 */
export function smartCropRect(
  current: CropRect,
  inner: CropRect,
  imageWidth: number,
  imageHeight: number,
  angleDeg: number,
  subject: Pick<SubjectBounds, 'x0' | 'y0' | 'x1' | 'y1'>,
): CropRect {
  const bounds = rotatedBounds(imageWidth, imageHeight, angleDeg)
  const sx = ((subject.x0 + subject.x1) / 2) * imageWidth - imageWidth / 2
  const sy = ((subject.y0 + subject.y1) / 2) * imageHeight - imageHeight / 2
  const a = angleDeg * Math.PI / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  // 与 cropToBitmap 的 rotate(-angle) 同向：原图点 → 旋转外框。
  const rx = sx * c + sy * s
  const ry = -sx * s + sy * c
  const subjectX = (rx + bounds.w / 2) / bounds.w
  const subjectY = (ry + bounds.h / 2) / bounds.h

  const x = clamp(
    subjectX - current.w / 2,
    inner.x,
    inner.x + Math.max(0, inner.w - current.w),
  )
  const y = clamp(
    subjectY - current.h / 2,
    inner.y,
    inner.y + Math.max(0, inner.h - current.h),
  )

  if (Math.abs(x - current.x) < 1e-9 && Math.abs(y - current.y) < 1e-9) return current
  return { x, y, w: current.w, h: current.h }
}

/**
 * 按目标比例取**最大可用裁切框**，再把它平移到主体中心。
 *
 * 和 `smartCropRect` 的区别：那条路保持用户已经拖好的框大小不动；批量统一
 * 画幅时还没有用户框，所以这里先按比例取最大内接矩形，再只移动位置。
 * 结果以原图像素为单位，调用方除以宽高即可交给 `cropToBitmap`。
 */
export function smartCropRectForAspect(
  width: number,
  height: number,
  ratio: number,
  subject: Pick<SubjectBounds, 'x0' | 'y0' | 'x1' | 'y1'>,
): { x: number; y: number; w: number; h: number } {
  if (width <= 0 || height <= 0 || !Number.isFinite(ratio) || ratio <= 0) {
    return { x: 0, y: 0, w: Math.max(1, width), h: Math.max(1, height) }
  }
  let w = width
  let h = height
  if (width / height > ratio) w = height * ratio
  else h = width / ratio
  w = Math.max(1, Math.round(w))
  h = Math.max(1, Math.round(h))

  const cx = ((subject.x0 + subject.x1) / 2) * width
  const cy = ((subject.y0 + subject.y1) / 2) * height
  const x = clamp(Math.round(cx - w / 2), 0, Math.max(0, width - w))
  const y = clamp(Math.round(cy - h / 2), 0, Math.max(0, height - h))
  return { x, y, w, h }
}
