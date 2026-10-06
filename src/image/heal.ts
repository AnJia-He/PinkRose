/**
 * **修补笔引擎**（点修「擦掉这里」的默认算法）。
 *
 * 移植自 Compositor 的 `Compositor/Rendering/HealPixels.c`
 * （github.com/robbietilton/Compositor，MIT License，© 2026 Wonder Assembly LLC；
 * 来源与协议全文见仓库根目录 `THIRD_PARTY_NOTICES.md`）。
 *
 * 算法一句话说清（Photoshop 修复画笔的同一族做法）：
 *   ① 在要擦的斑块**周围一环**（ring）上与"远处某一块补丁"逐像素比对，
 *      24 个方向 × 5 个远近档找一个最像的 donor 补丁（再 ±3px 微调对齐纹理）；
 *   ② 把"斑块边缘 vs donor 边缘"的**色调差**（membrane，膜）用多网格
 *      Gauss-Seidel 解一个拉普拉斯方程、平铺到整个洞里 —— 贴过来的像素因此
 *      和周围**接色不接缝**；
 *   ③ 没找到 donor（mode 1 或整张图就是一块布）时，改为"边缘平滑铺开 +
 *      按周围细节强度回填噪点"；
 *   ④ 最后按 `coverage × opacity` 混合回去 —— 软边掩码有软边效果。
 *
 * 约定（照 C 原版）：
 *   · `data` 是 **RGBA、行距 = width×4**（原地修改，不返回新数组）；
 *   · `coverage` 是 width×height、0–255，**0 = 一个字节都不动**；
 *   · 只有 coverage 非零的像素会被写 —— 洞外（含 ring）逐字节不变。
 *
 * ⚠️ C 原版按**预乘 alpha** 写（RGB 夹到 ≤ alpha）。我们的照片全是不透明的
 *    （alpha = 255，预乘与直通一致），所以这条差异在今天的用法里无影响；
 *    真带透明图进来时按原版行为处理（见末尾那段夹取）。
 *
 * ⚠️ 别把 `healed` 当"改了像素的个数"——它是**掩码里的像素个数**（全部会被写）。
 */

export type HealMode = 0 | 1 | 2

export type HealResult = {
  /** 掩码覆盖到的像素个数（覆盖即写；ringCount 为 0 时才可能小于它）。 */
  healed: number
  /** 有没有真的找到 donor 补丁（false = 走了"生成纹理"的平滑兜底）。 */
  usedSource: boolean
}

const OUTSIDE = 0
const RING = 1
const HOLE = 2

/** 32 位整数哈希（C 的 `heal_hash`，xorshift-multiply 一串）。 */
function healHash(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0
  x = Math.imul(x, 0x7feb352d) >>> 0
  x = (x ^ (x >>> 15)) >>> 0
  x = Math.imul(x, 0x846ca68b) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

/** 哈希 → [0,1) 的均匀数（C 的 `heal_unit`：取高 24 位）。 */
function healUnit(key: number): number {
  return (healHash(key) >>> 8) / 16777216
}

/**
 * donor 补丁的得分 = ring 上"斑块 vs 平移 (dx,dy) 后的补丁"的均方差。
 * 补丁压到斑块上、或伸出画面 → Infinity（不合格）。
 */
function healScore(
  rgba: Uint8ClampedArray, width: number, height: number,
  role: Uint8Array, wx0: number, wy0: number, ww: number, wh: number,
  dx: number, dy: number,
): number {
  if (Math.abs(dx) < ww && Math.abs(dy) < wh) return Infinity
  if (wx0 + dx < 0 || wy0 + dy < 0 || wx0 + ww + dx > width || wy0 + wh + dy > height) return Infinity
  let sum = 0
  let n = 0
  for (let y = 0; y < wh; y++) {
    const ty = wy0 + y
    const sy = ty + dy
    for (let x = 0; x < ww; x++) {
      if (role[y * ww + x] !== RING) continue
      const t = (ty * width + wx0 + x) * 4
      const s = (sy * width + wx0 + x + dx) * 4
      for (let c = 0; c < 4; c++) {
        const d = rgba[t + c]! - rgba[s + c]!
        sum += d * d
      }
      n++
    }
  }
  return n ? sum / n : Infinity
}

/**
 * 在 HOLE 像素上解"值"场：ring 的值是固定边界，洞内是拉普拉斯方程的解
 * （多网格：先在半分辨率的粗网格上解一遍当初始值，细网格只要 40 轮就收敛）。
 * 原地改 `value`（每像素 4 个 float）。
 */
function healSolve(
  value: Float32Array, role: Uint8Array, w: number, h: number, depth: number,
): void {
  let iterations = 300
  if (w > 32 && h > 32 && depth < 16) {
    const cw = (w + 1) >> 1
    const ch = (h + 1) >> 1
    const coarse = new Float32Array(cw * ch * 4)
    const coarseRole = new Uint8Array(cw * ch)
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let known = 0
        let hole = 0
        const knownSum = [0, 0, 0, 0]
        const holeSum = [0, 0, 0, 0]
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const fx = x * 2 + i
            const fy = y * 2 + j
            if (fx >= w || fy >= h) continue
            const p = fy * w + fx
            if (role[p] === RING) {
              known++
              for (let c = 0; c < 4; c++) knownSum[c]! += value[p * 4 + c]!
            } else if (role[p] === HOLE) {
              hole++
              for (let c = 0; c < 4; c++) holeSum[c]! += value[p * 4 + c]!
            }
          }
        }
        const q = y * cw + x
        if (known) {
          coarseRole[q] = RING
          for (let c = 0; c < 4; c++) coarse[q * 4 + c] = knownSum[c]! / known
        } else if (hole) {
          coarseRole[q] = HOLE
          for (let c = 0; c < 4; c++) coarse[q * 4 + c] = holeSum[c]! / hole
        }
      }
    }
    healSolve(coarse, coarseRole, cw, ch, depth + 1)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        const q = ((y >> 1) * cw) + (x >> 1)
        if (role[p] === HOLE && coarseRole[q] === HOLE) {
          for (let c = 0; c < 4; c++) value[p * 4 + c] = coarse[q * 4 + c]!
        }
      }
    }
    iterations = 40
  }
  const omega = 1.8
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (role[p] !== HOLE) continue
        const sum = [0, 0, 0, 0]
        let n = 0
        const xs = [x - 1, x + 1, x, x]
        const ys = [y, y, y - 1, y + 1]
        for (let k = 0; k < 4; k++) {
          const nx = xs[k]!
          const ny = ys[k]!
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const q = ny * w + nx
          if (role[q] === OUTSIDE) continue
          for (let c = 0; c < 4; c++) sum[c]! += value[q * 4 + c]!
          n++
        }
        if (!n) continue
        for (let c = 0; c < 4; c++) {
          value[p * 4 + c]! += omega * (sum[c]! / n - value[p * 4 + c]!)
        }
      }
    }
  }
}

export function spotHeal(
  data: Uint8ClampedArray, width: number, height: number,
  coverage: Uint8Array,
  opts: { mode?: HealMode; opacity?: number; seed?: number } = {},
): HealResult {
  const mode = opts.mode ?? 0
  const opacity = opts.opacity ?? 1
  const seed = opts.seed ?? 0x6d2b79f5
  const W = width
  const H = height

  // ── 掩码边界 ────────────────────────────────────────────────────────
  let bx0 = W, by0 = H, bx1 = 0, by1 = 0
  let missing = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!coverage[y * W + x]) continue
      missing++
      if (x < bx0) bx0 = x
      if (x + 1 > bx1) bx1 = x + 1
      if (y < by0) by0 = y
      if (y + 1 > by1) by1 = y + 1
    }
  }
  if (missing === 0) return { healed: 0, usedSource: false }

  const bw = bx1 - bx0
  const bh = by1 - by0
  const size = Math.max(bw, bh)
  const ring = Math.max(2, Math.min(16, Math.floor(size / 8)))

  // 工作盒 = 斑块 + 一环，裁进画面。
  const wx0 = Math.max(0, bx0 - ring)
  const wy0 = Math.max(0, by0 - ring)
  const wx1 = Math.min(W, bx1 + ring)
  const wy1 = Math.min(H, by1 + ring)
  const ww = wx1 - wx0
  const wh = wy1 - wy0
  const wn = ww * wh

  const role = new Uint8Array(wn)
  const near = new Uint8Array(wn)
  const prefix = new Int32Array(Math.max(ww, wh) + 1)
  const value = new Float32Array(wn * 4)

  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      role[y * ww + x] = coverage[(wy0 + y) * W + wx0 + x] ? HOLE : OUTSIDE
    }
  }

  // ring = 洞的方形膨胀（行前缀和一遍、列一遍）。
  for (let y = 0; y < wh; y++) {
    prefix[0] = 0
    for (let x = 0; x < ww; x++) prefix[x + 1] = prefix[x]! + (role[y * ww + x] === HOLE ? 1 : 0)
    for (let x = 0; x < ww; x++) {
      const lo = Math.max(0, x - ring)
      const hi = Math.min(ww, x + ring + 1)
      near[y * ww + x] = prefix[hi]! - prefix[lo]! > 0 ? 1 : 0
    }
  }
  for (let x = 0; x < ww; x++) {
    prefix[0] = 0
    for (let y = 0; y < wh; y++) prefix[y + 1] = prefix[y]! + near[y * ww + x]!
    for (let y = 0; y < wh; y++) {
      const lo = Math.max(0, y - ring)
      const hi = Math.min(wh, y + ring + 1)
      if (role[y * ww + x] === OUTSIDE && prefix[hi]! - prefix[lo]! > 0) role[y * ww + x] = RING
    }
  }
  let ringCount = 0
  for (let p = 0; p < wn; p++) if (role[p] === RING) ringCount++
  // 整张图都被圈住（没有洞外可参考）→ 什么都不做。
  if (!ringCount) return { healed: 0, usedSource: false }

  // ── donor 补丁搜索（内容感知 / 就近匹配）────────────────────────────
  let ox = 0
  let oy = 0
  let haveSource = false
  if (mode !== 1) {
    const factors = [1.05, 1.35, 1.75, 2.25, 2.8]
    const count = mode === 2 ? 2 : 5
    let best = Infinity
    for (let f = 0; f < count; f++) {
      for (let a = 0; a < 24; a++) {
        const angle = (a * Math.PI) / 12
        const dx = Math.round(Math.cos(angle) * factors[f]! * ww)
        const dy = Math.round(Math.sin(angle) * factors[f]! * wh)
        let score = healScore(data, W, H, role, wx0, wy0, ww, wh, dx, dy)
        if (!isFinite(score)) continue
        score *= mode === 2 ? 1 + 0.6 * f : 1 + 0.1 * f // 同样像时，越近的补丁越优先
        if (score < best) {
          best = score
          ox = dx
          oy = dy
        }
      }
    }
    if (isFinite(best)) {
      // 微调对齐：让重复的纹理线接得上（±3px）。
      const cx = ox
      const cy = oy
      let refined = healScore(data, W, H, role, wx0, wy0, ww, wh, cx, cy)
      for (let j = -3; j <= 3; j++) {
        for (let i = -3; i <= 3; i++) {
          const score = healScore(data, W, H, role, wx0, wy0, ww, wh, cx + i, cy + j)
          if (score < refined) {
            refined = score
            ox = cx + i
            oy = cy + j
          }
        }
      }
      haveSource = true
    }
  }

  // ── membrane（膜）：边缘色调差，铺满整个洞 ─────────────────────────
  const mean = [0, 0, 0, 0]
  const detail = [0, 0, 0]
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const p = y * ww + x
      if (role[p] !== RING) continue
      const ix = wx0 + x
      const iy = wy0 + y
      const t = (iy * W + ix) * 4
      for (let c = 0; c < 4; c++) {
        const s = haveSource ? data[((iy + oy) * W + ix + ox) * 4 + c]! : 0
        const v = data[t + c]! - s
        value[p * 4 + c] = v
        mean[c]! += v
      }
      if (!haveSource) {
        // 边缘上的细节强度（每个像素 vs 它四邻的平均）。
        for (let c = 0; c < 3; c++) {
          let around = 0
          let n = 0
          const offs = [[ix - 1, iy], [ix + 1, iy], [ix, iy - 1], [ix, iy + 1]]
          for (const o of offs) {
            if (o[0]! < 0 || o[1]! < 0 || o[0]! >= W || o[1]! >= H) continue
            around += data[(o[1]! * W + o[0]!) * 4 + c]!
            n++
          }
          if (n) {
            const d = data[t + c]! - around / n
            detail[c]! += d * d
          }
        }
      }
    }
  }
  for (let c = 0; c < 4; c++) mean[c]! /= ringCount
  for (let p = 0; p < wn; p++) {
    if (role[p] === HOLE) for (let c = 0; c < 4; c++) value[p * 4 + c] = mean[c]!
  }
  healSolve(value, role, ww, wh, 0)
  for (let c = 0; c < 3; c++) detail[c] = Math.sqrt(detail[c]! / ringCount) * 0.9

  // ── 写回：donor（或平滑值 + 噪点）+ coverage×opacity 混合 ─────────
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const p = y * ww + x
      if (role[p] !== HOLE) continue
      const ix = wx0 + x
      const iy = wy0 + y
      const t = (iy * W + ix) * 4
      const s = haveSource ? ((iy + oy) * W + ix + ox) * 4 : 0
      const amount = (coverage[iy * W + ix]! / 255) * opacity
      let grain = 0
      if (!haveSource) {
        const key = healHash(seed ^ healHash(iy * W + ix))
        const u1 = healUnit(key)
        const u2 = healUnit(key ^ 0x68e31da4)
        grain = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2)
      }
      const out = [0, 0, 0, 0]
      for (let c = 0; c < 4; c++) {
        const healed = (haveSource ? data[s + c]! : 0) + value[p * 4 + c]! + (c < 3 ? grain * detail[c]! : 0)
        out[c] = data[t + c]! + (healed - data[t + c]!) * amount
      }
      const alpha = Math.max(0, Math.min(255, out[3]!))
      data[t + 3] = Math.round(alpha)
      for (let c = 0; c < 3; c++) {
        data[t + c] = Math.round(Math.max(0, Math.min(alpha, out[c]!)))
      }
    }
  }

  return { healed: missing, usedSource: haveSource }
}
