// ⚠️ 自动生成 —— 勿改。改源头（scripts/sync-mini-shared.mjs 的 FILES 表）后重跑脚本。
/** 送给模型的图长边上限（spec §4.4）。调色路径不受此限制。 */
export const MAX_DIMENSION = 2048

/** API 硬约束：宽高必须是 32 的倍数，且在 [512, 4096]（spec §4.3） */
export const SIZE_MIN = 512
export const SIZE_MAX = 4096
const SIZE_STEP = 32

export type Size = { width: number; height: number }

export function align32(n: number): number {
  const rounded = Math.round(n / SIZE_STEP) * SIZE_STEP
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, rounded))
}

/** 等比缩放到长边不超过 max。只缩不放。 */
export function fitWithin(w: number, h: number, max: number): Size {
  const longest = Math.max(w, h)
  if (longest <= max) return { width: w, height: h }
  const k = max / longest
  return { width: Math.round(w * k), height: Math.round(h * k) }
}

/** 宽高比是否在 API 允许范围（<= 3:1）内。 */
export function aspectOk(w: number, h: number): boolean {
  return Math.max(w, h) / Math.min(w, h) <= 3
}

/**
 * 尺寸是否满足 API 的全部硬约束：32 的倍数、[512,4096]、宽高比 <= 3:1。
 * 返回不合规的原因，合规时返回 null。
 */
export function checkModelSize(w: number, h: number): string | null {
  if (!Number.isInteger(w) || !Number.isInteger(h)) return '宽高必须是整数'
  if (w % SIZE_STEP !== 0 || h % SIZE_STEP !== 0) return `宽高必须是 ${SIZE_STEP} 的倍数`
  if (w < SIZE_MIN || h < SIZE_MIN) return `宽高不能小于 ${SIZE_MIN}`
  if (w > SIZE_MAX || h > SIZE_MAX) return `宽高不能大于 ${SIZE_MAX}`
  if (!aspectOk(w, h)) return '宽高比不能超过 3:1'
  return null
}
