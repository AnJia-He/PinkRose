import {
  DEFAULT_EXPORT_OPTIONS,
  type ExportAspect, type ExportColorSpace, type ExportFit, type ExportFormat,
  type ExportOptions,
} from './save.ts'

/**
 * 「导出偏好」的本地存储（★ 2026-10-19）。
 *
 * 只存**用户主动设为默认**的那一套；当前照片上的临时改动不往里写。
 * 本机 localStorage 负责首屏 / 离线兜底；登录后账号里的偏好会覆盖它，
 * 保存时两边一起写，换设备登录同一账号也能沿用。
 */
export const EXPORT_DEFAULTS_KEY = 'pinkrose.export.defaults'

const FORMATS: readonly ExportFormat[] = [
  'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/tiff',
]
const ASPECTS: readonly ExportAspect[] = [
  'original', '1:1', '4:5', '3:4', '4:3', '9:16', '16:9',
]
const FITS: readonly ExportFit[] = ['crop', 'blur', 'mirror']
const COLOR_SPACES: readonly ExportColorSpace[] = ['srgb', 'display-p3']
const optionalText = (value: unknown, max: number): string => (
  typeof value === 'string' ? value.trim().slice(0, max) : ''
)

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback

const clampQuality = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n)
    ? Math.max(60, Math.min(100, Math.round(n)))
    : DEFAULT_EXPORT_OPTIONS.qualityPct
}

const normalizeLongEdge = (value: unknown): number | null => {
  if (value === null) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.max(256, Math.min(12_000, Math.round(n)))
}

/** 把 localStorage / 账号里的任意对象钳成一套可用的导出设置。 */
export function normalizeExportDefaults(input: unknown): ExportOptions {
  const o = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
  return {
    format: oneOf(o.format, FORMATS, DEFAULT_EXPORT_OPTIONS.format),
    qualityPct: clampQuality(o.qualityPct),
    longEdge: normalizeLongEdge(o.longEdge),
    aspect: oneOf(o.aspect, ASPECTS, DEFAULT_EXPORT_OPTIONS.aspect ?? 'original'),
    fit: oneOf(o.fit, FITS, DEFAULT_EXPORT_OPTIONS.fit ?? 'crop'),
    preserveMetadata: typeof o.preserveMetadata === 'boolean'
      ? o.preserveMetadata
      : DEFAULT_EXPORT_OPTIONS.preserveMetadata !== false,
    preserveLocation: typeof o.preserveLocation === 'boolean'
      ? o.preserveLocation
      : DEFAULT_EXPORT_OPTIONS.preserveLocation !== false,
    colorSpace: oneOf(
      o.colorSpace,
      COLOR_SPACES,
      DEFAULT_EXPORT_OPTIONS.colorSpace ?? 'srgb',
    ),
    creator: optionalText(o.creator, 160),
    copyright: optionalText(o.copyright, 240),
  }
}

/** 从 localStorage 读一套校验过的导出偏好；坏数据 / 隐私模式一律回默认。 */
export function loadExportDefaults(): ExportOptions {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_EXPORT_OPTIONS }
    const raw = localStorage.getItem(EXPORT_DEFAULTS_KEY)
    if (!raw) return { ...DEFAULT_EXPORT_OPTIONS }
    return normalizeExportDefaults(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_EXPORT_OPTIONS }
  }
}

/** 只存 normalize 之后的那几项，防止把界面临时状态 / 脏字段带进本地。 */
export function saveExportDefaults(options: ExportOptions): void {
  try {
    if (typeof localStorage === 'undefined') return
    const safe = normalizeExportDefaults(options)
    localStorage.setItem(EXPORT_DEFAULTS_KEY, JSON.stringify(safe))
  } catch {
    // 隐私模式 / 禁用存储：不影响本次导出。
  }
}
