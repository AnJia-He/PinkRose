import type { Adjustments } from '../../shared/adjustments.ts'

export type Unit = Record<keyof Adjustments, number>
export type RGB = [number, number, number]

const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

export const luma = (r: number, g: number, b: number): number =>
  LUMA_R * r + LUMA_G * g + LUMA_B * b

/** sRGB -> 线性光。曝光/明暗运算必须在线性空间做，否则结果发灰。 */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/**
 * 六个「与像素位置无关」的参数依次作用在一个 sRGB 颜色上：
 * 色温 → 曝光 → 高光/阴影 → 对比度 → 饱和度。
 *
 * 另外两个参数**故意不在这里**：
 *   - 清晰度（clarity）需要邻域像素的模糊值
 *   - 暗角（vignette）需要像素在画面中的坐标
 * 单像素函数表达不了它们，两者只在 render/shader.ts 里做全图版本。
 *
 * 本函数的运算顺序与 render/shader.ts 的 GLSL 实现严格一致，
 * 改一边必须同步改另一边。
 */
export function applyTone(rgb: RGB, u: Unit): RGB {
  let [r, g, b] = rgb

  // 1. 色温：暖 = 抬红压蓝（sRGB 空间近似，够用且可预测）
  r += u.temperature * 0.10
  b -= u.temperature * 0.10

  // 2. 曝光：线性空间乘 2^ev
  r = srgbToLinear(r); g = srgbToLinear(g); b = srgbToLinear(b)
  const ev = Math.pow(2, u.exposure)
  r *= ev; g *= ev; b *= ev
  r = linearToSrgb(r); g = linearToSrgb(g); b = linearToSrgb(b)

  // 3. 高光 / 阴影：按亮度加权，再乘上各自**剩余的余量**，系数取 1.0。
  //
  //    余量因子 (1 - l) / l 不是装饰，没有它会毁掉两端细节：
  //    高光 +100 时所有 luma ≳ 0.79 的像素会被推过 1.0 再被末步 clamp 削平
  //    （0.79 → 1.0，0.85 → 1.0），高光梯度整个消失——亮天空/雪地/海滩
  //    正好是旅游照的典型场景；阴影 -100 同理把 luma ≲ 0.15 压成纯黑。
  //
  //    系数为什么恰好是 1.0：增益 = smoothstep(...) * C * (1 - l)，而
  //    smoothstep ≤ 1，所以增益 ≤ C * (1 - l)；C = 1.0 时
  //    l + 增益 ≤ l + (1 - l) = 1，**数学上永不越界**——即刚好用满剩余余量
  //    又不穿过端点。C > 1 会重新开始削平（C = 2 时 0.85 又变回 1.0），
  //    C 太小则滑块拉满也几乎看不出效果（0.35 时最大增益只有 0.045）。
  //    取 1.0 时最大增益约 0.13（luma ≈ 0.79 处），幅度可感知且梯度完好。
  const l = luma(r, g, b)
  const hiW = smoothstep(0.5, 1.0, l) * 1.0 * u.highlights * (1 - l)
  const loW = (1 - smoothstep(0.0, 0.5, l)) * 1.0 * u.shadows * l
  r += hiW + loW; g += hiW + loW; b += hiW + loW

  // 4. 对比度：围绕中灰支点
  const cScale = 1 + u.contrast
  r = (r - 0.5) * cScale + 0.5
  g = (g - 0.5) * cScale + 0.5
  b = (b - 0.5) * cScale + 0.5

  // 5. 饱和度：朝亮度灰点插值
  const l2 = luma(r, g, b)
  const sat = 1 + u.saturation
  r = l2 + (r - l2) * sat
  g = l2 + (g - l2) * sat
  b = l2 + (b - l2) * sat

  return [clamp01(r), clamp01(g), clamp01(b)]
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}
