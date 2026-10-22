import type { WorkEntry } from './works'

const KEY = 'pinkrose:edit-work:v1'

function valid(value: unknown): value is WorkEntry {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<WorkEntry>
  return typeof item.id === 'string'
    && typeof item.file === 'string'
    && typeof item.thumb === 'string'
    && Number.isFinite(item.w) && Number(item.w) > 0
    && Number.isFinite(item.h) && Number(item.h) > 0
    && Number.isFinite(item.bytes)
    && Number.isFinite(item.at)
}

/** tab 页之间不能带 query，用一次性 storage 把作品交给修图页。 */
export function requestEdit(work: WorkEntry): void {
  wx.setStorageSync(KEY, work)
}

/** 读过立刻删除；坏记录不污染编辑器。 */
export function consumePendingEdit(): WorkEntry | null {
  let raw: unknown
  try {
    raw = wx.getStorageSync(KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    wx.removeStorageSync(KEY)
  } catch {
    // 删除失败也让调用方先拿到有效记录。
  }
  return valid(raw) ? raw : null
}
