export type CameraBracketField = {
  type: 'number' | 'select'
  readOnly?: boolean
  min?: number
  max?: number
  step?: number
  options?: readonly { value: string }[]
}

export type BracketShots = 3 | 5
export type BracketStep = 0.3 | 0.7 | 1
export type FocusBracketSpan = 5 | 10 | 20
export type FocusBracketField = CameraBracketField & { key: string; label?: string }

/**
 * 为相机当前的曝光补偿能力生成一组居中的包围曝光值。
 * 范围或选项不够时返回 null，避免拍出一组重复曝光。
 */
export function bracketExposureValues(
  base: number,
  shots: BracketShots,
  step: BracketStep,
  field: CameraBracketField,
): number[] | null {
  if (!Number.isFinite(base)) return null
  const center = (shots - 1) / 2
  const targets = Array.from(
    { length: shots },
    (_, i) => base + (i - center) * step,
  )

  let values: number[]
  if (field.type === 'select') {
    const options = [...new Set(
      (field.options ?? [])
        .map(option => {
          const value = Number(option.value)
          return Number.isFinite(value) ? value : null
        })
        .filter((value): value is number => value !== null),
    )].sort((a, b) => a - b)
    if (options.length < shots) return null
    values = targets.map(target => options.reduce((best, value) =>
      Math.abs(value - target) < Math.abs(best - target) ? value : best,
    ))
  } else {
    const min = field.min ?? -Infinity
    const max = field.max ?? Infinity
    values = targets.map(target =>
      Number(Math.max(min, Math.min(max, target)).toFixed(6)))
  }

  if (new Set(values).size !== shots) return null
  return values
}

const FOCUS_POSITION_RE = /^(manualfocus|manualfocusdrive|focusposition|focusdistance|focusdrive|focus)$/i

/**
 * 从相机 schema 里找“可写焦点位置”。不同厂商命名不同，但焦点模式
 * （focusMode / autofocus）不是位置，必须排除；摆位会按 readOnly 过滤。
 */
export function findFocusBracketField(
  fields: readonly FocusBracketField[],
): FocusBracketField | null {
  return fields.find(field =>
    !field.readOnly
    && FOCUS_POSITION_RE.test(field.key.replace(/[-_\s]/g, ''))) ?? null
}

/**
 * 一组焦点位置：以当前焦点为中心，按相机焦点范围的百分比向两侧展开。
 * 数值按下拉选项 / 最小步长吸附，重复值直接判为不可用。
 */
export function bracketFocusValues(
  base: number, shots: BracketShots, spanPercent: FocusBracketSpan,
  field: FocusBracketField,
): number[] | null {
  if (!Number.isFinite(base)) return null
  let min: number
  let max: number
  let options: number[] | null = null
  if (field.type === 'select') {
    options = [...new Set(
      (field.options ?? [])
        .map(option => Number(option.value))
        .filter(Number.isFinite),
    )].sort((a, b) => a - b)
    if (options.length < shots) return null
    min = options[0]!
    max = options[options.length - 1]!
  } else {
    min = field.min ?? -Infinity
    max = field.max ?? Infinity
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return null
  }

  const center = (shots - 1) / 2
  const step = (max - min) * (spanPercent / 100) / Math.max(1, shots - 1)
  const unitStep = field.type === 'number' && field.step && field.step > 0
    ? field.step
    : null
  const values = Array.from({ length: shots }, (_, index) => {
    const target = Math.max(min, Math.min(max, base + (index - center) * step))
    if (options) {
      return options.reduce((best, value) =>
        Math.abs(value - target) < Math.abs(best - target) ? value : best)
    }
    if (!unitStep) return Number(target.toFixed(6))
    const snapped = min + Math.round((target - min) / unitStep) * unitStep
    return Number(Math.max(min, Math.min(max, snapped)).toFixed(6))
  })
  if (new Set(values).size !== shots) return null
  return values
}
