import type { Adjustments } from '../../shared/adjustments.ts'
import { luma } from './tone.ts'

/**
 * 白平衡吸管（★ 2026-10-17）—— 把用户点中的一块中性色换算成两条白平衡轴。
 *
 * 不在 `src/image/`：这里只做**纯算式**，真正读像素在 `image/sample.ts`。
 * 返回的是绝对参数，调用方盖在现有参数上；不碰曝光 / 对比度等其它设置。
 *
 * 色温负责红↔蓝，单独的「色调」负责绿↔洋红。色调系数按亮度权重配平，
 * 避免只推绿通道把整块画面带亮 / 带暗；色彩平衡三轴不再被吸管借用。
 */
export type WhiteBalance = Pick<
  Adjustments,
  'temperature' | 'tint'
>

export type Rgb255 = readonly [number, number, number]

const clampParam = (v: number) => Math.max(-100, Math.min(100, Math.round(v)))

/**
 * 返回 null 的情况：太黑 / 太白 / 颜色太重。
 *
 * 这三种取样都不该拿来做白平衡：暗部有噪点、亮部已经削顶、彩色区域本来就不是
 * 中性色。与其给一组看起来很专业的错数字，不如让界面请用户换一块灰的再点。
 */
export function whiteBalanceFromSample(rgb: Rgb255): WhiteBalance | null {
  const [r255, g255, b255] = rgb
  if (![r255, g255, b255].every(Number.isFinite)) return null
  const r = Math.max(0, Math.min(1, r255 / 255))
  const g = Math.max(0, Math.min(1, g255 / 255))
  const b = Math.max(0, Math.min(1, b255 / 255))
  const brightness = luma(r, g, b)
  const chroma = Math.max(r, g, b) - Math.min(r, g, b)
  if (brightness < 0.08 || brightness > 0.97 || chroma > 0.35) return null

  // shader: r += t*0.10, b -= t*0.10；先求让 r/b 相等所需的 t。
  const temperature = clampParam(500 * (b - r))
  // shader: 红/蓝各加 tint*0.09，绿减 tint*0.035；这组系数按亮度权重配平。
  // 先用色温把红蓝拉平，再用色调把绿拉回红蓝的中点。
  const tint = clampParam(400 * (2 * g - r - b))
  return {
    temperature,
    tint,
  }
}

/** 测试 / 文档用的通道模拟：与 shader 的 1 / 1.5 步完全同一条算式。 */
export function applyWhiteBalanceChannels(
  rgb: Rgb255, wb: WhiteBalance,
): [number, number, number] {
  const t = wb.temperature / 100
  const tint = wb.tint / 100
  return [
    rgb[0] / 255 + t * 0.10 + tint * 0.09,
    rgb[1] / 255 - tint * 0.035,
    rgb[2] / 255 - t * 0.10 + tint * 0.09,
  ]
}
