import { ZERO, type Adjustments } from '../../shared/adjustments.ts'

export type Preset = {
  id: string
  label: string
  adjustments: Adjustments
}

/**
 * 一键风格 = 一组预设好的八参数值。
 * 不需要单独的引擎——应用预设就是把这组值直接赋给 params。
 */
export const PRESETS: readonly Preset[] = [
  {
    id: 'jp-clean',
    label: '日系通透',
    adjustments: { ...ZERO, exposure: 8, contrast: -6, shadows: 22, saturation: -12, temperature: -14, clarity: 8 },
  },
  {
    id: 'film',
    label: '胶片',
    adjustments: { ...ZERO, exposure: -4, contrast: -14, highlights: -18, shadows: 18, saturation: -18, temperature: 8, clarity: -10, vignette: 18 },
  },
  {
    id: 'golden',
    label: '黄昏',
    adjustments: { ...ZERO, exposure: 4, contrast: 12, highlights: -10, shadows: 10, saturation: 14, temperature: 32, clarity: 6, vignette: 12 },
  },
  {
    id: 'bright',
    label: '通透提亮',
    adjustments: { ...ZERO, exposure: 16, contrast: 8, highlights: -20, shadows: 26, saturation: 6, clarity: 14 },
  },
  {
    id: 'moody',
    label: '暗调氛围',
    adjustments: { ...ZERO, exposure: -10, contrast: 20, highlights: -24, shadows: -12, saturation: -10, temperature: -10, vignette: 30 },
  },
  {
    id: 'vivid',
    label: '鲜艳',
    adjustments: { ...ZERO, contrast: 14, saturation: 28, clarity: 16, vignette: 8 },
  },
]
