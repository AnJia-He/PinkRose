// @vitest-environment jsdom
/**
 * 「调色」面板的**行为**测试（2026-10-04，「专业面板」那一轮 Task 5：分组 + 折叠）。
 *
 * ⚠️ 为什么另开一个文件、不并进 `AdjustmentPanel.test.ts`：
 * 那一份读的是**源码**，路径用 `new URL('./AdjustmentPanel.tsx', import.meta.url)`
 * 拼 —— jsdom 环境里拼出来不是 `file://`，`readFileSync` 当场报
 * "The URL must be of scheme file"。所以那份**一个字没改**，行为另开这一个。
 *
 * 驱动方式照项目惯例（`kit/Slider.test.tsx`、`App.test.tsx`）：`createRoot` + `act`，
 * 点击用原生 `.click()` —— **没有** @testing-library，零新增依赖是规矩。
 */
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import AdjustmentPanel from './AdjustmentPanel.tsx'
import { ZERO, type Adjustments } from '../../shared/adjustments.ts'

/**
 * 面板是**受控**组件，值在壳子手里。
 *
 * ⚠️ `setFromTest` 是给测试留的**后门**：要验"套预设后新参数归零"就得先把值
 * 置出去，而"拖 Base UI 的受控滑块"在 jsdom 里不好驱动（它在真浏览器里靠
 * pointer 事件链，jsdom 里派不全）。置值走 state setter，是同一份数据流 ——
 * 预设点击那一下照样是真的走 React 的 onChange。
 */
let setFromTest: (v: Adjustments) => void = () => {}

function Harness() {
  const [v, setV] = useState<Adjustments>(ZERO)
  setFromTest = setV
  return <AdjustmentPanel value={v} onChange={setV} onReset={() => setV(ZERO)} onMatchReference={() => {}} />
}

async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  return container
}

/** 点一下 + 让 React 把状态刷完（`App.test.tsx` 里 `click` 同款）。 */
async function click(el: Element) {
  await act(async () => {
    ;(el as HTMLElement).click()
    await new Promise(r => setTimeout(r, 0))
  })
}

/** 按组标题找那一组（组数/顺序变了时，找错的组会当场红，不会静默串组）。 */
function groupOf(container: HTMLElement, title: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>('.panel-group')]
    .find(g => g.querySelector('.panel-group-title')?.textContent === title)!
}

describe('面板的分组（2026-10-04）', () => {
  it('五个组标题都在（光效/色彩/色彩平衡/分离色调/效果）', async () => {
    const container = await mount(<Harness />)
    const titles = [...container.querySelectorAll('.panel-group-title')].map(e => e.textContent)
    expect(titles).toEqual(['光效', '色彩', '色彩平衡', '分离色调', '效果'])
  })

  it('15 根滑块都在（每组里数量对）', async () => {
    const container = await mount(<Harness />)
    expect(container.querySelectorAll('.slider').length).toBe(15)
  })

  it('色彩平衡那组里有一个色轮 + 三根轴', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '色彩平衡')
    expect(group.querySelector('.color-wheel')).toBeTruthy()
    const labels = [...group.querySelectorAll('.slider-label')].map(e => e.textContent)
    expect(labels).toEqual(['青 — 红', '洋红 — 绿', '黄 — 蓝'])
  })

  it('★ 点组标题 → 收起；再点 → 展开', async () => {
    const container = await mount(<Harness />)
    const head = container.querySelector('.panel-group-head')!
    const before = container.querySelectorAll('.slider').length
    await click(head)
    expect(container.querySelectorAll('.slider').length).toBeLessThan(before)
    await click(head)
    expect(container.querySelectorAll('.slider').length).toBe(before)
  })

  it('分离色调的三根用各自的范围（色相到 360，强度到 100）', async () => {
    const container = await mount(<Harness />)
    const group = groupOf(container, '分离色调')
    const ranges = [...group.querySelectorAll('input[type=range]')]
      .map(i => (i as HTMLInputElement).getAttribute('max'))
    expect(ranges.filter(m => m === '360')).toHaveLength(2)   // 两条色相带
    expect(ranges).toContain('100')                           // 强度
  })

  it('★ 套一个预设 → 新参数一并归零（不许"套了预设色轮还留着"）', async () => {
    const container = await mount(<Harness />)
    await act(async () => { setFromTest({ ...ZERO, cbCyanRed: 60 }) })
    expect(container.querySelector('.color-wheel')!.getAttribute('data-x')).not.toBe('0')
    await click([...container.querySelectorAll('.presets button')][0]!)   // 点第一个预设
    expect(container.querySelector('.color-wheel')!.getAttribute('data-x')).toBe('0')   // 色轮回中心 = 三轴归零
  })
})
