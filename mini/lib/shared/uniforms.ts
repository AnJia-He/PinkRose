// ⚠️ 自动生成 —— 勿改。改源头（scripts/sync-mini-shared.mjs 的 FILES 表）后重跑脚本。
import {
  CURVE_KEYS, HSL_KEYS, RGB_CURVE_KEYS, toUnit, type Adjustments,
} from './adjustments'

/**
 * 「94 个参数 + HSL / 曲线总开关 → 97 个 uniform 名字」的**唯一一份**映射：web 管线与小程序版
 * 管线共用同一份（本文件会被 `scripts/sync-mini-shared.mjs` 原样拷进小程序，
 * 两边各写一份一定会漂）。
 *
 * ⚠️ 正因如此，这里**不许 import 任何平台东西**：不碰 DOM、不碰 gl，
 * 只依赖 `shared/adjustments.ts`。
 */
export const UNIFORM_NAMES = [
  'uExposure', 'uContrast', 'uHighlights', 'uShadows', 'uWhites', 'uBlacks',
  'uSaturation', 'uTemperature', 'uTint',
  'uBwAmount', 'uBwRed', 'uBwGreen', 'uBwBlue', 'uClarity', 'uVignette',
  'uVibrance', 'uCbCyanRed', 'uCbMagentaGreen', 'uCbYellowBlue',
  'uSplitHiHue', 'uSplitLoHue', 'uSplitAmount',
  'uSplitMidHue', 'uSplitMidAmount', 'uSplitBalance',
  'uSkinSmooth', 'uDehaze', 'uHdr', 'uGlow',
  'uTexture', 'uSharpen', 'uSharpenRadius', 'uSharpenMasking',
  'uNoiseReduction', 'uColorNoiseReduction', 'uGrain',
  'uHslRedHue', 'uHslRedSat', 'uHslRedLum',
  'uHslOrangeHue', 'uHslOrangeSat', 'uHslOrangeLum',
  'uHslYellowHue', 'uHslYellowSat', 'uHslYellowLum',
  'uHslGreenHue', 'uHslGreenSat', 'uHslGreenLum',
  'uHslCyanHue', 'uHslCyanSat', 'uHslCyanLum',
  'uHslBlueHue', 'uHslBlueSat', 'uHslBlueLum',
  'uHslPurpleHue', 'uHslPurpleSat', 'uHslPurpleLum',
  'uHslMagentaHue', 'uHslMagentaSat', 'uHslMagentaLum',
  'uHslOn',
  'uCurveBlack', 'uCurveShadows', 'uCurveMidtones', 'uCurveHighlights', 'uCurveWhite',
  'uCurveOn', 'uCurveRgbOn',
  'uCurveRedBlack', 'uCurveRedShadows', 'uCurveRedMidtones', 'uCurveRedHighlights', 'uCurveRedWhite',
  'uCurveGreenBlack', 'uCurveGreenShadows', 'uCurveGreenMidtones', 'uCurveGreenHighlights', 'uCurveGreenWhite',
  'uCurveBlueBlack', 'uCurveBlueShadows', 'uCurveBlueMidtones', 'uCurveBlueHighlights', 'uCurveBlueWhite',
  'uSkinBrighten', 'uSkinRosy',
  'uPerspectiveV', 'uPerspectiveH',
  'uLensBlur', 'uLensRange', 'uLensFeather', 'uLensFocusX', 'uLensFocusY',
  'uLensShape', 'uLensAngle',
  'uLensDistortion', 'uLensChromatic', 'uLensVignette',
] as const

export type UniformName = typeof UNIFORM_NAMES[number]

/**
 * 入参是 `[-100, 100]` 的原始参数，不是 `[-1, 1]` 的 Unit：
 * 两者结构相同，传错了（比如 exposure: 100）类型也过，但画面会算成 2^100。
 * `toUnit`（「原始 → Unit」的唯一换算入口）只在这里调一次。
 */
export function uniformValues(a: Adjustments): Record<UniformName, number> {
  const u = toUnit(a)
  return {
    uExposure: u.exposure, uContrast: u.contrast, uHighlights: u.highlights,
    uShadows: u.shadows, uWhites: u.whites, uBlacks: u.blacks,
    uSaturation: u.saturation, uTemperature: u.temperature, uTint: u.tint,
    uBwAmount: u.bwAmount, uBwRed: u.bwRed, uBwGreen: u.bwGreen, uBwBlue: u.bwBlue,
    uClarity: u.clarity, uVignette: u.vignette, uVibrance: u.vibrance,
    uCbCyanRed: u.cbCyanRed, uCbMagentaGreen: u.cbMagentaGreen, uCbYellowBlue: u.cbYellowBlue,
    uSplitHiHue: u.splitHiHue, uSplitLoHue: u.splitLoHue, uSplitAmount: u.splitAmount,
    uSplitMidHue: u.splitMidHue, uSplitMidAmount: u.splitMidAmount,
    uSplitBalance: u.splitBalance,
    uSkinSmooth: u.skinSmooth,
    uDehaze: u.dehaze,
    uHdr: u.hdr,
    uGlow: u.glow,
    uTexture: u.texture,
    uSharpen: u.sharpen, uSharpenRadius: u.sharpenRadius,
    uSharpenMasking: u.sharpenMasking, uNoiseReduction: u.noiseReduction,
    uColorNoiseReduction: u.colorNoiseReduction, uGrain: u.grain,
    uHslRedHue: u.hslRedHue, uHslRedSat: u.hslRedSat, uHslRedLum: u.hslRedLum,
    uHslOrangeHue: u.hslOrangeHue, uHslOrangeSat: u.hslOrangeSat, uHslOrangeLum: u.hslOrangeLum,
    uHslYellowHue: u.hslYellowHue, uHslYellowSat: u.hslYellowSat, uHslYellowLum: u.hslYellowLum,
    uHslGreenHue: u.hslGreenHue, uHslGreenSat: u.hslGreenSat, uHslGreenLum: u.hslGreenLum,
    uHslCyanHue: u.hslCyanHue, uHslCyanSat: u.hslCyanSat, uHslCyanLum: u.hslCyanLum,
    uHslBlueHue: u.hslBlueHue, uHslBlueSat: u.hslBlueSat, uHslBlueLum: u.hslBlueLum,
    uHslPurpleHue: u.hslPurpleHue, uHslPurpleSat: u.hslPurpleSat, uHslPurpleLum: u.hslPurpleLum,
    uHslMagentaHue: u.hslMagentaHue, uHslMagentaSat: u.hslMagentaSat, uHslMagentaLum: u.hslMagentaLum,
    // 总开关：24 条全 0 时把整段 HSL 跳过，省掉 HSV 往返和 8 次色带权重。
    uHslOn: HSL_KEYS.some(k => u[k] !== 0) ? 1 : 0,
    uCurveBlack: u.curveBlack, uCurveShadows: u.curveShadows,
    uCurveMidtones: u.curveMidtones, uCurveHighlights: u.curveHighlights,
    uCurveWhite: u.curveWhite,
    // 总开关：五个控制点全 0 时整段曲线跳过，画面逐字节不变。
    uCurveOn: CURVE_KEYS.some(k => u[k] !== 0) ? 1 : 0,
    // 总开关：红 / 绿 / 蓝三组全 0 时整段 RGB 曲线跳过。
    uCurveRgbOn: RGB_CURVE_KEYS.some(k => u[k] !== 0) ? 1 : 0,
    uCurveRedBlack: u.curveRedBlack, uCurveRedShadows: u.curveRedShadows,
    uCurveRedMidtones: u.curveRedMidtones, uCurveRedHighlights: u.curveRedHighlights,
    uCurveRedWhite: u.curveRedWhite,
    uCurveGreenBlack: u.curveGreenBlack, uCurveGreenShadows: u.curveGreenShadows,
    uCurveGreenMidtones: u.curveGreenMidtones, uCurveGreenHighlights: u.curveGreenHighlights,
    uCurveGreenWhite: u.curveGreenWhite,
    uCurveBlueBlack: u.curveBlueBlack, uCurveBlueShadows: u.curveBlueShadows,
    uCurveBlueMidtones: u.curveBlueMidtones, uCurveBlueHighlights: u.curveBlueHighlights,
    uCurveBlueWhite: u.curveBlueWhite,
    uSkinBrighten: u.skinBrighten,
    uSkinRosy: u.skinRosy,
    uPerspectiveV: u.perspectiveV,
    uPerspectiveH: u.perspectiveH,
    uLensBlur: u.lensBlur,
    uLensRange: u.lensRange,
    uLensFeather: u.lensFeather,
    uLensFocusX: u.lensFocusX,
    uLensFocusY: u.lensFocusY,
    uLensShape: u.lensShape,
    uLensAngle: u.lensAngle,
    uLensDistortion: u.lensDistortion,
    uLensChromatic: u.lensChromatic,
    uLensVignette: u.lensVignette,
  }
}
