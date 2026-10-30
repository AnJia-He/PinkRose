/**
 * **磨皮画笔的 CPU 引擎**（★ 2026-10-17，方案二的像素落点）。
 *
 * 和 `image/erase`（点修）是同一层、同一份契约：掩码（0–255 覆盖率）指哪儿磨哪儿，
 * 产出一张**新底图**；作用对象是 `base`（不带参数、不带滤镜 —— 参数/滤镜之后由
 * 渲染管线盖上去）。区别只有一个：点修是"把这块换成别处的内容"，磨皮是
 * "把这块里的小疙瘩抹平、大的明暗和边缘留住"。
 *
 * 算法一句话：**引导滤波**（He et al., guided filter），自引导、亮度做导向 ——
 *   ① 工作盒里算 L / L² / R / G / B 的盒均值（滑动窗口，两趟可分离，O(N)）；
 *   ② `a = var / (var + EPS)`：低反差处（皮肤、毛孔）a→0 → 输出趋向邻域均值；
 *      高反差处（眼睛、眉毛、头发边）a→1 → 原样保留；
 *   ③ `q_c = mean(a)·L + mean(b_c)`，`b_c = mean_c − a·mean(L)`；
 *      两端都用导向亮度 L —— 若回写时误用原通道值，会整块提亮/偏色；
 *   ④ 按 `覆盖率 × 强度` 混合回原像素 —— **覆盖率为 0 的像素一个字节都不写**。
 *
 * ⚠️ 只在**掩码外接框 + 半径边距**的工作盒里算（和 `spotHeal` 同一个做法）：
 *   一张 12 MP 的照片上磨一块脸，没必要整图跑；耗时随外接框面积线性涨。
 * ⚠️ 亮度导向而不是逐通道各做一遍：逐通道会把颜色边缘也糊掉（彩色噪点被抹成
 *   灰色过渡带）；共享一个 a 在保边这件事上更稳，颜色只是跟着亮度结构走。
 * ⚠️ EPS 是"什么算边"的唯一旋钮，别在别处再塞一个阈值：两个阈值会打架，
 *   而且调效果时永远不知道该动哪个。单位是 0–255 亮度尺度的**方差**。
 */

import { makeCanvas } from '../core/canvas'
import { maskBounds } from '../core/retouch'

/** 默认强度（0–100）。和 `ui/SmoothControls` 上那根滑杆的初值同一个数。 */
export const DEFAULT_SMOOTH_STRENGTH = 60

/**
 * 默认纹理保留量（0–100）。0 = 只留磨平后的低频；100 = 原样不动。
 * 磨皮最容易翻车的地方不是"磨不干净"，而是磨成塑料 —— 留一点高频纹理，
 * 毛孔和皮肤起伏还在，观感才自然。
 */
export const DEFAULT_SMOOTH_TEXTURE = 35

/**
 * 「什么算边」的方差阈值（0–255 亮度尺度）。
 *
 * 实测口径：皮肤毛孔那一带的局部方差大约 50~300，五官边缘（眼睛/眉毛/头发）
 * 是 1000 以上 —— 400 落在中间那条峡谷里：var=100 时 a≈0.2（八成朝均值走，
 * 磨得动）；var=2500 时 a≈0.86（几乎原样，边保得住）。
 */
const EDGE_VARIANCE_EPS = 400

/**
 * 窗口半径（图片像素）：短边的 0.3%，夹在 3~24。
 * 2048 短边 → 6，4000 → 12 —— "同一个强度在 2 MP 和 24 MP 上磨出来的观感一致"。
 */
export function defaultSmoothRadius(w: number, h: number): number {
  return Math.max(3, Math.min(24, Math.round(Math.min(w, h) * 0.003)))
}

export type SmoothOptions = {
  /** 强度 0–100（0 = 不动，缺省 60）。 */
  strength?: number
  /** 窗口半径（图片像素）；缺省走 `defaultSmoothRadius`。 */
  radius?: number
  /**
   * 纹理保留 0–100（缺省 0 = 保持旧行为）。
   * 在磨平结果上把「原图 − 磨平结果」这部分高频按比例加回去：
   * 0 最平滑，100 等于不磨。只作用在覆盖率为正的像素上。
   */
  texture?: number
}

const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

/**
 * 盒均值（滑动窗口，可分离两趟），边界按"复制边缘"处理。
 * `tmp` 是 `w*h` 的中间缓冲；`dst` 可以与 `src` 不同（本文件里都不同）。
 */
function boxMean(
  src: Float32Array, w: number, h: number, r: number,
  dst: Float32Array, tmp: Float32Array,
): void {
  const win = 2 * r + 1
  // 横趟：src -> tmp
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
  // 纵趟：tmp -> dst
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += tmp[Math.max(0, Math.min(h - 1, k)) * w + x]!
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / win
      sum -= tmp[Math.max(0, Math.min(h - 1, y - r)) * w + x]!
      sum += tmp[Math.max(0, Math.min(h - 1, y + r + 1)) * w + x]!
    }
  }
}

/**
 * 纯函数：按掩码磨皮，**原地**改 `data`（RGBA、行距 = width×4，与 `spotHeal` 同款）。
 *
 * 返回 `covered` = 掩码非零像素数（"磨了这一块"的账；0 = 什么都没做）。
 * 只有 coverage 非零的像素会被写 —— 掩码外逐字节不变。
 */
export function smoothPixels(
  data: Uint8ClampedArray, width: number, height: number,
  coverage: Uint8Array, opts: SmoothOptions = {},
): { covered: number } {
  if (coverage.length !== width * height) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${coverage.length} 字节，照片 ${width}×${height}）`)
  }
  const strength = Math.max(0, Math.min(100, opts.strength ?? DEFAULT_SMOOTH_STRENGTH)) / 100
  const texture = Math.max(0, Math.min(100, opts.texture ?? 0)) / 100
  const bounds = maskBounds(coverage, width, height)
  if (!bounds) return { covered: 0 }
  // 纹理留满 = 每个像素都回到原值；不写字节（和强度 0 同一条恒等契约）。
  if (strength <= 0 || texture >= 1) return { covered: bounds.count }

  const radius = Math.max(1, Math.round(opts.radius ?? defaultSmoothRadius(width, height)))

  // 工作盒 = 外接框 + 半径边距（裁进画面）。
  const wx0 = Math.max(0, bounds.x0 - radius)
  const wy0 = Math.max(0, bounds.y0 - radius)
  const wx1 = Math.min(width, bounds.x1 + radius)
  const wy1 = Math.min(height, bounds.y1 + radius)
  const ww = wx1 - wx0
  const wh = wy1 - wy0
  const n = ww * wh

  // ── 提取平面（0–255）────────────────────────────────────────────────
  const R = new Float32Array(n)
  const G = new Float32Array(n)
  const B = new Float32Array(n)
  const L = new Float32Array(n)
  const L2 = new Float32Array(n)
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = ((wy0 + y) * width + wx0 + x) * 4
      const p = y * ww + x
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      R[p] = r
      G[p] = g
      B[p] = b
      const l = LUMA_R * r + LUMA_G * g + LUMA_B * b
      L[p] = l
      L2[p] = l * l
    }
  }

  // ── 盒均值 ──────────────────────────────────────────────────────────
  const tmp = new Float32Array(n)
  const meanL = new Float32Array(n)
  boxMean(L, ww, wh, radius, meanL, tmp)
  const meanL2 = new Float32Array(n)
  boxMean(L2, ww, wh, radius, meanL2, tmp)
  const meanR = new Float32Array(n)
  boxMean(R, ww, wh, radius, meanR, tmp)
  const meanG = new Float32Array(n)
  boxMean(G, ww, wh, radius, meanG, tmp)
  const meanB = new Float32Array(n)
  boxMean(B, ww, wh, radius, meanB, tmp)

  // ── a / b：低反差 → 朝均值走，高反差 → 原样 ─────────────────────────
  const a = new Float32Array(n)
  const bR = new Float32Array(n)
  const bG = new Float32Array(n)
  const bB = new Float32Array(n)
  for (let p = 0; p < n; p++) {
    const ml = meanL[p]!
    const varL = Math.max(0, meanL2[p]! - ml * ml)
    const ap = varL / (varL + EDGE_VARIANCE_EPS)
    a[p] = ap
    bR[p] = meanR[p]! - ap * ml
    bG[p] = meanG[p]! - ap * ml
    bB[p] = meanB[p]! - ap * ml
  }
  // 复用那几张"不再要"的均值表当输出（省四张 n 大的 Float32）。
  const meanA = meanL2
  boxMean(a, ww, wh, radius, meanA, tmp)
  const meanBR = meanR
  boxMean(bR, ww, wh, radius, meanBR, tmp)
  const meanBG = meanG
  boxMean(bG, ww, wh, radius, meanBG, tmp)
  const meanBB = meanB
  boxMean(bB, ww, wh, radius, meanBB, tmp)

  // ── 写回：q = meanA·I + meanB，按覆盖率 × 强度混合 ───────────────────
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const p = y * ww + x
      const ix = wx0 + x
      const iy = wy0 + y
      const cov = coverage[iy * width + ix]! / 255 * strength
      if (cov <= 0) continue
      const i = (iy * width + ix) * 4
      const ma = meanA[p]!
      // 导向图是亮度 L，所以线性模型里 a·I 的 I 也必须是 L：
      // q_c = mean(a)·L + mean(b_c)。这里若把 L 换成通道原值，会在
      // 亮度与通道均值不一致的地方整体偏色/偏亮（实测高反差颗粒可漂 +18 灰阶）。
      const qr = ma * L[p]! + meanBR[p]!
      const qg = ma * L[p]! + meanBG[p]!
      const qb = ma * L[p]! + meanBB[p]!
      // 目标值 = 磨平结果 + 高频残差 × 纹理保留量。纹理 0 时就是纯磨平；
      // 纹理 1 时目标值回到原像素（上面已提前返回）。
      const tr = qr + (data[i]! - qr) * texture
      const tg = qg + (data[i + 1]! - qg) * texture
      const tb = qb + (data[i + 2]! - qb) * texture
      data[i] = Math.round(data[i]! + (tr - data[i]!) * cov)
      data[i + 1] = Math.round(data[i + 1]! + (tg - data[i + 1]!) * cov)
      data[i + 2] = Math.round(data[i + 2]! + (tb - data[i + 2]!) * cov)
      // alpha 不动（照片全不透明；和 spotHeal 的"预乘"差异在本用法无影响）
    }
  }

  return { covered: bounds.count }
}

/**
 * 「磨这里」的像素落点 —— 画布这一层照 `eraseToBitmap` 的模子：
 * 取出底图像素 → `smoothPixels` → 产出**新底图**。
 *
 * ⚠️ 掩码尺寸对不上直接抛（理由同 `eraseToBitmap`：返回一张空图会让用户以为
 *    "磨出来就是黑的"）。
 */
export async function smoothToBitmap(
  source: ImageBitmap, mask: Uint8Array, opts: SmoothOptions = {},
): Promise<{ bitmap: ImageBitmap; covered: number }> {
  const w = source.width
  const h = source.height
  if (mask.length !== w * h) {
    throw new Error(`掩码尺寸和照片对不上（掩码 ${mask.length} 字节，照片 ${w}×${h}）`)
  }
  const { canvas, ctx } = makeCanvas(w, h, '磨不了', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, w, h)
  const { covered } = smoothPixels(image.data, w, h, mask, opts)
  if (covered > 0) ctx.putImageData(image, 0, 0)
  const bitmap = await createImageBitmap(canvas)
  return { bitmap, covered }
}
