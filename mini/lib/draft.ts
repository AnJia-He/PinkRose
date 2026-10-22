import type { Adjustments } from './shared/adjustments'

const KEY = 'pinkrose:draft:v1'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000
const DIR_NAME = 'draft'
const PHOTO_NAME = 'current.jpg'

export interface EditorDraft {
  version: 1
  photoPath: string
  width: number
  height: number
  params: Adjustments
  presetId: string | null
  styleAmount: number
  at: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 纯校验：恢复坏草稿时宁可回空态，也不把 NaN / 缺字段送进渲染管线。 */
export function normalizeDraft(
  value: unknown,
  zero: Adjustments,
  now = Date.now(),
): EditorDraft | null {
  if (!isRecord(value) || value.version !== 1) return null
  if (typeof value.photoPath !== 'string' || !value.photoPath) return null
  const width = Number(value.width)
  const height = Number(value.height)
  const at = Number(value.at)
  const styleAmount = Number(value.styleAmount)
  if (!Number.isFinite(width) || width <= 0) return null
  if (!Number.isFinite(height) || height <= 0) return null
  if (!Number.isFinite(at) || at < now - MAX_AGE_MS || at > now + FUTURE_TOLERANCE_MS) return null
  if (!Number.isFinite(styleAmount) || styleAmount < 0 || styleAmount > 100) return null
  if (value.presetId !== null && typeof value.presetId !== 'string') return null
  if (!isRecord(value.params)) return null

  const params = { ...zero }
  for (const key of Object.keys(zero) as (keyof Adjustments)[]) {
    const raw = value.params[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) params[key] = raw
  }
  return {
    version: 1,
    photoPath: value.photoPath,
    width: Math.round(width),
    height: Math.round(height),
    params,
    presetId: value.presetId,
    styleAmount,
    at,
  }
}

function draftPhotoPath(): string {
  return wx.env.USER_DATA_PATH + '/' + DIR_NAME + '/' + PHOTO_NAME
}

function ensureDir(): void {
  const fsm = wx.getFileSystemManager()
  const dir = wx.env.USER_DATA_PATH + '/' + DIR_NAME
  try {
    fsm.accessSync(dir)
  } catch {
    fsm.mkdirSync(dir, true)
  }
}

/** 把当前照片复制成草稿专用文件；临时路径不会被微信提前清掉。 */
export function preparePhoto(sourcePath: string): Promise<string> {
  ensureDir()
  const target = draftPhotoPath()
  if (sourcePath === target) return Promise.resolve(target)
  return new Promise((ok, no) => {
    wx.getFileSystemManager().copyFile({
      srcPath: sourcePath,
      destPath: target,
      success: () => ok(target),
      fail: e => no(new Error('草稿照片存不下来：' + String((e && e.errMsg) || e))),
    })
  })
}

export function save(input: Omit<EditorDraft, 'version' | 'at'>): EditorDraft {
  const value: EditorDraft = { ...input, version: 1, at: Date.now() }
  wx.setStorageSync(KEY, value)
  return value
}

export function load(zero: Adjustments, now = Date.now()): EditorDraft | null {
  let raw: unknown
  try {
    raw = wx.getStorageSync(KEY)
  } catch {
    return null
  }
  const value = normalizeDraft(raw, zero, now)
  if (!value) {
    clear()
    return null
  }
  try {
    wx.getFileSystemManager().accessSync(value.photoPath)
    return value
  } catch {
    clear()
    return null
  }
}

export function clear(): void {
  try {
    wx.removeStorageSync(KEY)
  } catch {
    // storage 已经空时删除也会失败，不影响后续。
  }
  try {
    wx.getFileSystemManager().unlinkSync(draftPhotoPath())
  } catch {
    // 文件已经不在就是目标状态。
  }
}

export const draft = { preparePhoto, save, load, clear }
