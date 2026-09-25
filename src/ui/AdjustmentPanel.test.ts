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
 * 三种写法都要挡：单引号、双引号、JSX 裸文本。这不是保守 ——
 * 双引号（`ChatPanel.tsx` 的 `alt="……"`）和模板字面量在 `src/` 里到处都有，
 * 而**裸文本正是这个文件自己的风格**（`<span>微调</span>`、`<button>重置</button>`）：
 * `<span className="slider-label">亮度</span>` 长得就像这文件里"本来就该有"的一行。
 * 只按单引号挡，恰恰漏掉最可能发生的那一种。
 *
 * 作品详情页那边的渲染测试（Task 12）**不守这一半**：它的断言作用在详情页的
 * `.recipe-box` 上，证明的是"详情页显示了「亮度」"—— 既不看面板的名字是从哪来的，
 * 也抓不到面板里多出来的裸文本拷贝。面板这一侧的三种形状，只有这里挡得住。
 */
describe('AdjustmentPanel 的源码', () => {
  const src = readFileSync(fileURLToPath(new URL('./AdjustmentPanel.tsx', import.meta.url)), 'utf8')

  // 这条**不是闸**，只是记一笔"它确实从共用那份取"：一句提到 PARAM_LABELS 的
  // 注释就能让它绿。真正承重的是下面那条 ★ —— 名字写准，免得看着像一道闸。
  it('确实 import 了 PARAM_LABELS（光凭这条证明不了"只有一份"）', () => {
    expect(src).toContain('PARAM_LABELS')
  })

  it('★ 没有自己写死任何一条标签（单引号 / 双引号 / JSX 裸文本都挡）', () => {
    // 变异：把某一条标签抄进组件（三种写法任一种）→ 必须红
    for (const label of Object.values(PARAM_LABELS)) {
      expect(src).not.toContain(`'${label}'`)
      expect(src).not.toContain(`"${label}"`)
      expect(src).not.toContain(`>${label}<`)
    }
  })
})
