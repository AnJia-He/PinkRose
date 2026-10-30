import type { Adjustments } from '../../shared/adjustments.ts'

export type WhiteBalancePresetId =
  'daylight' | 'cloudy' | 'shade' | 'tungsten' | 'fluorescent'

export type WhiteBalancePreset = {
  id: WhiteBalancePresetId
  label: string
  temperature: number
  tint: number
}

/** 相对白平衡起点；用户仍可在色温 / 色调滑杆上继续微调。 */
export const WHITE_BALANCE_PRESETS: readonly WhiteBalancePreset[] = [
  { id: 'daylight', label: '日光', temperature: 0, tint: 0 },
  { id: 'cloudy', label: '阴天', temperature: 12, tint: 4 },
  { id: 'shade', label: '阴影', temperature: 22, tint: 7 },
  { id: 'tungsten', label: '钨丝灯', temperature: -36, tint: 5 },
  { id: 'fluorescent', label: '荧光灯', temperature: -16, tint: 18 },
]

export function applyWhiteBalancePreset(
  current: Adjustments, id: WhiteBalancePresetId,
): Adjustments {
  const preset = WHITE_BALANCE_PRESETS.find(item => item.id === id)
  return preset
    ? { ...current, temperature: preset.temperature, tint: preset.tint }
    : { ...current }
}

export function activeWhiteBalancePreset(
  current: Adjustments,
): WhiteBalancePresetId | null {
  return WHITE_BALANCE_PRESETS.find(preset =>
    current.temperature === preset.temperature && current.tint === preset.tint,
  )?.id ?? null
}
