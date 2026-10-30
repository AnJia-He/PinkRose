/**
 * 滤镜（LUT）的类型、常量与 `.cube` 解析。**前后端共用一份** ——
 * 客户端导入前先解一遍（即时反馈），服务端再解一遍（不信前端）。
 * 设计：docs/superpowers/specs/2026-10-05-lut-design.md
 */

/** 服务器上一条滤镜的元数据（接口回给客户端的那一面）。 */
export type LutMeta = {
  id: number
  name: string
  /** 级数 n（.cube 的 LUT_3D_SIZE） */
  size: number
  bytes: number
  createdAt: number
}

/**
 * **这张图正用着哪个滤镜、强度多少**。
 *
 * ⚠️ 它**不进 `Adjustments`**：那是个"八十个数字"的 record，被 toUnit /
 * PARAM_KEYS / 范围表 / 提示词 / 照调那五处消费，塞一个引用进去会让每一处
 * 都要处理"这一格不是数字"。设计 §3.2。
 */
export type LutRef = { lutId: number; amount: number }

/**
 * 解析好的颜色表。
 * `rgba` 是 size³×4 的 RGBA8，**红变最快**（和 `texture(uLut, vec3(r,g,b))`
 * 的取样方向、以及 texImage3D 的 x-fastest 约定一致）。
 */
export type Cube = {
  size: number
  rgba: Uint8Array
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  title: string | null
}

export const MAX_LUT_FILE_BYTES = 8 * 1024 * 1024
export const MAX_LUTS = 30
export const MAX_LUT_SIZE = 64
/** 1D 曲线只用来展开成 3D 纹理，不需要限制到 64；文件本身另有 8MB 上限。 */
export const MAX_LUT_1D_SIZE = 65536
export const MIN_LUT_SIZE = 2
export const MAX_LUT_NAME = 30

/** 解析失败的统一错误。**message 是给用户看的中文**（spec §6.3）。 */
export class LutParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LutParseError'
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
/** 允许一点点越界（有些导出工具会写 1.000001），超过这个就是坏文件 */
const EPS = 0.001

/** 在一条 1D 曲线里按归一化输入线性取样。 */
function sample1d(
  values: readonly number[], size: number, channel: number, input: number,
): number {
  const x = clamp01(input) * (size - 1)
  const x0 = Math.floor(x)
  const x1 = Math.min(x0 + 1, size - 1)
  const a = values[x0 * 3 + channel]!
  const b = values[x1 * 3 + channel]!
  return a + (b - a) * (x - x0)
}

export function parseCube(text: string): Cube {
  const lines = text.split(/\r?\n/)
  let size3d = 0
  let size1d = 0
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  let title: string | null = null
  const values: number[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line || line.startsWith('#')) continue
    const head = line.split(/\s+/)[0]!.toUpperCase()

    if (head === 'TITLE') {
      const m = /^TITLE\s+"?([^"]*)"?\s*$/i.exec(line)
      const t = (m?.[1] ?? '').trim()
      title = t || null
      continue
    }
    if (head === 'LUT_1D_SIZE') {
      const n = Number(line.split(/\s+/)[1])
      if (!Number.isInteger(n) || n < MIN_LUT_SIZE || n > MAX_LUT_1D_SIZE) {
        throw new LutParseError(n > MAX_LUT_1D_SIZE
          ? `这个 Lut 是 ${n} 级的，太大了 —— 1D 目前支持 ${MAX_LUT_1D_SIZE} 级以内。`
          : '这个文件不是 .cube 格式的。')
      }
      if (size1d || size3d) {
        throw new LutParseError('这个文件同时写了 1D 和 3D 的 LUT 尺寸，读不出来。')
      }
      size1d = n
      continue
    }
    if (head === 'LUT_3D_SIZE') {
      const n = Number(line.split(/\s+/)[1])
      if (!Number.isInteger(n) || n > MAX_LUT_SIZE || n < MIN_LUT_SIZE) {
        throw new LutParseError(n > MAX_LUT_SIZE
          ? `这个 Lut 是 ${n} 级的，太大了 —— 目前支持 ${MAX_LUT_SIZE} 级以内。`
          : '这个文件不是 .cube 格式的。')
      }
      if (size1d || size3d) {
        throw new LutParseError('这个文件同时写了 1D 和 3D 的 LUT 尺寸，读不出来。')
      }
      size3d = n
      continue
    }
    if (head === 'DOMAIN_MIN' || head === 'DOMAIN_MAX') {
      const nums = line.split(/\s+/).slice(1)
      const triple = nums.map(Number) as [number, number, number]
      if (triple.length !== 3 || triple.some((v) => !Number.isFinite(v))) {
        throw new LutParseError(`这个文件读不出来（第 ${i + 1} 行的数据不对），可能下载的时候坏了。`)
      }
      if (head === 'DOMAIN_MIN') domainMin = triple
      else domainMax = triple
      continue
    }

    // 还没见过尺寸声明就不是数据行 —— 前面出现的非关键字行说明这压根
    // 不是 .cube（比如一段普通文字），留到最后统一报"不是 .cube"，
    // 而不是拿它的行数去套数据行的规矩。
    if (size1d === 0 && size3d === 0) continue

    // 剩下的一律当数据行：恰好三个数，且都在 [0,1] 附近
    const parts = line.split(/\s+/)
    if (parts.length !== 3) {
      throw new LutParseError(`这个文件读不出来（第 ${i + 1} 行的数据不对），可能下载的时候坏了。`)
    }
    for (const p of parts) {
      const v = Number(p)
      if (!Number.isFinite(v) || v < -EPS || v > 1 + EPS) {
        throw new LutParseError(`这个文件读不出来（第 ${i + 1} 行的数据不对），可能下载的时候坏了。`)
      }
      values.push(clamp01(v))
    }
  }

  if (size1d === 0 && size3d === 0) throw new LutParseError('这个文件不是 .cube 格式的。')

  if (size1d > 0) {
    if (values.length !== size1d * 3) {
      throw new LutParseError(
        `这个文件读不出来（应该有 ${size1d} 行数据，实际读到 ${Math.floor(values.length / 3)} 行），` +
        '可能下载的时候坏了。')
    }
    // 1D LUT 是三条彼此独立的通道曲线。展开成同样可被现有 3D 管线取样的表：
    // 输入 (r,g,b) 分别走 R/G/B 曲线，输出才是三通道结果。网格按归一化
    // 坐标展开，因此仍保留原文件的 domain，让 shader 用同一套输入换算找格。
    const size = Math.min(MAX_LUT_SIZE, Math.max(MIN_LUT_SIZE, size1d))
    const rgba = new Uint8Array(size * size * size * 4)
    for (let b = 0; b < size; b++) {
      for (let g = 0; g < size; g++) {
        for (let r = 0; r < size; r++) {
          const t = size === 1 ? 0 : 1 / (size - 1)
          const offset = ((b * size + g) * size + r) * 4
          rgba[offset] = Math.round(sample1d(values, size1d, 0, r * t) * 255)
          rgba[offset + 1] = Math.round(sample1d(values, size1d, 1, g * t) * 255)
          rgba[offset + 2] = Math.round(sample1d(values, size1d, 2, b * t) * 255)
          rgba[offset + 3] = 255
        }
      }
    }
    return { size, rgba, domainMin, domainMax, title }
  }

  const size = size3d
  if (values.length !== size * size * size * 3) {
    throw new LutParseError(
      `这个文件读不出来（应该有 ${size * size * size} 行数据，实际读到 ${Math.floor(values.length / 3)} 行），` +
      '可能下载的时候坏了。')
  }

  const rgba = new Uint8Array(size * size * size * 4)
  for (let i = 0, o = 0; i < values.length; i += 3, o += 4) {
    rgba[o] = Math.round(values[i]! * 255)
    rgba[o + 1] = Math.round(values[i + 1]! * 255)
    rgba[o + 2] = Math.round(values[i + 2]! * 255)
    rgba[o + 3] = 255
  }
  return { size, rgba, domainMin, domainMax, title }
}

/** 名字合法吗（trim 之后 1–30 字）。 */
export const lutNameOk = (name: string): boolean => {
  const t = name.trim()
  return t.length >= 1 && t.length <= MAX_LUT_NAME
}

/** 两个名字算不算同一个（忽略首尾空格与大小写）—— 对话里对号唯一的判据。 */
export const sameLutName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * `LutRef` 的**形状**归一化（它存不存在由服务端查库判，见 server/luts.ts）。
 * amount 钳到 0–100 取整；id 必须是正整数，否则回 null（当"没有滤镜"）。
 */
export function normalizeLutRef(raw: unknown): LutRef | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const lutId = Number(o.lutId)
  const amount = Number(o.amount)
  if (!Number.isInteger(lutId) || lutId <= 0) return null
  if (!Number.isFinite(amount)) return null
  return { lutId, amount: Math.max(0, Math.min(100, Math.round(amount))) }
}
