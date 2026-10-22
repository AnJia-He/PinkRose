export const DEFAULT_STYLE_KEY = 'pinkrose:default-style:v1'

/** 空串 / 不存在的风格都回 null（= 原图起手）。 */
export function normalizeDefaultStyle(value: unknown, knownIds: readonly string[]): string | null {
  if (typeof value !== 'string' || !value) return null
  return knownIds.includes(value) ? value : null
}

export function getDefaultStyle(knownIds: readonly string[]): string | null {
  try {
    return normalizeDefaultStyle(wx.getStorageSync(DEFAULT_STYLE_KEY), knownIds)
  } catch {
    return null
  }
}

export function setDefaultStyle(value: string | null): void {
  if (!value) {
    wx.removeStorageSync(DEFAULT_STYLE_KEY)
    return
  }
  wx.setStorageSync(DEFAULT_STYLE_KEY, value)
}
