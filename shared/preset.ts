import type { Adjustments } from './adjustments.ts'

/**
 * ★ 2026-10-10：「我的预设」—— 用户存下来的**一整套 75 个参数**。
 *
 * 它只含参数，**不含 Lut**（设计 §0）：滤镜是另一个资源（有自己的强度和删除语义）。
 * 上限 30 与 `MAX_LUTS` 对称（设计 §2.2）——也是"发给模型最多 30 个"那个数的出处。
 */
export const MAX_PRESETS = 30
export const MAX_PRESET_NAME = 30

/** 预设的名字要 1–30 个字符（和 `lutNameOk` 同一把尺子）。 */
export function presetNameOk(name: string): boolean {
  return name.length >= 1 && name.length <= MAX_PRESET_NAME
}

/** 对号用：trim + 忽略大小写（和 `sameLutName` 同一把尺子）。 */
export function samePresetName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** 服务端回给前端的元数据（params 随列表一起回，没有单独的详情路由）。 */
export type PresetMeta = {
  id: number
  name: string
  params: Adjustments
  createdAt: number
}
