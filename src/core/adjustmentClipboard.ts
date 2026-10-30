import {
  clampAdjustments, type Adjustments,
} from '../../shared/adjustments.ts'
import { normalizeLutRef, type LutRef } from '../../shared/lut.ts'

/**
 * 调色剪贴板：在不命名预设的情况下，把「这一套调色」快速带到另一张照片。
 * 只存参数和滤镜引用，不存像素；版本号让老数据 / 坏数据可以安全退回。
 */
export type AdjustmentClipboard = {
  version: 1
  params: Adjustments
  lut: LutRef | null
}

export const ADJUSTMENT_CLIPBOARD_KEY = 'pinkrose.adjustments.clipboard'

export function makeAdjustmentClipboard(
  params: Adjustments, lut: LutRef | null,
): AdjustmentClipboard {
  return {
    version: 1,
    params: clampAdjustments(params),
    lut: normalizeLutRef(lut),
  }
}

export function encodeAdjustmentClipboard(value: AdjustmentClipboard): string {
  return JSON.stringify(value)
}

export function decodeAdjustmentClipboard(raw: string | null): AdjustmentClipboard | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const o = parsed as Record<string, unknown>
    if (o.version !== 1) return null
    if (!o.params || typeof o.params !== 'object' || Array.isArray(o.params)) return null
    return makeAdjustmentClipboard(o.params as Adjustments, normalizeLutRef(o.lut))
  } catch {
    return null
  }
}
