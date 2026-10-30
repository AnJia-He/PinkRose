import { ZERO, toUnit } from '../../shared/adjustments.ts'
import { makeCanvas } from '../core/canvas'
import { applyTone, type Unit } from '../core/tone'
import { maskBounds } from '../core/retouch'
import type {
  AegyoSalShadeId, ContourShadeId, EyelinerShadeId, EyeShadowShadeId, EyebrowShadeId,
  HairShadeId, HighlightShadeId, IrisShadeId, LocalAdjustOptions, ToneRange,
} from '../../shared/local.ts'

export type {
  AegyoSalShadeId, ContourShadeId, EyelinerShadeId, EyeShadowShadeId, EyebrowShadeId,
  HairShadeId, HighlightShadeId, IrisShadeId, LocalAdjustOptions, LocalEffect, ToneRange,
} from '../../shared/local.ts'

/**
 * **局部调整画笔的像素引擎**（★ 2026-10-17）。
 *
 * 先用 `ui/RetouchOverlay` 涂一张 0–255 的掩码，再只对掩码里的像素套一组
 * 与全局调色同源的曝光 / 对比度 / 饱和度 / 色温 / 色调 / 去雾，或牙齿 / 亮眼 / 红眼 /
 * 祛皱 / 黑眼圈 / 动感模糊等固定预设。
 * 它是 `baseEdit` 家族的一员：
 * 产出**新底图**，不往 `params` 里塞任何东西，账本记一笔、可撤销。
 *
 * ⚠️ 这一版是**烘焙**的局部调整（像 Snapseed 的局部）：应用后像素写进底图，
 *   不能再回来改这些值；要重新调就撤销这一笔再画。可回编辑的蒙版层是后续
 *   独立一轮（需要把蒙版和局部参数进会话 / 作品 schema）。
 * ⚠️ 和 `smoothPixels` / `spotHeal` 同一条：覆盖率为 0 的像素一个字节都不写。
 */
/**
 * 发色色板。发色不是"把整块涂成这个 RGB"——下面按原亮度缩放目标色，
 * 头发的暗部、发丝高光和体积感都保留；这里给的是中间调的颜色。
 */
export const HAIR_SHADES = [
  { id: 'natural', label: '自然黑', rgb: [40, 34, 31] },
  { id: 'brown', label: '深棕', rgb: [90, 57, 41] },
  { id: 'flaxen', label: '亚麻', rgb: [173, 137, 97] },
  { id: 'wine', label: '酒红', rgb: [112, 40, 48] },
  { id: 'blue', label: '雾蓝', rgb: [56, 70, 94] },
  { id: 'rose', label: '玫瑰金', rgb: [176, 104, 92] },
] as const satisfies readonly { id: HairShadeId; label: string; rgb: readonly [number, number, number] }[]

/** 眼影色板：比发色更轻、更透，按强度只染色不影响眼白和虹膜。 */
export const EYE_SHADOW_SHADES = [
  { id: 'earth', label: '大地棕', rgb: [132, 92, 68] },
  { id: 'coral', label: '珊瑚橘', rgb: [224, 132, 96] },
  { id: 'rose', label: '玫瑰粉', rgb: [214, 116, 142] },
  { id: 'violet', label: '紫罗兰', rgb: [142, 104, 184] },
  { id: 'blue', label: '雾蓝', rgb: [104, 138, 178] },
  { id: 'champagne', label: '香槟金', rgb: [216, 186, 132] },
] as const satisfies readonly {
  id: EyeShadowShadeId
  label: string
  rgb: readonly [number, number, number]
}[]

export const EYEBROW_SHADES = [
  { id: 'black', label: '自然黑', rgb: [52, 44, 40] },
  { id: 'brown', label: '深棕', rgb: [92, 62, 44] },
  { id: 'ash', label: '灰棕', rgb: [112, 98, 88] },
  { id: 'auburn', label: '红棕', rgb: [124, 72, 52] },
] as const satisfies readonly {
  id: EyebrowShadeId
  label: string
  rgb: readonly [number, number, number]
}[]

/** 修容阴影色板：都偏暗、偏灰，避免涂成一块脏橘。 */
export const CONTOUR_SHADES = [
  { id: 'cool', label: '冷棕', rgb: [100, 88, 84] },
  { id: 'warm', label: '暖棕', rgb: [124, 92, 72] },
  { id: 'ash', label: '灰棕', rgb: [106, 100, 96] },
] as const satisfies readonly {
  id: ContourShadeId
  label: string
  rgb: readonly [number, number, number]
}[]

/** 高光色板：偏暖或偏珍珠白，提亮同时带一点色相。 */
export const HIGHLIGHT_SHADES = [
  { id: 'champagne', label: '香槟', rgb: [246, 226, 190] },
  { id: 'pearl', label: '珍珠', rgb: [240, 236, 226] },
  { id: 'peach', label: '蜜桃', rgb: [248, 214, 190] },
] as const satisfies readonly {
  id: HighlightShadeId
  label: string
  rgb: readonly [number, number, number]
}[]

/** 卧蚕色板：偏亮的微暖色，负责眼下的一小条柔和提亮。 */
export const AEGYO_SAL_SHADES = [
  { id: 'pearl', label: '珍珠', rgb: [246, 238, 228] },
  { id: 'champagne', label: '香槟', rgb: [244, 218, 180] },
  { id: 'peach', label: '蜜桃', rgb: [248, 206, 184] },
] as const satisfies readonly {
  id: AegyoSalShadeId
  label: string
  rgb: readonly [number, number, number]
}[]

/** 眼线色板：都足够深，但保留棕 / 灰两种日常选择。 */
export const EYELINER_SHADES = [
  { id: 'black', label: '自然黑', rgb: [24, 20, 20] },
  { id: 'brown', label: '深棕', rgb: [68, 44, 34] },
  { id: 'charcoal', label: '炭灰', rgb: [50, 48, 50] },
] as const satisfies readonly {
  id: EyelinerShadeId
  label: string
  rgb: readonly [number, number, number]
}[]

/** 美瞳色板：都按原虹膜明暗缩放，保留放射纹理和高光。 */
export const IRIS_SHADES = [
  { id: 'brown', label: '暖棕', rgb: [116, 78, 52] },
  { id: 'gray', label: '冷灰', rgb: [104, 108, 112] },
  { id: 'blue', label: '冰蓝', rgb: [66, 118, 154] },
  { id: 'green', label: '橄榄绿', rgb: [72, 116, 76] },
  { id: 'violet', label: '紫罗兰', rgb: [112, 82, 138] },
  { id: 'amber', label: '琥珀', rgb: [154, 108, 48] },
] as const satisfies readonly {
  id: IrisShadeId
  label: string
  rgb: readonly [number, number, number]
}[]

const ZERO_UNIT: Unit = toUnit(ZERO)
const clamp = (v: number, min = -100, max = 100) =>
  Math.max(min, Math.min(max, Number.isFinite(v) ? v : 0))

type Bounds = ReturnType<typeof maskBounds>

/** 只对掩码覆盖到的像素做可分离盒式模糊；颜色从操作前的副本取。 */
function blurMasked(
  data: Uint8ClampedArray, width: number, height: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
  radiusOverride?: number,
): void {
  const radius = Math.max(1, Math.round(radiusOverride ?? (1 + strength * 4)))
  const x0 = Math.max(0, bounds.x0 - radius)
  const y0 = Math.max(0, bounds.y0 - radius)
  const x1 = Math.min(width, bounds.x1 + radius)
  const y1 = Math.min(height, bounds.y1 + radius)
  const ww = x1 - x0
  const wh = y1 - y0
  const n = ww * wh
  const src = new Uint8ClampedArray(data.length)
  src.set(data)
  const tmp = new Float32Array(n)
  const blurred = new Float32Array(n)
  const win = radius * 2 + 1

  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < wh; y++) {
      let sum = 0
      const row = (y0 + y) * width
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.max(0, Math.min(ww - 1, k))
        sum += src[row * 4 + (x0 + xx) * 4 + c]!
      }
      for (let x = 0; x < ww; x++) {
        tmp[y * ww + x] = sum / win
        const outX = Math.max(0, Math.min(ww - 1, x - radius))
        const inX = Math.max(0, Math.min(ww - 1, x + radius + 1))
        sum -= src[row * 4 + (x0 + outX) * 4 + c]!
        sum += src[row * 4 + (x0 + inX) * 4 + c]!
      }
    }
    for (let x = 0; x < ww; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.max(0, Math.min(wh - 1, k))
        sum += tmp[yy * ww + x]!
      }
      for (let y = 0; y < wh; y++) {
        blurred[y * ww + x] = sum / win
        const outY = Math.max(0, Math.min(wh - 1, y - radius))
        const inY = Math.max(0, Math.min(wh - 1, y + radius + 1))
        sum -= tmp[outY * ww + x]!
        sum += tmp[inY * ww + x]!
      }
    }
    for (let y = bounds.y0; y < bounds.y1; y++) {
      for (let x = bounds.x0; x < bounds.x1; x++) {
        const mi = y * width + x
        const cov = coverage[mi]! / 255 * strength
        if (cov <= 0) continue
        const i = mi * 4
        const p = (y - y0) * ww + (x - x0)
        data[i + c] = Math.round(data[i + c]! + (blurred[p]! - data[i + c]!) * cov)
      }
    }
  }
}

/**
 * 动感模糊：沿一个方向对掩码内像素做多次采样平均。
 * 0° = 水平、90° = 垂直；半径随强度增长。颜色从操作前的副本取，
 * 避免一次模糊里后面的像素吃到前面刚写进去的结果。
 */
function motionBlurMasked(
  data: Uint8ClampedArray, width: number, height: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>,
  strength: number, angle: number,
): void {
  const radius = Math.max(1, Math.round(1 + strength * 24))
  const rad = ((angle % 360) + 360) % 360 * Math.PI / 180
  const dx = Math.cos(rad)
  const dy = Math.sin(rad)
  const taps = 15
  const src = new Uint8ClampedArray(data)

  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const mix = coverage[mi]! / 255
      if (mix <= 0) continue
      let r = 0
      let g = 0
      let b = 0
      for (let k = 0; k < taps; k++) {
        const t = (k / (taps - 1) - 0.5) * 2
        const sx = Math.max(0, Math.min(width - 1, x + dx * radius * t))
        const sy = Math.max(0, Math.min(height - 1, y + dy * radius * t))
        const x0 = Math.floor(sx)
        const y0 = Math.floor(sy)
        const x1 = Math.min(width - 1, x0 + 1)
        const y1 = Math.min(height - 1, y0 + 1)
        const fx = sx - x0
        const fy = sy - y0
        const w00 = (1 - fx) * (1 - fy)
        const w10 = fx * (1 - fy)
        const w01 = (1 - fx) * fy
        const w11 = fx * fy
        const i00 = (y0 * width + x0) * 4
        const i10 = (y0 * width + x1) * 4
        const i01 = (y1 * width + x0) * 4
        const i11 = (y1 * width + x1) * 4
        r += src[i00]! * w00 + src[i10]! * w10 + src[i01]! * w01 + src[i11]! * w11
        g += src[i00 + 1]! * w00 + src[i10 + 1]! * w10 + src[i01 + 1]! * w01 + src[i11 + 1]! * w11
        b += src[i00 + 2]! * w00 + src[i10 + 2]! * w10 + src[i01 + 2]! * w01 + src[i11 + 2]! * w11
      }
      const i = mi * 4
      data[i] = Math.round(data[i]! + (r / taps - data[i]!) * mix)
      data[i + 1] = Math.round(data[i + 1]! + (g / taps - data[i + 1]!) * mix)
      data[i + 2] = Math.round(data[i + 2]! + (b / taps - data[i + 2]!) * mix)
    }
  }
}

/** 可分离盒均值；和 `smooth.ts` 同一个写法，专给局部清晰度的亮度平面用。 */
function boxMeanPlane(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  const win = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let k = -r; k <= r; k++) sum += src[row + Math.max(0, Math.min(w - 1, k))]!
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win
      sum -= src[row + Math.max(0, Math.min(w - 1, x - r))]!
      sum += src[row + Math.max(0, Math.min(w - 1, x + r + 1))]!
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += tmp[Math.max(0, Math.min(h - 1, k)) * w + x]!
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win
      sum -= tmp[Math.max(0, Math.min(h - 1, y - r)) * w + x]!
      sum += tmp[Math.max(0, Math.min(h - 1, y + r + 1)) * w + x]!
    }
  }
  return out
}

/**
 * 局部清晰度：在选区里做亮度高通（原亮度 − 模糊亮度）再加回去。
 * 平坦区域 detail≈0，不动；边缘 / 纹理被拉开。颜色按亮度比例缩放，
 * 不额外偏色；蒙版外一个字节都不写。
 */
function clarityMasked(
  data: Uint8ClampedArray, width: number, height: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, amount: number,
): void {
  if (amount === 0) return
  const x0 = bounds.x0
  const y0 = bounds.y0
  const ww = Math.max(1, bounds.x1 - x0)
  const wh = Math.max(1, bounds.y1 - y0)
  const n = ww * wh
  const radius = Math.max(2, Math.min(16, Math.round(Math.min(width, height) * 0.004)))
  const L = new Float32Array(n)
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = ((y0 + y) * width + x0 + x) * 4
      L[y * ww + x] = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255
    }
  }
  const blurred = boxMeanPlane(L, ww, wh, radius)
  const k = amount / 100 * 0.9
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const mi = (y0 + y) * width + x0 + x
      const cov = coverage[mi]! / 255
      if (cov <= 0) continue
      const p = y * ww + x
      const l = L[p]!
      if (l <= 1e-5) continue
      const detail = l - blurred[p]!
      const target = Math.max(0, Math.min(1, l + detail * k))
      const scale = target / l
      const i = mi * 4
      data[i] = Math.round(data[i]! + (data[i]! * scale - data[i]!) * cov)
      data[i + 1] = Math.round(data[i + 1]! + (data[i + 1]! * scale - data[i + 1]!) * cov)
      data[i + 2] = Math.round(data[i + 2]! + (data[i + 2]! * scale - data[i + 2]!) * cov)
    }
  }
}

/** 5 个像素的暗通道；与 shader 的局部去雾估计保持同一取样形状。 */
function localDarkChannel(
  data: Uint8ClampedArray, width: number, height: number, x: number, y: number,
): number {
  let min = 255
  for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const xx = Math.max(0, Math.min(width - 1, x + dx))
    const yy = Math.max(0, Math.min(height - 1, y + dy))
    const i = (yy * width + xx) * 4
    min = Math.min(min, data[i]!, data[i + 1]!, data[i + 2]!)
  }
  return min / 255
}

/**
 * 祛皱：先把掩码内的小尺度明暗反差柔化，再按原始亮度给暗处一点提亮。
 * 只动用户涂过的地方；提亮按阴影权重走，避免整块皮肤发白发灰。
 */
function wrinkleMasked(
  data: Uint8ClampedArray, width: number, height: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
): void {
  const original = data.slice()
  blurMasked(data, width, height, coverage, bounds, strength * 0.72)
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255 * strength
      if (cov <= 0) continue
      const i = mi * 4
      const r = original[i]!
      const g = original[i + 1]!
      const b = original[i + 2]!
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const shadow = Math.max(0, Math.min(1, 1 - l / 180))
      const lift = 1 + 0.08 * strength * shadow
      for (let c = 0; c < 3; c++) {
        const softened = data[i + c]! * lift
        data[i + c] = Math.round(original[i + c]! + (softened - original[i + c]!) * cov)
      }
    }
  }
}

/**
 * 黑眼圈：先估一张“周围肤色”的亮度参考，再把掩码里明显低于参考的暗沉
 * 往上提，并压掉眼下常见的蓝紫偏色。
 *
 * 参考亮度用同一块掩码外扩后的可分离盒式模糊：这样深肤色不会被当成
 * “黑眼圈”整块提亮，只有**比周围更暗**的那一层阴影会动。纹理不糊——
 * 模糊只用来算参考，输出仍是原像素按比例提亮。
 */
function darkCircleMasked(
  data: Uint8ClampedArray, width: number, height: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
): void {
  const original = data.slice()
  const reference = data.slice()
  const span = Math.min(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0)
  // 参考半径要明显大于眼下阴影本身，才能读到周围的正常肤色；
  // 0.65 倍短边在小选区（自动眼下）和手动画的大区块上都够用。
  const radius = Math.max(3, Math.min(64, Math.round(span * 0.65)))
  blurMasked(reference, width, height, coverage, bounds, 1, radius)

  const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255 * strength
      if (cov <= 0) continue
      const i = mi * 4
      const r = original[i]!
      const g = original[i + 1]!
      const b = original[i + 2]!
      const l = luma(r, g, b)
      const lr = luma(reference[i]!, reference[i + 1]!, reference[i + 2]!)
      // 只处理“比周围肤色暗”的部分；2 级以内不碰，28 级以上全开。
      const gate = smooth01((lr - l - 2) / 26)
      if (gate <= 0) continue

      // 往参考亮度提，但只走 55%——保留一点自然的眼下阴影，避免拍平。
      const targetL = l + (lr - l) * 0.55
      const scale = l > 1 ? targetL / l : 1
      let nr = r * scale
      let ng = g * scale
      let nb = b * scale

      // 眼下暗沉常带蓝紫；把高于暖色平均值的蓝压回来，并给一点暖调。
      const warm = (nr + ng) / 2
      if (nb > warm) nb += (warm - nb) * 0.45
      nr *= 1.02

      data[i] = Math.round(r + (nr - r) * cov)
      data[i + 1] = Math.round(g + (ng - g) * cov)
      data[i + 2] = Math.round(b + (nb - b) * cov)
    }
  }
}

/**
 * 去反光：只压掩码里的高光。按亮度找镜面反光，越亮压得越多；
 * 低亮度像素完全不动，暗部纹理和整体色相保留。强度 0 时不会进这个函数。
 */
function antiGlareMasked(
  data: Uint8ClampedArray, width: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
): void {
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255
      if (cov <= 0) continue
      const i = mi * 4
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      // 0.55 以下当作正常亮部，不碰；往上平滑增加压缩量，最高约 35%。
      const gate = smooth01((l - 0.55) / 0.45)
      const scale = 1 - 0.35 * strength * gate
      if (scale >= 0.9999) continue
      data[i] = Math.round(r + (r * scale - r) * cov)
      data[i + 1] = Math.round(g + (g * scale - g) * cov)
      data[i + 2] = Math.round(b + (b * scale - b) * cov)
    }
  }
}

function smooth01(v: number): number {
  const t = Math.max(0, Math.min(1, v))
  return t * t * (3 - 2 * t)
}

/** 按亮度给减淡 / 加深分三档；边界用软过渡，避免画出硬分界。 */
function toneRangeWeight(l: number, range: ToneRange): number {
  const shadows = 1 - smooth01((l - 0.12) / 0.35)
  // 中间调留到接近高光才淡出；不然 70% 左右的亮部几乎得不到加深，
  // 修皮肤结构时会出现"画笔明明涂了却没反应"的空档。
  const highlights = smooth01((l - 0.72) / 0.23)
  if (range === 'shadows') return shadows
  if (range === 'highlights') return highlights
  return (1 - shadows) * (1 - highlights)
}

/**
 * 减淡 / 加深：沿亮度缩放 RGB，保留原有色相和色彩关系。
 * 和直接抬曝光不同，这一层只在指定亮度范围里动手，适合给五官 /
 * 环境光做局部明暗塑形；覆盖率为 0 的像素不写。
 */
function dodgeBurnMasked(
  data: Uint8ClampedArray, width: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>,
  strength: number, range: ToneRange, mode: 'dodge' | 'burn',
): void {
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255
      if (cov <= 0) continue
      const i = mi * 4
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      const rangeWeight = toneRangeWeight(l, range)
      const amount = cov * strength * rangeWeight
      if (amount <= 0) continue
      const target = mode === 'dodge'
        ? l + (1 - l) * 0.35 * amount
        : l * (1 - 0.35 * amount)
      if (mode === 'burn' && l <= 1e-5) continue
      if (mode === 'dodge' && l <= 1e-5) {
        const lift = Math.round(target * 255)
        data[i] = lift
        data[i + 1] = lift
        data[i + 2] = lift
        continue
      }
      const scale = target / l
      data[i] = Math.round(r * scale)
      data[i + 1] = Math.round(g * scale)
      data[i + 2] = Math.round(b * scale)
    }
  }
}

/** 马赛克按绝对像素网格切块；强度越大块越大，块色取操作前的平均色。 */
function mosaicMasked(
  data: Uint8ClampedArray, width: number, height: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
): void {
  const block = Math.max(3, Math.round(3 + strength * 21))
  const src = new Uint8ClampedArray(data.length)
  src.set(data)
  const bx0 = Math.floor(bounds.x0 / block) * block
  const by0 = Math.floor(bounds.y0 / block) * block
  for (let by = by0; by < bounds.y1; by += block) {
    for (let bx = bx0; bx < bounds.x1; bx += block) {
      const x0 = Math.max(0, bx)
      const y0 = Math.max(0, by)
      const x1 = Math.min(width, bx + block)
      const y1 = Math.min(height, by + block)
      if (x1 <= x0 || y1 <= y0) continue
      let r = 0, g = 0, b = 0, n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4
          r += src[i]!; g += src[i + 1]!; b += src[i + 2]!; n++
        }
      }
      if (n <= 0) continue
      const ar = r / n, ag = g / n, ab = b / n
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const mi = y * width + x
          const cov = coverage[mi]! / 255 * strength
          if (cov <= 0) continue
          const i = mi * 4
          data[i] = Math.round(data[i]! + (ar - data[i]!) * cov)
          data[i + 1] = Math.round(data[i + 1]! + (ag - data[i + 1]!) * cov)
          data[i + 2] = Math.round(data[i + 2]! + (ab - data[i + 2]!) * cov)
        }
      }
    }
  }
}

/** 按原亮度缩放目标发色：暗部仍暗、高光仍亮，发丝纹理不被糊掉。 */
function hairMasked(
  data: Uint8ClampedArray, width: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
  shade: readonly [number, number, number],
): void {
  const [tr, tg, tb] = shade
  const targetL = 0.2126 * tr + 0.7152 * tg + 0.0722 * tb
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255 * strength
      if (cov <= 0) continue
      const i = mi * 4
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
      // +10 是暗部保险：纯黑头发也能看出一点色相，不会"选了颜色还是黑的"。
      const scale = (l + 10) / (targetL + 10)
      const nr = tr * scale
      const ng = tg * scale
      const nb = tb * scale
      data[i] = Math.round(r + (nr - r) * cov)
      data[i + 1] = Math.round(g + (ng - g) * cov)
      data[i + 2] = Math.round(b + (nb - b) * cov)
    }
  }
}

/** 眼影：按原亮度缩放目标色，只混入 55%，保留眼皮纹理和高光。 */
function eyeShadowMasked(
  data: Uint8ClampedArray, width: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
  shade: readonly [number, number, number],
): void {
  const [tr, tg, tb] = shade
  const targetL = 0.2126 * tr + 0.7152 * tg + 0.0722 * tb
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255 * strength * 0.55
      if (cov <= 0) continue
      const i = mi * 4
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const scale = (l + 12) / (targetL + 12)
      data[i] = Math.round(r + (tr * scale - r) * cov)
      data[i + 1] = Math.round(g + (tg * scale - g) * cov)
      data[i + 2] = Math.round(b + (tb * scale - b) * cov)
    }
  }
}

/** 眉毛：按原亮度换色，混入 70%，保留毛流明暗。 */
function eyebrowMasked(
  data: Uint8ClampedArray, width: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
  shade: readonly [number, number, number],
): void {
  const [tr, tg, tb] = shade
  const targetL = 0.2126 * tr + 0.7152 * tg + 0.0722 * tb
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255 * strength * 0.7
      if (cov <= 0) continue
      const i = mi * 4
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const scale = (l + 10) / (targetL + 10)
      data[i] = Math.round(r + (tr * scale - r) * cov)
      data[i + 1] = Math.round(g + (tg * scale - g) * cov)
      data[i + 2] = Math.round(b + (tb * scale - b) * cov)
    }
  }
}

/**
 * 修容：按掩码把像素往阴影色压暗。目标色跟着原亮度走，鼻影 / 颧骨下方
 * 的纹理和高光保留；高光区和纯黑区不硬压，避免出现一块死灰。
 */
function contourMasked(
  data: Uint8ClampedArray, width: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
  shade: readonly [number, number, number],
): void {
  const [tr, tg, tb] = shade
  const targetL = 0.2126 * tr + 0.7152 * tg + 0.0722 * tb
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255 * strength
      if (cov <= 0) continue
      const i = mi * 4
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const l01 = l / 255
      // 中间调下手最稳；接近纯黑或高光时收一点，避免压出硬块。
      const gate = smooth01(l01 / 0.08) * (1 - smooth01((l01 - 0.88) / 0.12))
      const amount = 0.30 * cov * gate
      if (amount <= 0) continue
      const scale = (l + 12) / (targetL + 12)
      // 0.72 是"阴影色"的明度落点：保留原纹理，但确实压暗。
      const nr = r * (1 - amount) + tr * scale * amount * 0.72
      const ng = g * (1 - amount) + tg * scale * amount * 0.72
      const nb = b * (1 - amount) + tb * scale * amount * 0.72
      data[i] = Math.round(nr)
      data[i + 1] = Math.round(ng)
      data[i + 2] = Math.round(nb)
    }
  }
}

/**
 * 高光：往暖白方向提亮，蓝通道抬得少一点，避免鼻梁高光发青。
 * 已经接近纯白的位置不继续堆，保留原有高光层次。
 */
function highlightMasked(
  data: Uint8ClampedArray, width: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
  shade: readonly [number, number, number],
): void {
  const [tr, tg, tb] = shade
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255 * strength
      if (cov <= 0) continue
      const i = mi * 4
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const l01 = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      const gate = 1 - smooth01((l01 - 0.9) / 0.1)
      const amount = cov * gate
      if (amount <= 0) continue
      // 亮度抬升 + 少量色相偏移；不是整块刷白。
      const nr = r + (255 - r) * 0.22 * amount + (tr - 245) * 0.18 * amount
      const ng = g + (255 - g) * 0.18 * amount + (tg - 245) * 0.18 * amount
      const nb = b + (255 - b) * 0.12 * amount + (tb - 245) * 0.18 * amount
      data[i] = Math.round(nr)
      data[i + 1] = Math.round(ng)
      data[i + 2] = Math.round(nb)
    }
  }
}

/**
 * 卧蚕：在用户涂出的眼下窄条里做柔和提亮，并带一点暖色。
 * 越接近纯白的地方提得越少，避免把卧蚕画成一条死白；掩码边缘仍沿用
 * 画笔覆盖率，所以边界是渐进的，不会出现硬边。
 */
function aegyoSalMasked(
  data: Uint8ClampedArray, width: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
  shade: readonly [number, number, number],
): void {
  const [tr, tg, tb] = shade
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255 * strength
      if (cov <= 0) continue
      const i = mi * 4
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const l01 = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      // 已经接近纯白时收住，避免高光溢出成一整块。
      const gate = 1 - smooth01((l01 - 0.82) / 0.18)
      const amount = cov * gate
      if (amount <= 0) continue
      const lift = 0.20 * amount
      const tint = 0.08 * amount
      data[i] = Math.round(r + (255 - r) * lift + (tr - 240) * tint)
      data[i + 1] = Math.round(g + (255 - g) * lift + (tg - 240) * tint)
      data[i + 2] = Math.round(b + (255 - b) * lift + (tb - 240) * tint)
    }
  }
}

/**
 * 眼线：沿用户涂出的眼睑线压暗。目标色按原亮度缩放，睫毛和眼睑的
 * 明暗层次还留着；覆盖率决定浓淡，反复涂可以加深。
 */
function eyelinerMasked(
  data: Uint8ClampedArray, width: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
  shade: readonly [number, number, number],
): void {
  const [tr, tg, tb] = shade
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255 * strength
      if (cov <= 0) continue
      const i = mi * 4
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const l01 = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      // 原图越亮，目标色保留越多原亮度；原图本来很暗时只做轻微加深。
      const scale = 0.45 + 0.55 * l01
      const amount = cov * 0.72
      data[i] = Math.round(r + (tr * scale - r) * amount)
      data[i + 1] = Math.round(g + (tg * scale - g) * amount)
      data[i + 2] = Math.round(b + (tb * scale - b) * amount)
    }
  }
}

/**
 * 美瞳：在用户涂出的虹膜区域里换色。用亮度和饱和度门避开眼白与瞳孔：
 * 眼白太亮、太灰；瞳孔太暗。虹膜保留原来的放射纹理和中心高光。
 */
function irisMasked(
  data: Uint8ClampedArray, width: number,
  coverage: Uint8Array, bounds: NonNullable<Bounds>, strength: number,
  shade: readonly [number, number, number],
): void {
  const [tr, tg, tb] = shade
  const targetL = 0.2126 * tr + 0.7152 * tg + 0.0722 * tb
  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255 * strength
      if (cov <= 0) continue
      const i = mi * 4
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const l01 = l / 255
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      const sat = mx <= 1e-6 ? 0 : (mx - mn) / mx
      const gate = smooth01((l01 - 0.05) / 0.10)
        * (1 - smooth01((l01 - 0.68) / 0.12))
        * smooth01((sat - 0.04) / 0.12)
      if (gate <= 0) continue
      const amount = cov * gate * 0.68
      const scale = (l + 12) / (targetL + 12)
      data[i] = Math.round(r + (tr * scale - r) * amount)
      data[i + 1] = Math.round(g + (tg * scale - g) * amount)
      data[i + 2] = Math.round(b + (tb * scale - b) * amount)
    }
  }
}

/** 纯函数：按掩码局部调整，原地改 RGBA；返回 covered = 掩码非零像素数。 */
export function localAdjustPixels(
  data: Uint8ClampedArray, width: number, height: number,
  coverage: Uint8Array, opts: LocalAdjustOptions = {},
): { covered: number } {
  if (coverage.length !== width * height) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${coverage.length} 字节，照片 ${width}×${height}）`)
  }
  const bounds = maskBounds(coverage, width, height)
  if (!bounds) return { covered: 0 }

  const exposure = clamp(opts.exposure ?? 0)
  const contrast = clamp(opts.contrast ?? 0)
  const saturation = clamp(opts.saturation ?? 0)
  const temperature = clamp(opts.temperature ?? 0)
  const tint = clamp(opts.tint ?? 0)
  const whites = clamp(opts.whites ?? 0)
  const blacks = clamp(opts.blacks ?? 0)
  const dehaze = clamp(opts.dehaze ?? 0)
  const highlights = clamp(opts.highlights ?? 0)
  const shadows = clamp(opts.shadows ?? 0)
  const vibrance = clamp(opts.vibrance ?? 0)
  const clarity = clamp(opts.clarity ?? 0)
  const effect = opts.effect ?? 'tone'
  if (effect === 'tone'
    && exposure === 0 && contrast === 0 && saturation === 0 && temperature === 0
    && tint === 0 && whites === 0 && blacks === 0 && dehaze === 0
    && highlights === 0 && shadows === 0
    && vibrance === 0 && clarity === 0) {
    return { covered: bounds.count }
  }

  // 和全局调色共用 `applyTone`：这四项的运算方向和量纲只有一份实现。
  const effectStrength = clamp(opts.effectStrength ?? 60, 0, 100) / 100
  if (effect === 'blur') {
    if (effectStrength > 0) blurMasked(data, width, height, coverage, bounds, effectStrength)
    return { covered: bounds.count }
  }
  if (effect === 'motionBlur') {
    if (effectStrength > 0) {
      motionBlurMasked(
        data, width, height, coverage, bounds, effectStrength,
        clamp(opts.angle ?? 0, 0, 360),
      )
    }
    return { covered: bounds.count }
  }
  if (effect === 'wrinkle') {
    if (effectStrength > 0) wrinkleMasked(data, width, height, coverage, bounds, effectStrength)
    return { covered: bounds.count }
  }
  if (effect === 'darkcircle') {
    if (effectStrength > 0) {
      darkCircleMasked(data, width, height, coverage, bounds, effectStrength)
    }
    return { covered: bounds.count }
  }
  if (effect === 'contour') {
    if (effectStrength > 0) {
      const shade = CONTOUR_SHADES.find(
        s => s.id === (opts.contourShade ?? 'cool'),
      ) ?? CONTOUR_SHADES[0]!
      contourMasked(data, width, coverage, bounds, effectStrength, shade.rgb)
    }
    return { covered: bounds.count }
  }
  if (effect === 'highlight') {
    if (effectStrength > 0) {
      const shade = HIGHLIGHT_SHADES.find(
        s => s.id === (opts.highlightShade ?? 'champagne'),
      ) ?? HIGHLIGHT_SHADES[0]!
      highlightMasked(data, width, coverage, bounds, effectStrength, shade.rgb)
    }
    return { covered: bounds.count }
  }
  if (effect === 'antiglare') {
    if (effectStrength > 0) antiGlareMasked(data, width, coverage, bounds, effectStrength)
    return { covered: bounds.count }
  }
  if (effect === 'dodge' || effect === 'burn') {
    if (effectStrength > 0) {
      dodgeBurnMasked(
        data, width, coverage, bounds, effectStrength,
        opts.toneRange ?? 'midtones', effect,
      )
    }
    return { covered: bounds.count }
  }
  if (effect === 'mosaic') {
    if (effectStrength > 0) mosaicMasked(data, width, height, coverage, bounds, effectStrength)
    return { covered: bounds.count }
  }
  if (effect === 'redeye') {
    for (let y = bounds.y0; y < bounds.y1; y++) {
      for (let x = bounds.x0; x < bounds.x1; x++) {
        const mi = y * width + x
        const cov = coverage[mi]! / 255
        if (cov <= 0) continue
        const i = mi * 4
        const r = data[i]!
        const g = data[i + 1]!
        const b = data[i + 2]!
        const excess = Math.max(0, r - Math.max(g, b)) / 255
        // 只抓明显偏红的瞳孔：红比绿/蓝高出 15% 才开始，40% 以上全开。
        // 这样选区边缘带到的肤色最多掉一两个点，不会跟着变灰。
        const t = Math.max(0, Math.min(1, (excess - 0.15) / 0.25))
        const gate = t * t * (3 - 2 * t)
        const mix = cov * effectStrength * gate
        if (mix <= 0) continue
        const targetR = Math.min(r, Math.round((g + b) / 2))
        data[i] = Math.round(r + (targetR - r) * mix)
      }
    }
    return { covered: bounds.count }
  }
  if (effect === 'hair') {
    if (effectStrength > 0) {
      const shade = HAIR_SHADES.find(s => s.id === (opts.hairShade ?? 'brown')) ?? HAIR_SHADES[1]!
      hairMasked(data, width, coverage, bounds, effectStrength, shade.rgb)
    }
    return { covered: bounds.count }
  }
  if (effect === 'eyeshadow') {
    if (effectStrength > 0) {
      const shade = EYE_SHADOW_SHADES.find(
        s => s.id === (opts.eyeShadowShade ?? 'earth'),
      ) ?? EYE_SHADOW_SHADES[0]!
      eyeShadowMasked(data, width, coverage, bounds, effectStrength, shade.rgb)
    }
    return { covered: bounds.count }
  }
  if (effect === 'eyebrow') {
    if (effectStrength > 0) {
      const shade = EYEBROW_SHADES.find(
        s => s.id === (opts.eyebrowShade ?? 'brown'),
      ) ?? EYEBROW_SHADES[1]!
      eyebrowMasked(data, width, coverage, bounds, effectStrength, shade.rgb)
    }
    return { covered: bounds.count }
  }
  if (effect === 'aegyoSal') {
    if (effectStrength > 0) {
      const shade = AEGYO_SAL_SHADES.find(
        s => s.id === (opts.aegyoSalShade ?? 'pearl'),
      ) ?? AEGYO_SAL_SHADES[0]!
      aegyoSalMasked(data, width, coverage, bounds, effectStrength, shade.rgb)
    }
    return { covered: bounds.count }
  }
  if (effect === 'eyeliner') {
    if (effectStrength > 0) {
      const shade = EYELINER_SHADES.find(
        s => s.id === (opts.eyelinerShade ?? 'black'),
      ) ?? EYELINER_SHADES[0]!
      eyelinerMasked(data, width, coverage, bounds, effectStrength, shade.rgb)
    }
    return { covered: bounds.count }
  }
  if (effect === 'iris') {
    if (effectStrength > 0) {
      const shade = IRIS_SHADES.find(
        s => s.id === (opts.irisShade ?? 'brown'),
      ) ?? IRIS_SHADES[0]!
      irisMasked(data, width, coverage, bounds, effectStrength, shade.rgb)
    }
    return { covered: bounds.count }
  }
  const u: Unit = effect === 'teeth'
    ? {
      ...ZERO_UNIT,
      // 去黄靠把饱和度往灰点收，再轻轻提亮；对比只给一点，避免牙缝发黑。
      saturation: -0.70 * effectStrength,
      exposure: 0.16 * effectStrength,
      contrast: 0.08 * effectStrength,
    }
    : effect === 'eyes'
      ? {
        ...ZERO_UNIT,
        // 眼白提亮、虹膜边缘拉开；饱和少量回补，避免眼睛发灰。
        saturation: 0.12 * effectStrength,
        exposure: 0.14 * effectStrength,
        contrast: 0.22 * effectStrength,
      }
      : {
        ...ZERO_UNIT,
        exposure: exposure / 100,
        contrast: contrast / 100,
        saturation: saturation / 100,
        temperature: temperature / 100,
        tint: tint / 100,
        whites: whites / 100,
        blacks: blacks / 100,
        highlights: highlights / 100,
        shadows: shadows / 100,
      }

  const darkSource = dehaze !== 0 ? new Uint8ClampedArray(data) : null
  const dehazeSample = dehaze !== 0 ? { amount: dehaze / 100, dark: 0 } : undefined

  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const mi = y * width + x
      const cov = coverage[mi]! / 255
      if (cov <= 0) continue
      const i = mi * 4
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      if (dehazeSample && darkSource) {
        dehazeSample.dark = localDarkChannel(darkSource, width, height, x, y)
      }
      let [nr, ng, nb] = applyTone([r / 255, g / 255, b / 255], u, dehazeSample)
      if (vibrance !== 0) {
        // 自然饱和度：本来就艳的颜色少动，灰一点的颜色多抬。
        const mx = Math.max(nr, ng, nb)
        const mn = Math.min(nr, ng, nb)
        const sat = mx <= 0 ? 0 : (mx - mn) / mx
        const boost = 1 + (vibrance / 100) * (1 - sat) * 0.8
        const lum = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb
        nr = Math.max(0, Math.min(1, lum + (nr - lum) * boost))
        ng = Math.max(0, Math.min(1, lum + (ng - lum) * boost))
        nb = Math.max(0, Math.min(1, lum + (nb - lum) * boost))
      }
      data[i] = Math.round(r + (nr * 255 - r) * cov)
      data[i + 1] = Math.round(g + (ng * 255 - g) * cov)
      data[i + 2] = Math.round(b + (nb * 255 - b) * cov)
      // alpha 不动（照片全不透明；和 smoothPixels 同一条）
    }
  }
  if (clarity !== 0) clarityMasked(data, width, height, coverage, bounds, clarity)
  return { covered: bounds.count }
}

/** 画布落地：取出底图像素 → `localAdjustPixels` → 新底图。 */
export async function localAdjustToBitmap(
  source: ImageBitmap, mask: Uint8Array, opts: LocalAdjustOptions = {},
): Promise<{ bitmap: ImageBitmap; covered: number }> {
  const w = source.width
  const h = source.height
  if (mask.length !== w * h) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${mask.length} 字节，照片 ${w}×${h}）`)
  }
  const { canvas, ctx } = makeCanvas(w, h, '局部调整失败', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, w, h)
  const { covered } = localAdjustPixels(image.data, w, h, mask, opts)
  if (covered > 0) ctx.putImageData(image, 0, 0)
  const bitmap = await createImageBitmap(canvas)
  return { bitmap, covered }
}
