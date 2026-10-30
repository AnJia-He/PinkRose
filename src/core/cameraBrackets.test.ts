import { describe, expect, it } from 'vitest'
import {
  bracketExposureValues, bracketFocusValues, findFocusBracketField,
} from './cameraBrackets'

describe('bracketExposureValues', () => {
  it('数值范围按 3 / 5 张和步长生成居中曝光序列', () => {
    const field = { type: 'number' as const, min: -5, max: 5, step: 0.1 }
    expect(bracketExposureValues(0, 3, 1, field)).toEqual([-1, 0, 1])
    expect(bracketExposureValues(0.5, 5, 0.7, field)).toEqual([-0.9, -0.2, 0.5, 1.2, 1.9])
  })

  it('靠近范围边缘时钳到相机允许值，但不允许重复曝光', () => {
    const field = { type: 'number' as const, min: -1, max: 1, step: 0.3 }
    expect(bracketExposureValues(1, 3, 1, field)).toBeNull()
    expect(bracketExposureValues(0, 3, 0.3, field)).toEqual([-0.3, 0, 0.3])
  })

  it('下拉型曝光补偿按最接近的相机选项选择，选项不足则不可用', () => {
    const field = {
      type: 'select' as const,
      options: ['-2', '-1', '0', '1', '2'].map(value => ({ value })),
    }
    expect(bracketExposureValues(0, 3, 1, field)).toEqual([-1, 0, 1])
    expect(bracketExposureValues(0, 5, 1, {
      type: 'select',
      options: [{ value: '0' }, { value: '1' }],
    })).toBeNull()
  })
})

describe('焦点包围', () => {
  it('只认可写的焦点位置，不把 focusMode 当成位置', () => {
    const fields = [
      {
        key: 'focusMode', label: '对焦模式', type: 'select' as const,
        options: [{ value: 'MF' }, { value: 'AF' }],
      },
      {
        key: 'manualfocusdrive', label: '手动对焦位置',
        type: 'number' as const, min: 0, max: 100, step: 1,
      },
    ]
    expect(findFocusBracketField(fields)?.key).toBe('manualfocusdrive')
    expect(findFocusBracketField([
      { ...fields[1]!, readOnly: true },
    ])).toBeNull()
  })

  it('按焦点范围和跨度生成居中的 3 / 5 张不重复位置', () => {
    const field = {
      key: 'focusposition', label: '焦点位置',
      type: 'number' as const, min: 0, max: 100, step: 1,
    }
    expect(bracketFocusValues(50, 3, 10, field)).toEqual([45, 50, 55])
    expect(bracketFocusValues(50, 5, 10, field)).toEqual([45, 48, 50, 53, 55])
    expect(bracketFocusValues(100, 3, 10, field)).toBeNull()
  })
})
