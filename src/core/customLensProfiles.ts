import type { Adjustments } from '../../shared/adjustments.ts'
import type { LensProfile } from './lensProfile.ts'

/**
 * 用户自己的镜头配置（★ 2026-10-20）。
 *
 * 内置库只能覆盖常见镜头；冷门机身 / 转接环 / 电影镜头的真实畸变各不相同。
 * 这里把用户调好的三根校正按"镜头型号"存进本机 localStorage，下次同一支
 * 镜头（以及批量处理）按 EXIF 自动认回来。只存数值和型号文本，不碰照片。
 */
const KEY = 'pinkrose.lensProfiles.v1'
export const MAX_CUSTOM_LENS_PROFILES = 20

type Stored = {
  id: string
  name: string
  lensText?: string
  cameraText?: string
  distortion: number
  vignette: number
  chromatic: number
  createdAt: number
}

export type CustomLensProfileInput = {
  name: string
  lensText?: string | null
  cameraText?: string | null
  distortion: number
  vignette: number
  chromatic: number
}

const clamp = (v: number) => Number.isFinite(v) ? Math.max(-100, Math.min(100, Math.round(v))) : 0
const cleanText = (v: string | null | undefined) => (v ?? '').trim().slice(0, 160)

function readStored(): Stored[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter((row): row is Stored => !!row
      && typeof row.id === 'string'
      && typeof row.name === 'string'
      && typeof row.distortion === 'number'
      && typeof row.vignette === 'number'
      && typeof row.chromatic === 'number')
      .map(row => ({
        ...row,
        id: row.id.slice(0, 80),
        name: row.name.trim().slice(0, 40),
        lensText: cleanText(row.lensText),
        cameraText: cleanText(row.cameraText),
        distortion: clamp(row.distortion),
        vignette: clamp(row.vignette),
        chromatic: clamp(row.chromatic),
        createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
      }))
      .filter(row => row.name.length > 0)
  } catch {
    return []
  }
}

function writeStored(rows: Stored[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(rows)) } catch { /* 隐私模式 / 配额满：本次仍返回内存结果 */ }
}

export function customLensProfiles(): LensProfile[] {
  return readStored().map(row => ({
    id: row.id,
    maker: '我的配置',
    label: row.name,
    custom: true,
    lensPatterns: row.lensText ? [row.lensText] : [],
    cameraPatterns: !row.lensText && row.cameraText ? [row.cameraText] : [],
    distortion: row.distortion,
    vignette: row.vignette,
    chromatic: row.chromatic,
    note: '本机保存的自定义配置',
  }))
}

export function saveCustomLensProfile(input: CustomLensProfileInput): LensProfile[] {
  const name = input.name.trim().slice(0, 40)
  if (!name) return customLensProfiles()
  const lensText = cleanText(input.lensText)
  const cameraText = cleanText(input.cameraText)
  const rows = readStored().filter(row => row.name !== name)
  rows.push({
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    lensText,
    cameraText,
    distortion: clamp(input.distortion),
    vignette: clamp(input.vignette),
    chromatic: clamp(input.chromatic),
    createdAt: Date.now(),
  })
  writeStored(rows.sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_CUSTOM_LENS_PROFILES))
  return customLensProfiles()
}

export function deleteCustomLensProfile(id: string): LensProfile[] {
  writeStored(readStored().filter(row => row.id !== id))
  return customLensProfiles()
}

export function customLensAdjustments(profile: LensProfile):
Pick<Adjustments, 'lensDistortion' | 'lensVignette' | 'lensChromatic'> {
  const value = (v: LensProfile['distortion']) => clamp(typeof v === 'number' ? v : v[0])
  return {
    lensDistortion: value(profile.distortion),
    lensVignette: value(profile.vignette),
    lensChromatic: value(profile.chromatic),
  }
}
