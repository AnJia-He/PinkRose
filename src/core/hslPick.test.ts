import { describe, expect, it } from 'vitest'
import { hslBandForRgb } from './hslPick'

describe('照片取色 → HSL 色带', () => {
  it('★ 纯红 / 橙 / 绿 / 蓝 / 洋红落到对应色带', () => {
    expect(hslBandForRgb([255, 0, 0])?.id).toBe('red')
    expect(hslBandForRgb([255, 159, 26])?.id).toBe('orange')
    expect(hslBandForRgb([0, 255, 0])?.id).toBe('green')
    expect(hslBandForRgb([0, 0, 255])?.id).toBe('blue')
    expect(hslBandForRgb([255, 0, 255])?.id).toBe('magenta')
  })

  it('红色跨 0 / 1 的边界按环形距离算，不会落到最远的色带', () => {
    expect(hslBandForRgb([255, 20, 0])?.id).toBe('red')
    expect(hslBandForRgb([255, 0, 20])?.id).toBe('red')
  })

  it('太灰或太暗的颜色返回 null（没有可靠色相）', () => {
    expect(hslBandForRgb([128, 128, 128])).toBeNull()
    expect(hslBandForRgb([2, 2, 3])).toBeNull()
    expect(hslBandForRgb([250, 250, 250])).toBeNull()
  })
})
