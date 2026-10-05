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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkMeta } from '../../shared/works.ts'
import AdjustmentPanel from './AdjustmentPanel.tsx'
import { ZERO, type Adjustments } from '../../shared/adjustments.ts'

/** 「从我的作品里选」拉的清单 —— 假掉它（真的会走网络）。
 *  `fileUrl` 等其余导出**保留真的**：纯字符串拼接，真跑一遍正好把
 *  "缩略图网址带着版本号（?v=）"这件事一起钉住。 */
const listWorksMock = vi.hoisted(() => vi.fn())
vi.mock('../api/works.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/works.ts')>()
  return { ...actual, listWorks: listWorksMock }
})

/**
 * 面板是**受控**组件，值在壳子手里。
 *
 * ⚠️ `setFromTest` 是给测试留的**后门**：要验"套预设后新参数归零"就得先把值
 * 置出去，而"拖 Base UI 的受控滑块"在 jsdom 里不好驱动（它在真浏览器里靠
 * pointer 事件链，jsdom 里派不全）。置值走 state setter，是同一份数据流 ——
 * 预设点击那一下照样是真的走 React 的 onChange。
 */
let setFromTest: (v: Adjustments) => void = () => {}
/** 两条参考图来源交出去的东西 —— 面板只"交货"：本地文件 / 选中那张的元数据。 */
let matchedRef: File | null = null
let matchedWork: WorkMeta | null = null

function Harness() {
  const [v, setV] = useState<Adjustments>(ZERO)
  setFromTest = setV
  return (
    <AdjustmentPanel
      value={v} onChange={setV} onReset={() => setV(ZERO)}
      onMatchReference={f => { matchedRef = f }}
      onMatchWork={w => { matchedWork = w }}
    />
  )
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

/**
 * ★ 2026-10-05（用户：「这个用户应该有两个来源，一个是以往作品效果，一个是本地照片」）：
 * 「放置预期效果照片」展开成**两个来源**。
 *
 * 这一层只测**面板交了什么货**（本地 File / 选中作品的 `WorkMeta`）—— 取图字节、
 * 解码、拟合都在 App 那边；真链路（含 fetch 取图 → 合流）在 `App.test.tsx`。
 */
describe('「照着这张调」的两个来源（2026-10-05）', () => {
  const W = (id: number, updatedAt = 1): WorkMeta =>
    ({ id, alias: null, createdAt: 1, updatedAt, bytes: 1, hasThumb: true })

  beforeEach(() => {
    listWorksMock.mockReset()
    listWorksMock.mockResolvedValue([])   // 默认拉到空清单；各用例按需覆盖
    matchedRef = null
    matchedWork = null
  })

  /** 点大按钮 = 展开（或收起）两个来源。 */
  const openSources = (container: HTMLElement) =>
    click(container.querySelector('.presets-ref')!)
  /** 第 0 行 = 「从我的作品里选」，第 1 行 = 「从电脑里选」（DOM 顺序即界面顺序）。 */
  const sourceAt = (container: HTMLElement, i: number) =>
    [...container.querySelectorAll('.presets-source')][i]!

  it('点大按钮 → 展开「从我的作品里选 / 从电脑里选」；再点 → 收起', async () => {
    const container = await mount(<Harness />)
    expect(container.querySelector('.presets-sources')).toBeNull()
    await openSources(container)
    expect([...container.querySelectorAll('.presets-source')].map(e => e.textContent))
      .toEqual(['从我的作品里选', '从电脑里选'])
    await openSources(container)
    expect(container.querySelector('.presets-sources')).toBeNull()
  })

  it('★ 点「从电脑里选」→ 触发了那个隐藏的 file input（老路一寸没动）', async () => {
    const container = await mount(<Harness />)
    await openSources(container)
    const input = container.querySelector('input.presets-ref-file')!
    let clicks = 0
    input.addEventListener('click', () => { clicks++ })
    await click(sourceAt(container, 1))
    expect(clicks).toBe(1)
  })

  it('点「从我的作品里选」→ 拉清单 → 网格按清单顺序摆缩略图（网址带版本号）', async () => {
    listWorksMock.mockResolvedValueOnce([W(3), W(5, 9)])
    const container = await mount(<Harness />)
    await openSources(container)
    await click(sourceAt(container, 0))
    const srcs = [...container.querySelectorAll('.presets-work-thumb')]
      .map(i => i.getAttribute('src'))
    expect(srcs).toEqual(['/api/works/3/thumb?v=1', '/api/works/5/thumb?v=9'])
  })

  it('★ 点一张作品 → 面板把**那一张**的元数据交出去，展开区收起', async () => {
    listWorksMock.mockResolvedValueOnce([W(3), W(5)])
    const container = await mount(<Harness />)
    await openSources(container)
    await click(sourceAt(container, 0))
    await click([...container.querySelectorAll('.presets-work')][1]!)   // 第二张 = id 5
    expect(matchedWork?.id).toBe(5)
    expect(container.querySelector('.presets-sources')).toBeNull()
  })

  it('清单拉失败 → 说一句能照着做的（不静默）；再点一下**当场重拉**（不是收起）', async () => {
    listWorksMock.mockRejectedValueOnce(new Error('boom'))
    const container = await mount(<Harness />)
    await openSources(container)
    await click(sourceAt(container, 0))
    expect(container.querySelector('.presets-works-note')?.textContent).toContain('没取到作品清单')
    // 再点一次 —— 文案说的"再点一下试试"必须真的重拉（这次让它成功）
    listWorksMock.mockResolvedValueOnce([W(3)])
    await click(sourceAt(container, 0))
    expect(container.querySelectorAll('.presets-work')).toHaveLength(1)
  })

  it('真的拉到空清单 → 「还没有存过作品」并指向另一条路（不拿 0 顶"还没拉到"）', async () => {
    const container = await mount(<Harness />)
    await openSources(container)
    await click(sourceAt(container, 0))
    const note = container.querySelector('.presets-works-note')?.textContent ?? ''
    expect(note).toContain('还没有存过作品')
    expect(note).toContain('从电脑里选')
  })

  it('选完本地文件 → 文件交出去、展开区收起（挑好了 = 这个动作做完了）', async () => {
    const container = await mount(<Harness />)
    await openSources(container)
    const input = container.querySelector('input.presets-ref-file') as HTMLInputElement
    const file = new File(['x'], 'r.jpg', { type: 'image/jpeg' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(matchedRef).toBe(file)
    expect(container.querySelector('.presets-sources')).toBeNull()
  })
})
