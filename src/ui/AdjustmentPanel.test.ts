import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PARAM_LABELS } from '../../shared/adjustments.ts'

/**
 * ⚠️ 这一条读的是**源码**，不是渲染结果 —— 它守的东西只有源码看得见。
 *
 * 守的是「名字表只有一份」：微调面板必须从 `shared/adjustments.ts` 取名字，
 * **不许自己再写死一份**。两处各有一份的话，改了一处另一处不会跟着变，
 * 而两边各自都"看起来对"，漂了也没人发现（§3.5.2 点名的就是这件事）。
 *
 * 「页面上不出现裸字段名」那一半，由作品详情页的渲染测试守（Task 12）——
 * 那时候两个界面都在了，才对照得起来。
 */
describe('AdjustmentPanel 的源码', () => {
  const src = readFileSync(fileURLToPath(new URL('./AdjustmentPanel.tsx', import.meta.url)), 'utf8')

  it('从共用那一份取名字', () => {
    expect(src).toContain('PARAM_LABELS')
  })

  it('★ 没有自己写死任何一条标签', () => {
    // 变异：把 `亮度` 抄一行进组件 → 必须红
    for (const label of Object.values(PARAM_LABELS)) {
      expect(src).not.toContain(`'${label}'`)
    }
  })
})
