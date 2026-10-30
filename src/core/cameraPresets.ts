/**
 * 相机拍摄参数快照（★ 2026-10-20）。
 *
 * 相机桥的连接、实时取景和单次参数已经有了；摄影师真正反复做的是
 * "把这套 ISO / 光圈 / 快门 / 白平衡 存下来，下一场再套回去"。
 * 这里只存 key/value，应用时按当前相机 adapter 的 schema 过滤：不同机身
 * 不支持的项不会硬塞，数值会按 min/max/step 和下拉选项校验。
 */
const KEY = 'pinkrose.cameraPresets.v1'
export const MAX_CAMERA_PRESETS = 20

export type CameraPresetSettings = Record<string, string | number>

export type CameraPreset = {
  id: string
  name: string
  model: string
  settings: CameraPresetSettings
  createdAt: number
}

export type PresetField = {
  key: string
  type: 'number' | 'select'
  readOnly?: boolean
  min?: number
  max?: number
  step?: number
  options?: readonly { value: string }[]
}

function cleanSettings(raw: unknown): CameraPresetSettings {
  if (!raw || typeof raw !== 'object') return {}
  const out: CameraPresetSettings = {}
  for (const [key, value] of Object.entries(raw).slice(0, 40)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (typeof value === 'string') out[key] = value.slice(0, 80)
  }
  return out
}

function readStored(): CameraPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter((row): row is CameraPreset => !!row
      && typeof row.id === 'string'
      && typeof row.name === 'string'
      && typeof row.model === 'string')
      .map(row => ({
        id: row.id.slice(0, 80),
        name: row.name.trim().slice(0, 40),
        model: row.model.slice(0, 80),
        settings: cleanSettings(row.settings),
        createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
      }))
      .filter(row => row.name.length > 0)
  } catch {
    return []
  }
}

function writeStored(rows: CameraPreset[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(rows)) } catch { /* 隐私模式 / 配额满 */ }
}

export function loadCameraPresets(): CameraPreset[] {
  return readStored()
}

export function saveCameraPreset(
  name: string, model: string, settings: CameraPresetSettings,
): CameraPreset[] {
  const cleanName = name.trim().slice(0, 40)
  if (!cleanName) return readStored()
  const cleanModel = model.trim().slice(0, 80)
  const rows = readStored().filter(row => !(row.name === cleanName && row.model === cleanModel))
  rows.push({
    id: `camera-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: cleanName,
    model: cleanModel,
    settings: cleanSettings(settings),
    createdAt: Date.now(),
  })
  writeStored(rows.sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_CAMERA_PRESETS))
  return readStored()
}

export function deleteCameraPreset(id: string): CameraPreset[] {
  writeStored(readStored().filter(row => row.id !== id))
  return readStored()
}

/**
 * 把一条快照翻译成当前相机能接受的 patch。
 * 读不懂 / 不支持的 key 直接跳过；数字按下拉/范围/步长钳好。
 */
export function applyPresetToSchema(
  preset: CameraPreset,
  schema: readonly PresetField[],
  current: CameraPresetSettings,
): CameraPresetSettings {
  const out: CameraPresetSettings = {}
  for (const field of schema) {
    if (field.readOnly) continue
    const value = preset.settings[field.key]
    if (value === undefined) continue
    if (field.type === 'select') {
      const text = String(value)
      if (field.options && !field.options.some(option => option.value === text)) continue
      out[field.key] = text
      continue
    }
    let number = Number(value)
    if (!Number.isFinite(number)) continue
    if (field.min !== undefined) number = Math.max(field.min, number)
    if (field.max !== undefined) number = Math.min(field.max, number)
    if (field.step && field.step > 0) {
      const base = field.min ?? 0
      number = base + Math.round((number - base) / field.step) * field.step
      number = Number(number.toFixed(6))
      if (field.min !== undefined) number = Math.max(field.min, number)
      if (field.max !== undefined) number = Math.min(field.max, number)
    }
    // 当前值本来就是一个合法数字；快照值只是候选，不会被强行塞进 schema 外的键。
    if (current[field.key] === undefined || typeof current[field.key] === 'number') {
      out[field.key] = number
    }
  }
  return out
}
