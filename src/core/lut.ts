// src/core/lut.ts
import type { Cube } from '../../shared/lut.ts'

/**
 * LUT 查表的 **CPU 对照实现** —— 和 `render/shader.ts` 里第 7 段是同一套数学
 * （三线性 + 按强度混合 + domain 换算）。
 *
 * ⚠️ 改这里必须同步改 shader（反过来也一样），和 `tone.ts` 对 `shader.ts`
 * 那条老规矩一致。它存在的理由：GPU 那半进不了 vitest，而
 * 「强度 0 逐像素不变」和「LUT 排在参数之后」这两条是**契约**，必须有测试。
 */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * 输入 → 纹理坐标（0–n−1）。和 shader 的 (q−min)/(max−min) 同一套。
 *
 * ⚠️ **不能**先把 v 钳到 0–1：domain 的语义是"表里最后一格对应的输入值"，
 * 声明 [0,2] 的表必须让输入 2 命中最后一格。先钳会把 2 变成 1、落进表的中间，
 * 等于把 domain 声明作废。越界由末尾对 t 的钳制兜住（超出 [min,max] 吸到表的边缘）。
 */
function texelCoord(v: number, lo: number, hi: number, n: number): number {
  const t = (v - lo) / Math.max(hi - lo, 1e-6)
  return clamp01(t) * (n - 1)
}

/**
 * 三线性采样一个 cube。输入是待查的值（管线里由 `applyLut` 钳到 0–1；
 * 直接调用时允许越界，越界按 domain 吸到表的边缘），输出是表里的 0–1 色值。
 */
export function sampleCube(cube: Cube, r: number, g: number, b: number): [number, number, number] {
  const n = cube.size
  const x = texelCoord(r, cube.domainMin[0], cube.domainMax[0], n)
  const y = texelCoord(g, cube.domainMin[1], cube.domainMax[1], n)
  const z = texelCoord(b, cube.domainMin[2], cube.domainMax[2], n)
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z)
  const x1 = Math.min(x0 + 1, n - 1), y1 = Math.min(y0 + 1, n - 1), z1 = Math.min(z0 + 1, n - 1)
  const fx = x - x0, fy = y - y0, fz = z - z0
  // 红变最快 → index = x + y*n + z*n²（和 texImage3D 的 x-fastest 一样）
  const at = (i: number, j: number, k: number, c: number): number =>
    cube.rgba[((k * n + j) * n + i) * 4 + c]! / 255
  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const c00 = lerp(at(x0, y0, z0, c), at(x1, y0, z0, c), fx)
    const c10 = lerp(at(x0, y1, z0, c), at(x1, y1, z0, c), fx)
    const c01 = lerp(at(x0, y0, z1, c), at(x1, y0, z1, c), fx)
    const c11 = lerp(at(x0, y1, z1, c), at(x1, y1, z1, c), fx)
    out[c] = lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz)
  }
  return out
}

/**
 * 按强度（0–100）把查表结果和原色混合。**amount = 0 时逐像素等于入参**
 * —— 这是 spec §9 那条测试，别在这里加任何"顺手"的运算。
 */
export function applyLut(
  cube: Cube, rgb: readonly [number, number, number], amount: number,
): [number, number, number] {
  const q: [number, number, number] = [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])]
  const a = clamp01(amount / 100)
  if (a === 0) return q
  const m = sampleCube(cube, q[0], q[1], q[2])
  return [lerp(q[0], m[0], a), lerp(q[1], m[1], a), lerp(q[2], m[2], a)]
}
