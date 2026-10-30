import { PRESETS, type Preset } from '../core/presets'

/**
 * 「默认风格」（★ 2026-10-19）—— 设置页选一套预设，下一张新照片从它起手。
 *
 * 只存**预设 id**，不存整套参数：
 *   · 内置预设以后调了色，用户再打开新照片会自然跟上；
 *   · 「我的预设」改名 / 改参数同理；
 *   · 参数本身仍然只有 `params` 一个来源，偏好不参与渲染。
 *
 * 空 / 缺失 = 不预设。id 空间沿用 `core/presets` 的约定：内置是非纯数字串，
 * 我的预设是服务端数字 id 的字符串形式，两边不会撞。
 */
export const DEFAULT_STYLE_KEY = 'pinkrose.defaultStyle'

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 把 localStorage / 账号里的任意值钳成一个可用的预设 id；坏值一律回 null。 */
export function normalizeDefaultStyleId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return ID_RE.test(id) ? id : null
}

/** 读本机默认风格。隐私模式 / 坏数据都回 null（= 不预设）。 */
export function loadDefaultStyleId(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(DEFAULT_STYLE_KEY)
    if (!raw) return null
    // 兼容以后可能改成 JSON 字符串的写法；今天存的是裸 id。
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'string') return normalizeDefaultStyleId(parsed)
    } catch {
      // 裸 id 不是合法 JSON，走下面那条正常路。
    }
    return normalizeDefaultStyleId(raw)
  } catch {
    return null
  }
}

/** 写本机默认风格；null = 清掉。 */
export function saveDefaultStyleId(id: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    const safe = normalizeDefaultStyleId(id)
    if (safe) localStorage.setItem(DEFAULT_STYLE_KEY, safe)
    else localStorage.removeItem(DEFAULT_STYLE_KEY)
  } catch {
    // 隐私模式 / 禁用存储：账号那一份仍可生效，本机这次不记。
  }
}

/**
 * 在「内置 + 我的预设」里找默认风格。
 *
 * 找不到（预设被删、账号里的旧 id、清单还没到手）回 null —— 调用方回 `ZERO`，
 * 新照片照常能打开，不把一张照片挡在门外。
 */
export function resolveDefaultStyle(
  id: string | null | undefined,
  mine: readonly Preset[] = [],
): Preset | null {
  const safe = normalizeDefaultStyleId(id)
  if (!safe) return null
  return [...PRESETS, ...mine].find(p => p.id === safe) ?? null
}
