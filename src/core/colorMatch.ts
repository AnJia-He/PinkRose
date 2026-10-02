import { ZERO, PARAM_MIN, PARAM_MAX, clampAdjustments, toUnit, type Adjustments } from '../../shared/adjustments.ts'
import { applyTone, srgbToLinear } from './tone.ts'

/**
 * 「照着这张调」的算法：把参考图的色彩分布，折算成六个调色参数。
 *
 * ## 走的是 Reinhard 那条路（spec §4.6 点名过）
 *
 * Reinhard 颜色迁移是「逐通道把均值挪过去、把标准差按比例缩过去」：
 *
 *     x' = (x - μ源) · (σ参考 / σ源) + μ参考
 *
 * 它工作在 Lab 上（感知均匀）。但**我们只能给用户八根滑块**（spec §5.1），
 * 而 Reinhard 的结果是一张改过的像素图 —— 两者不是一回事。所以这里多了一步：
 * **把 Reinhard 的输出当成靶子，反解出最接近的那组参数。**
 *
 * 反解用的是**两段式搜索**：先在每个参数的**整条量程**上粗扫一遍网格
 * （步长 25），再左右一步地精修。不用解析公式的理由是**没有可信的公式**：
 * 我们的色温是「红加一点、蓝减一点」、曝光是线性空间乘 2^ev、
 * 对比度绕中灰 —— 都跟 Lab 的坐标轴不是一一对应。与其编一串近似常数，
 * 不如让 `applyTone`（着色器的 CPU 对照实现）自己去试。
 *
 * ⚠️ 两段式里的「整条量程」不是保守，是**必需**：最初那版是纯贪心
 * （从零出发、每步 ±固定档位、只收改进），实测会卡在局部最优 ——
 * 「参考图更淡」那一种它给出残差 3.99，而**单靠一根饱和度就能做到 0.53**。
 * 参数之间互相背锅（对比度去替颜色偏差受过），只看左右一步退不回来。
 * 拟合顺序也因此定成"先色后明暗"，`FITTED_KEYS` 的注释里有实测数据。
 *
 * ## 残差是这个模块存在的一半理由
 *
 * `residual` 是**最好的一组参数还差多远**，单位是 ΔE76（Lab 欧氏距离），
 * 肉眼可辨的阈值约 2.3。它有两个用处：
 *   1. 界面据此判断要不要跟用户说一句"这个色调我做不到满分"；
 *   2. 它按 L / a / b 三根轴拆开 —— 如果残差主要落在 a 轴上，说明卡在
 *      **绿↔品红那根轴**，而八根滑块里没有它（只有色温那根蓝↔黄）。
 *      那就是要不要动渲染管线（加一层真正的三通道变换）的判据。
 *
 * ⚠️ 本模块**不动清晰度和暗角**：它们与"参考图长什么样"无关，
 *    是用户自己的构图选择（暗角）和局部细节（清晰度），也正好是
 *    `applyTone` 表达不了的两个（它俩要邻域像素和像素坐标）。
 */

/**
 * 参与拟合的参数，**顺序是有意的**：先色后明暗。
 *
 * 色温管 b 轴（蓝↔黄）、饱和度管彩度大小，这两个基本只动颜色；
 * 亮度和对比度则同时会改颜色分布。**反过来先拟合亮度/对比度，
 * 它们就会去替颜色的偏差背锅**（实测：先动对比度之后，再也没退回来，
 * 「更淡」那一种从 0.53 恶化到 3.99）。
 *
 * 清晰度和暗角在门外 —— 理由见文件头。
 */
const FITTED_KEYS = [
  'temperature', 'saturation', 'exposure', 'contrast', 'highlights', 'shadows',
] as const satisfies readonly (keyof Adjustments)[]

/** 一个采样像素：0~255 的 sRGB 三元组。 */
export type Rgb = readonly [number, number, number]

/**
 * 肉眼可辨阈值，ΔE76（Lab 欧氏距离）。
 *
 * 2.3 是 CIE 那套里经典的"刚好看得出来"（JND）。
 *
 * ⚠️ **它现在没有生产消费者**（界面那边量完之后决定不弹提示 —— 理由见
 * `App.tsx` 的 `matchReference`）。留着它是因为它标的是这个功能的**能力边界**：
 * 八张真实旅游照两两配对（56 对）里 **48 对**超过它，而且残差的 69% 落在
 * 明暗轴。下一步要不要往渲染管线里加一层真正的三通道变换，判据就是这个数。
 * 测试在读它，别当它是死导出顺手删掉。
 */
export const MATCH_JND = 2.3

/**
 * 参与拟合的六个参数。**故意不是 `Adjustments`** ——
 * 少两个键是一道类型级的闸门：调用方只能 `{...当前参数, ...result.params}`，
 * 想"顺手把这一整份赋进去"是过不了 typecheck 的，于是也就不可能
 * 悄悄把用户的清晰度和暗角清零。
 */
export type MatchedTone = {
  [K in typeof FITTED_KEYS[number]]: number
}

export type MatchResult = {
  /** 六个参数的**绝对值**，盖在当前那六个上面（清晰度/暗角原样不动）。 */
  params: MatchedTone
  /** 最好的一组还差多远，ΔE76。肉眼可辨阈值约 2.3。 */
  residual: number
  /** 残差按轴拆开（各轴 RMS，平方和开根 = residual）。 */
  axis: { l: number; a: number; b: number }
}

/**
 * 参与拟合的采样上限。
 *
 * 函数是纯的，调用方给多少都行 —— 但拟合要跑两百多次 `applyTone`，
 * 采样数直接进乘法。实测（2026-10-02，这台机器）：
 * 200 个点 31ms · 400 个 46ms · 800 个 83ms。**手机上还要再乘几倍**，
 * 而这是个点一下就要出结果的按钮，所以取 400 —— 估均值/标准差早就够了。
 */
const MAX_FIT_SAMPLES = 400

/** 标准差小于它就当"没有分布"（纯色块），那一根轴的缩放比例取 1 不缩放。 */
const FLAT_STD = 1e-6

/**
 * 粗扫的步长与遍数。
 *
 * ⚠️ **粗扫是必需的，不是保守起见。** 一开始只有"从零出发、每步 ±固定档位、
 * 只收改进"的贪心搜索，结果会卡在局部最优：实测「参考图更淡」那一种，
 * 贪心给出的四个参数残差 3.99，而**单靠一根饱和度就能做到 0.53** ——
 * 它先动了对比度和曝光，然后再也退不回来。
 * 粗扫把每个参数**在整条量程上**扫一遍（而不是只看当前位置的左右一步），
 * 才跳得出去。
 */
const COARSE_STEP = 25
const COARSE_PASSES = 3

/** 精修的步长档位。粗扫只能落在网格点上，这几档负责把它磨平。 */
const FINE_STEPS = [8, 4, 2, 1] as const
const FINE_PASSES = 1

// ── sRGB → Lab（D65） ──────────────────────────────────────────────
//
// 系数取自 sRGB 规范的 D65 矩阵，白点归一化折进矩阵里。
// `src/core/tone.ts` 的 `srgbToLinear` 直接复用 —— 全项目只许有一份
// 这个非线性变换（它的注释里写着为什么）。

const WHITE = [0.95047, 1, 1.08883] as const

function labOf01(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b)
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / WHITE[0]
  const y = (0.2126729 * R + 0.7151522 * G + 0.0721750 * B) / WHITE[1]
  const z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / WHITE[2]
  const fx = fLab(x), fy = fLab(y), fz = fLab(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function fLab(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29
}

type Profile = { mean: [number, number, number]; std: [number, number, number] }

function profileOf(labs: readonly [number, number, number][]): Profile {
  const n = labs.length
  const mean: [number, number, number] = [0, 0, 0]
  for (const l of labs) {
    mean[0] += l[0]; mean[1] += l[1]; mean[2] += l[2]
  }
  mean[0] /= n; mean[1] /= n; mean[2] /= n

  const std: [number, number, number] = [0, 0, 0]
  for (const l of labs) {
    std[0] += (l[0] - mean[0]) ** 2
    std[1] += (l[1] - mean[1]) ** 2
    std[2] += (l[2] - mean[2]) ** 2
  }
  std[0] = Math.sqrt(std[0] / n); std[1] = Math.sqrt(std[1] / n); std[2] = Math.sqrt(std[2] / n)
  return { mean, std }
}

/** 等距抽稀到 `max` 个以内（保持顺序，确定性）。 */
function thin<T>(list: readonly T[], max: number): readonly T[] {
  if (list.length <= max) return list
  const out: T[] = []
  const step = list.length / max
  for (let i = 0; i < max; i++) out.push(list[Math.floor(i * step)])
  return out
}

/**
 * 拿 `ref` 的色彩分布当靶子，找出最接近的六个参数。
 *
 * @param src 当前照片（**底图**，不是带着参数渲染后的画面）的采样像素
 * @param ref 参考图的采样像素
 * @throws 两边任意一边没有采样点时抛 —— 宁可不给结果，也不返回一组假的参数
 */
export function matchToReference(src: readonly Rgb[], ref: readonly Rgb[]): MatchResult {
  if (src.length === 0 || ref.length === 0) {
    throw new Error('色彩匹配需要两张图各有至少一个采样点')
  }

  const srcPx = thin(src, MAX_FIT_SAMPLES)
  const refPx = thin(ref, MAX_FIT_SAMPLES)

  const srcLab = srcPx.map(px => labOf01(px[0] / 255, px[1] / 255, px[2] / 255))
  const srcProfile = profileOf(srcLab)
  const refProfile = profileOf(refPx.map(px => labOf01(px[0] / 255, px[1] / 255, px[2] / 255)))

  // Reinhard：每根轴一个缩放比例 + 一个平移。源那根轴是平的（纯色块）时不缩放。
  const k = [0, 1, 2].map(c =>
    srcProfile.std[c] > FLAT_STD ? refProfile.std[c] / srcProfile.std[c] : 1)
  const target = srcLab.map(l => [
    (l[0] - srcProfile.mean[0]) * k[0] + refProfile.mean[0],
    (l[1] - srcProfile.mean[1]) * k[1] + refProfile.mean[1],
    (l[2] - srcProfile.mean[2]) * k[2] + refProfile.mean[2],
  ] as [number, number, number])

  const src01 = srcPx.map(px => [px[0] / 255, px[1] / 255, px[2] / 255] as [number, number, number])
  const n = src01.length

  /** 一组参数下的平均平方误差（Lab 三轴之和）。 */
  const cost = (params: Adjustments): number => {
    const u = toUnit(params)
    let sum = 0
    for (let i = 0; i < n; i++) {
      const [r, g, b] = applyTone(src01[i], u)
      const t = labOf01(r, g, b)
      const tgt = target[i]
      const dl = t[0] - tgt[0], da = t[1] - tgt[1], db = t[2] - tgt[2]
      sum += dl * dl + da * da + db * db
    }
    return sum / n
  }

  let best = ZERO
  let bestCost = cost(best)

  /** 只接受确实更好的候选；`best` 是当前最优。 */
  const consider = (cand: Adjustments): void => {
    const c = cost(cand)
    if (c < bestCost - 1e-9) {
      best = cand
      bestCost = c
    }
  }

  // 第一段：粗扫。每个参数在整条量程上取网格值，逐个试。
  // 一轮下来一个都没改进就收工 —— 大多数情况两轮就定型，省掉第 3 轮。
  for (let pass = 0; pass < COARSE_PASSES; pass++) {
    const before = bestCost
    for (const key of FITTED_KEYS) {
      for (let v = PARAM_MIN; v <= PARAM_MAX; v += COARSE_STEP) {
        if (v === best[key]) continue
        consider(clampAdjustments({ ...best, [key]: v }))
      }
    }
    if (bestCost >= before) break
  }

  // 第二段：精修。此时已经落在最优点附近，左右一步就够。
  for (let pass = 0; pass < FINE_PASSES; pass++) {
    for (const key of FITTED_KEYS) {
      for (const step of FINE_STEPS) {
        for (const dir of [1, -1]) {
          const cand = clampAdjustments({ ...best, [key]: best[key] + dir * step })
          if (cand[key] === best[key]) continue // 已经顶到 ±100
          consider(cand)
        }
      }
    }
  }

  // 残差按轴拆开再报 —— 总残差只说"差多少"，拆开才说得出"差在哪根轴"。
  const u = toUnit(best)
  const acc = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const [r, g, b] = applyTone(src01[i], u)
    const t = labOf01(r, g, b)
    const tgt = target[i]
    acc[0] += (t[0] - tgt[0]) ** 2
    acc[1] += (t[1] - tgt[1]) ** 2
    acc[2] += (t[2] - tgt[2]) ** 2
  }
  const axis = {
    l: Math.sqrt(acc[0] / n),
    a: Math.sqrt(acc[1] / n),
    b: Math.sqrt(acc[2] / n),
  }

  // 从 FITTED_KEYS 生成，而不是手抄一遍六个键 —— 两份清单早晚会漂。
  // （这条也让"返回值里没有清晰度/暗角"是个**构造出来的**事实，不是靠自觉。）
  const params = Object.fromEntries(FITTED_KEYS.map(k => [k, best[k]])) as MatchedTone

  return {
    params,
    residual: Math.sqrt(acc[0] / n + acc[1] / n + acc[2] / n),
    axis,
  }
}
