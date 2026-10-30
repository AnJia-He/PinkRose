import type { ExportAspect } from '../export/save.ts'

export type BatchOrientation =
  'original' | 'left' | 'right' | 'flip180' | 'mirror-h' | 'mirror-v'

export type BatchNamingMode = 'source' | 'sequence' | 'date'

export type BatchPrefs = {
  aspect: ExportAspect
  orientation: BatchOrientation
  autoEnhance: boolean
  autoLens: boolean
  smartCrop: boolean
  nameMode: BatchNamingMode
  namePrefix: string
}

export const DEFAULT_BATCH_PREFS: BatchPrefs = {
  aspect: 'original',
  orientation: 'original',
  autoEnhance: false,
  autoLens: false,
  smartCrop: false,
  nameMode: 'source',
  namePrefix: 'PinkRose',
}

const KEY = 'pinkrose.batch.prefs.v1'
const ASPECTS = new Set<ExportAspect>(['original', '1:1', '4:5', '3:4', '4:3', '9:16', '16:9'])
const ORIENTATIONS = new Set<BatchOrientation>([
  'original', 'left', 'right', 'flip180', 'mirror-h', 'mirror-v',
])
const NAMING = new Set<BatchNamingMode>(['source', 'sequence', 'date'])

export function normalizeBatchPrefs(raw: unknown): BatchPrefs {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Partial<Record<keyof BatchPrefs, unknown>>
    : {}
  return {
    aspect: typeof value.aspect === 'string' && ASPECTS.has(value.aspect as ExportAspect)
      ? value.aspect as ExportAspect : DEFAULT_BATCH_PREFS.aspect,
    orientation: typeof value.orientation === 'string'
      && ORIENTATIONS.has(value.orientation as BatchOrientation)
      ? value.orientation as BatchOrientation : DEFAULT_BATCH_PREFS.orientation,
    autoEnhance: value.autoEnhance === true,
    autoLens: value.autoLens === true,
    smartCrop: value.smartCrop === true,
    nameMode: typeof value.nameMode === 'string'
      && NAMING.has(value.nameMode as BatchNamingMode)
      ? value.nameMode as BatchNamingMode : DEFAULT_BATCH_PREFS.nameMode,
    namePrefix: typeof value.namePrefix === 'string'
      ? value.namePrefix.slice(0, 40) : DEFAULT_BATCH_PREFS.namePrefix,
  }
}

export function loadBatchPrefs(): BatchPrefs {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_BATCH_PREFS }
    const raw = localStorage.getItem(KEY)
    return raw ? normalizeBatchPrefs(JSON.parse(raw)) : { ...DEFAULT_BATCH_PREFS }
  } catch {
    return { ...DEFAULT_BATCH_PREFS }
  }
}

export function saveBatchPrefs(prefs: BatchPrefs): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, JSON.stringify(normalizeBatchPrefs(prefs)))
    }
  } catch {
    // 隐私模式 / 禁用存储：设置仍对本次会话有效。
  }
}

export function clearBatchPrefs(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY)
  } catch {
    // 同上。
  }
}
