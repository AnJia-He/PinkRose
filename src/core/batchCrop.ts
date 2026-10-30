/**
 * 批量逐张取景的归一化裁切框（★ 2026-10-19）。
 *
 * 为什么单独一层：
 *   · 统一画幅原来是"居中 / 智能主体"二选一，摄影师遇到主体不在中线、
 *     或者想故意留白时没有第三种选择；
 *   · 逐张取景要同时服务预览（DOM 百分比）和像素层（cropToBitmap），
 *     两边用同一个归一化坐标，避免"预览框和成片差几像素"这类无法解释的偏位。
 *
 * 坐标约定：x / y / w / h 都是相对**转向后**照片的 0~1 归一化值。
 * 角度、翻转在像素层先做，之后才按这组坐标裁切。
 */
export type BatchCropRect = {
  x: number
  y: number
  w: number
  h: number
}

const MIN_SIDE = 0.02

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 把任意来源的取景框收回合法范围；坏数据不把整批处理带崩。 */
export function clampBatchCrop(rect: BatchCropRect): BatchCropRect {
  const w = clamp(Number.isFinite(rect.w) ? rect.w : 1, MIN_SIDE, 1)
  const h = clamp(Number.isFinite(rect.h) ? rect.h : 1, MIN_SIDE, 1)
  const x = clamp(Number.isFinite(rect.x) ? rect.x : 0, 0, 1 - w)
  const y = clamp(Number.isFinite(rect.y) ? rect.y : 0, 0, 1 - h)
  return { x, y, w, h }
}

/**
 * 在归一化图里取目标宽高比的最大框。
 *
 * 注意宽高比是**像素宽高比**：归一化后照片不是正方形，所以不能直接拿
 * `w/h = ratio`；要乘回 `imageW/imageH` 才是像素比例。
 */
export function maxCropForAspect(
  imageW: number, imageH: number, ratio: number,
): BatchCropRect {
  if (!(imageW > 0) || !(imageH > 0) || !(ratio > 0)) {
    return { x: 0, y: 0, w: 1, h: 1 }
  }
  const photoRatio = imageW / imageH
  let w = 1
  let h = 1
  if (photoRatio > ratio) w = ratio / photoRatio
  else h = photoRatio / ratio
  return clampBatchCrop({
    x: (1 - w) / 2,
    y: (1 - h) / 2,
    w,
    h,
  })
}

/**
 * 以 (centerX, centerY) 为中心、按 zoom 缩小的目标比例框。
 * zoom = 1 是最大可用框，2 是宽高各缩一半；超出边界时整框平移回来。
 */
export function cropAtZoom(
  imageW: number, imageH: number, ratio: number,
  zoom: number, centerX = 0.5, centerY = 0.5,
): BatchCropRect {
  const max = maxCropForAspect(imageW, imageH, ratio)
  const k = clamp(Number.isFinite(zoom) ? zoom : 1, 1, 20)
  return moveCropTo({
    x: 0,
    y: 0,
    w: max.w / k,
    h: max.h / k,
  }, centerX, centerY)
}

/** 把框的中心移到指定点；只平移，不改大小。 */
export function moveCropTo(
  rect: BatchCropRect, centerX: number, centerY: number,
): BatchCropRect {
  const safe = clampBatchCrop(rect)
  const x = clamp(centerX - safe.w / 2, 0, 1 - safe.w)
  const y = clamp(centerY - safe.h / 2, 0, 1 - safe.h)
  return clampBatchCrop({ ...safe, x, y })
}

/** 拖动整框：dx / dy 是归一化位移。 */
export function moveCropBy(
  rect: BatchCropRect, dx: number, dy: number,
): BatchCropRect {
  const safe = clampBatchCrop(rect)
  return clampBatchCrop({
    ...safe,
    x: safe.x + (Number.isFinite(dx) ? dx : 0),
    y: safe.y + (Number.isFinite(dy) ? dy : 0),
  })
}

/** 当前框相当于最大框的放大倍数（100 = 最大范围）。 */
export function zoomOfCrop(
  imageW: number, imageH: number, ratio: number, rect: BatchCropRect,
): number {
  const max = maxCropForAspect(imageW, imageH, ratio)
  const safe = clampBatchCrop(rect)
  if (safe.w <= 0 || max.w <= 0) return 100
  return Math.round(100 * clamp(max.w / safe.w, 1, 20))
}

/** 归一化框 → 像素整数框；像素层至少留 1×1。 */
export function cropPixels(
  rect: BatchCropRect, imageW: number, imageH: number,
): { x: number; y: number; w: number; h: number } {
  const safe = clampBatchCrop(rect)
  const w = Math.max(1, Math.min(imageW, Math.round(safe.w * imageW)))
  const h = Math.max(1, Math.min(imageH, Math.round(safe.h * imageH)))
  return {
    x: Math.max(0, Math.min(imageW - w, Math.round(safe.x * imageW))),
    y: Math.max(0, Math.min(imageH - h, Math.round(safe.y * imageH))),
    w,
    h,
  }
}
