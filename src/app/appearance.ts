/**
 * 修图界面的外观偏好（★ 2026-10-19）。
 *
 * 默认深色：编辑器 chrome 用中性深色，减少环境光对照片明暗和色温判断的影响。
 * 浅色是可选项：白天、投影或系统本身偏亮的场景，用户可以自己切。
 *
 * 只影响 `.shell`（登录后的 App 内页）；落地页 / 登录页继续跟随系统。
 */
export type Appearance = 'dark' | 'light'

export const APPEARANCE_KEY = 'pinkrose.appearance'

export function normalizeAppearance(value: unknown): Appearance {
  return value === 'light' ? 'light' : 'dark'
}

export function loadAppearance(): Appearance {
  try {
    if (typeof localStorage === 'undefined') return 'dark'
    return normalizeAppearance(localStorage.getItem(APPEARANCE_KEY))
  } catch {
    return 'dark'
  }
}

export function saveAppearance(value: Appearance): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(APPEARANCE_KEY, normalizeAppearance(value))
  } catch {
    // 隐私模式 / 禁用存储：账号那一份仍可生效，本机这次不记。
  }
}
