// @vitest-environment jsdom
/**
 * **本地新步骤**（★ 2026-10-06）：裁剪、擦除都从这儿走。
 *
 * 这一层是**纯函数**（不挂 React），钉的是三条产品契约：
 *   ① 推了新的一步；② `prompt` 是 `undefined`（不是空串）；③ 参数原样带过去。
 */
import { describe, expect, it } from 'vitest'
import { localStep } from './useLocalStep'
import type { Snapshot } from '../core/history'
import { ZERO } from '../../shared/adjustments.ts'
import type { DecodedImage } from '../image/decode'

const img = (n: number) =>
  ({ bitmap: { close() {} } as unknown as ImageBitmap, width: n, height: n }) as DecodedImage

/**
 * 一张最小可用的快照。
 * ⚠️ 任务书里那两处 `pushSnapshot([], {…})` **用错了**：它返回的是**数组**，
 *    套进 `[…]` 之后 `prev` 成了嵌套数组，`s.id` 全是 `undefined` ——
 *    第二条用例（要切未来的那条）当场红，而它想验的其实是下面这三条契约。
 *    这里改成直白的字面量（`onPick` 建原图那一步也是这么写的）。
 */
const snap = (id: number, label: string, isOriginal: boolean): Snapshot =>
  ({ id, label, base: img(10), params: ZERO, lut: null, isOriginal, thumb: '' })

describe('本地新步骤（裁剪 / 擦除共用）', () => {
  it('★ 推一步、没有 prompt、底图换成新的、参数一个不丢', () => {
    const prev = [snap(1, '原图', true)]
    const next = localStep(prev, {
      id: 2, label: '裁剪', base: img(8),
      params: { ...ZERO, exposure: 30 }, lut: null, cursorId: 1,
    })
    expect(next).toHaveLength(2)
    expect(next[1]!.label).toBe('裁剪')
    // ⚠️ 这一句是这条用例的全部意义：空串会让「再来一版」出现在一颗按不动的按钮上
    expect(next[1]!.prompt).toBeUndefined()
    expect(next[1]!.base.width).toBe(8)          // 换的是新底图
    expect(next[1]!.params.exposure).toBe(30)    // 参数原样带过去 —— 用户调好的滑块不许丢
    expect(next[1]!.isOriginal).toBe(false)
  })

  it('★ 站在中间那一步做本地改动：后面的被切掉（和生成那条一样）', () => {
    const prev = [
      snap(1, '原图', true),
      { ...snap(3, '生成式编辑', false), prompt: 'p' },
    ]
    const next = localStep(prev, { id: 5, label: '裁剪', base: img(8), params: ZERO, lut: null, cursorId: 1 })
    expect(next.map(s => s.id)).toEqual([1, 5])
  })
})
