import type { Adjustments } from '../../shared/adjustments.ts'
import type { LensInfo } from './photoInfo.ts'

/**
 * 内置镜头配置（★ 2026-10-20）。
 *
 * 市面上的修图产品会按 EXIF 自动套镜头校正；这一层补的就是"认出镜头 →
 * 给一组合理的畸变 / 暗角 / 色差起点"。**它不是测量级标定**：同一支镜头在
 * 不同焦段、不同机身上的表现会变，所以数值是保守的近似值，套用后仍可拖
 * 「镜头校正」那三根滑杆微调。UI 也把这句话写出来，不假装是官方配置文件。
 *
 * 匹配只做字符串包含 + 焦段范围，纯函数、无网络、无 DOM。
 */
type ValueAtFocal = number | readonly [wide: number, tele: number]

export type LensProfile = {
  id: string
  maker: string
  label: string
  /** 用户在本机保存的配置（内置配置没有这个标记）。 */
  custom?: boolean
  /** 全部命中才算（规范化后做子串匹配）。 */
  lensPatterns: readonly string[]
  /** 镜头字段缺失时，按机身认固定镜头相机（手机等）。 */
  cameraPatterns?: readonly string[]
  /** 这支镜头的实际焦段范围；缺省 = 定焦或未知。 */
  focalRange?: readonly [number, number]
  distortion: ValueAtFocal
  vignette: ValueAtFocal
  chromatic: ValueAtFocal
  note?: string
}

const normalize = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9.+-]/g, '')

/**
 * 数值是"校正方向"的起点，不是镜头缺陷本身：
 * 广角变焦的桶形更明显 → 正值更大；定焦更轻。单位跟参数一致（-100~100）。
 */
export const LENS_PROFILES: readonly LensProfile[] = [
  {
    id: 'sony-fe-24-70-gm2', maker: 'Sony', label: 'Sony FE 24-70mm F2.8 GM II',
    lensPatterns: ['fe24-70mmf2.8gm'], focalRange: [24, 70],
    distortion: [34, 12], vignette: [26, 14], chromatic: [8, 5],
  },
  {
    id: 'sony-fe-16-35-gm', maker: 'Sony', label: 'Sony FE 16-35mm F2.8 GM',
    lensPatterns: ['fe16-35mmf2.8gm'], focalRange: [16, 35],
    distortion: [42, 26], vignette: [30, 20], chromatic: [10, 7],
  },
  {
    id: 'sony-fe-85-18', maker: 'Sony', label: 'Sony FE 85mm F1.8',
    lensPatterns: ['fe85mmf1.8'], focalRange: [85, 85],
    distortion: 6, vignette: 24, chromatic: 5,
  },
  {
    id: 'sony-fe-35-18', maker: 'Sony', label: 'Sony FE 35mm F1.8',
    lensPatterns: ['fe35mmf1.8'], focalRange: [35, 35],
    distortion: 10, vignette: 22, chromatic: 6,
  },
  {
    id: 'canon-rf-24-105-f4l', maker: 'Canon', label: 'Canon RF 24-105mm F4 L IS USM',
    lensPatterns: ['rf24-105mmf4lisusm'], focalRange: [24, 105],
    distortion: [30, 12], vignette: [24, 16], chromatic: [8, 5],
  },
  {
    id: 'canon-rf-50-18', maker: 'Canon', label: 'Canon RF 50mm F1.8 STM',
    lensPatterns: ['rf50mmf1.8stm'], focalRange: [50, 50],
    distortion: 5, vignette: 26, chromatic: 4,
  },
  {
    id: 'canon-ef-50-18', maker: 'Canon', label: 'Canon EF 50mm F1.8 STM',
    lensPatterns: ['ef50mmf1.8stm'], focalRange: [50, 50],
    distortion: 4, vignette: 24, chromatic: 5,
  },
  {
    id: 'canon-ef-24-70-28l2', maker: 'Canon', label: 'Canon EF 24-70mm F2.8L II USM',
    lensPatterns: ['ef24-70mmf2.8liiusm'], focalRange: [24, 70],
    distortion: [30, 12], vignette: [26, 16], chromatic: [9, 5],
  },
  {
    id: 'nikon-z-24-70-28s', maker: 'Nikon', label: 'Nikon NIKKOR Z 24-70mm F2.8 S',
    lensPatterns: ['z24-70mmf2.8s'], focalRange: [24, 70],
    distortion: [28, 10], vignette: [22, 13], chromatic: [7, 4],
  },
  {
    id: 'nikon-z-50-18s', maker: 'Nikon', label: 'Nikon NIKKOR Z 50mm F1.8 S',
    lensPatterns: ['z50mmf1.8s'], focalRange: [50, 50],
    distortion: 5, vignette: 22, chromatic: 4,
  },
  {
    id: 'fuji-xf-18-55', maker: 'Fujifilm', label: 'Fujifilm XF 18-55mm F2.8-4 R LM OIS',
    lensPatterns: ['xf18-55mm'], focalRange: [18, 55],
    distortion: [26, 10], vignette: [22, 12], chromatic: [6, 4],
  },
  {
    id: 'fuji-xf-35-14', maker: 'Fujifilm', label: 'Fujifilm XF 35mm F1.4 R',
    lensPatterns: ['xf35mmf1.4'], focalRange: [35, 35],
    distortion: 8, vignette: 20, chromatic: 5,
  },
  {
    id: 'sigma-35-art', maker: 'Sigma', label: 'Sigma 35mm F1.4 DG HSM Art',
    lensPatterns: ['35mmf1.4dghsm'], focalRange: [35, 35],
    distortion: 12, vignette: 26, chromatic: 7,
  },
  {
    id: 'tamron-28-75-28', maker: 'Tamron', label: 'Tamron 28-75mm F2.8 Di III RXD',
    lensPatterns: ['28-75mmf2.8diiii'], focalRange: [28, 75],
    distortion: [30, 12], vignette: [22, 12], chromatic: [7, 4],
  },
  {
    id: 'iphone-main', maker: 'Apple', label: 'iPhone 主摄（广角）',
    lensPatterns: [], cameraPatterns: ['iphone'],
    distortion: 14, vignette: 6, chromatic: 3,
    note: '手机通常已在机内校正；这里只做很轻的补齐。',
  },
]

export type LensMatch = {
  profile: LensProfile
  /** 用来算数值的焦段；定焦 / 未知时用范围起点。 */
  focalMm: number | null
  matchedBy: 'lens' | 'camera'
}

function focusValue(value: ValueAtFocal, focalMm: number | null, range?: readonly [number, number]): number {
  if (typeof value === 'number') return value
  const [wide, tele] = value
  if (!range || focalMm === null) return wide
  const t = Math.max(0, Math.min(1, (focalMm - range[0]) / Math.max(1e-6, range[1] - range[0])))
  return wide + (tele - wide) * t
}

/** 这套配置在当前焦段下的三个校正值（已四舍五入）。 */
export function lensProfileAdjustments(
  profile: LensProfile,
  focalMm: number | null,
): Pick<Adjustments, 'lensDistortion' | 'lensVignette' | 'lensChromatic'> {
  const clamp = (v: number) => Math.max(-100, Math.min(100, Math.round(v)))
  return {
    lensDistortion: clamp(focusValue(profile.distortion, focalMm, profile.focalRange)),
    lensVignette: clamp(focusValue(profile.vignette, focalMm, profile.focalRange)),
    lensChromatic: clamp(focusValue(profile.chromatic, focalMm, profile.focalRange)),
  }
}

/**
 * 按 EXIF 找最贴近的一条配置。
 *
 * 优先认镜头型号（子串全命中、再比命中长度）；镜头字段缺失时才按机身认
 * 固定镜头相机。认不出来就返回 null —— 宁可让用户手选，也不硬套一套错参数。
 */
export function matchLensProfile(info: LensInfo, extraProfiles: readonly LensProfile[] = []): LensMatch | null {
  const allProfiles = [...extraProfiles, ...LENS_PROFILES]
  const lens = normalize(info.lens ?? '')
  if (lens) {
    const candidates = allProfiles
      .filter(p => p.lensPatterns.length > 0)
      .map(profile => {
        const patterns = profile.lensPatterns.map(normalize)
        if (!patterns.every(p => lens.includes(p))) return null
        const score = patterns.reduce((sum, p) => sum + p.length, 0)
        return { profile, score }
      })
      .filter((x): x is { profile: LensProfile; score: number } => !!x)
      .sort((a, b) => b.score - a.score)
    const hit = candidates[0]
    if (hit) {
      const focal = info.focalMm ?? info.focal35mm
      return { profile: hit.profile, focalMm: focal, matchedBy: 'lens' }
    }
  }

  const camera = normalize([info.make, info.model].filter(Boolean).join(' '))
  if (camera) {
    const hit = allProfiles.find(p =>
      p.cameraPatterns?.some(pattern => camera.includes(normalize(pattern))))
    if (hit) {
      return { profile: hit, focalMm: info.focalMm ?? info.focal35mm, matchedBy: 'camera' }
    }
  }
  return null
}

/** 手动选择用的配置（带一个"不套用"的空项由 UI 自己加）。 */
export function lensProfileById(id: string): LensProfile | null {
  return LENS_PROFILES.find(p => p.id === id) ?? null
}
