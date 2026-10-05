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
import type { LutMeta, LutRef } from '../../shared/lut.ts'
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
 * 面板是**受控**组件，值在壳子手里（改动一律走 React 的 onChange）。
 *
 * ★ 2026-10-05：这里原来还有一个 `setFromTest` 后门（"先把值置出去，再验套预设
 * 之后归零"）。预设药丸搬去 `PresetRail` 之后这一层不再需要它 —— 那件事的两半
 * 现在住在 `core/presets.test.ts`（字段完整性）和 `App.test.tsx`（整组赋值）。
 */
/** 两条参考图来源交出去的东西 —— 面板只"交货"：本地文件 / 选中那张的元数据。 */
let matchedRef: File | null = null
let matchedWork: WorkMeta | null = null
/** ★ 2026-10-05（滤镜）：那一栏要的四样。面板只管摆 —— 挑哪张 / 强度多少 是 App 的事，
 *  所以这里记的是"面板有没有按下去"。 */
let lutsFromTest: LutMeta[] = []
/** ★ 2026-10-05 终审修复：清单到手没有（默认到手 —— 这一层的用例大多在演"拉到了"）。 */
let lutsKnownFromTest = true
let lutFromTest: LutRef | null = null
let lutThumbsFromTest: { none: string | null; byId: Record<number, string> } = { none: null, byId: {} }
let needThumbsCalls = 0
let pickedLut: number | null | 'x' = 'x'
let wentImport = false
let retriedLuts = 0

function Harness() {
  const [v, setV] = useState<Adjustments>(ZERO)
  return (
    <AdjustmentPanel
      value={v} onChange={setV} onReset={() => setV(ZERO)}
      onMatchReference={f => { matchedRef = f }}
      onMatchWork={w => { matchedWork = w }}
      luts={lutsFromTest}
      lutsKnown={lutsKnownFromTest}
      lut={lutFromTest}
      lutThumbs={lutThumbsFromTest}
      onPickLut={id => { pickedLut = id }}
      onLutAmount={() => {}}
      onNeedLutThumbs={() => { needThumbsCalls++ }}
      onGoImport={() => { wentImport = true }}
      onRetryLuts={() => { retriedLuts++ }}
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
    // ⚠️ 数的是 **`.panel-groups` 里面**那几组（★ 2026-10-05）：从滤镜那一栏进来
    //    之后，「滤镜」也是一个 `.panel-group`（同样的折叠长相），但它是**参数组
    //    之外的**一段（设计 §5.2 有意沿用同一个语言）。不圈定范围的话，这条会
    //    把"滤镜"也算进"五组参数"里 —— 那两件事就混了。
    const titles = [...container.querySelectorAll('.panel-groups .panel-group-title')]
      .map(e => e.textContent)
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
    // ⚠️ **第一颗** `.panel-group-head` 现在可能是「滤镜」那一栏（★ 2026-10-05：
    //    它排在参数组前面）—— 圈定在 `.panel-groups` 里，这条才对得上"点参数组标题"。
    const head = container.querySelector('.panel-groups .panel-group-head')!
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

  /**
   * ★ 2026-10-05：原来这里有一条「套一个预设 → 新参数一并归零」（点面板上那排
   * 药丸，看色轮回中心）。**那排药丸搬去照片左边的预设栏了**（`PresetRail`），
   * 面板里不再有预设入口，所以这条测试跟着搬走 —— 它的两半现在住在这儿：
   *   · "每个预设都是 `{...ZERO, …}` 的长拷贝、十五个键一个不缺"
   *     → `core/presets.test.ts`（字段完整性那条）；
   *   · "点一下 = **整组赋值**，不是往当前参数上叠"
   *     → `App.test.tsx`「只动参数（不推快照、不说话）也要落盘」那条
   *       （它现在断言 `after.params` 与预设**全等**）。
   */
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

/**
 * ★ 2026-10-05（滤镜，设计 §5.2）：微调区那一栏。
 *
 * 这一层只测**面板自己管得着的那几件事**：默认收着、**点开才去要缩略图**
 * （每个滤镜都要拿当前照片重画一张，很贵）、以及"点下去交出去的是什么"。
 * 清单怎么来、cube 怎么解析、选完怎么落盘，全在 App 那一层
 * （`App.test.tsx` 的「滤镜」那一组）。
 */
describe('滤镜那一栏（2026-10-05）', () => {
  const LUT: LutMeta = { id: 1, name: '黄昏', size: 2, bytes: 100, createdAt: 0 }
  /** 「滤镜」那个组头（按文字找 —— 位置是排版的事）。 */
  const headOf = (c: HTMLElement) =>
    [...c.querySelectorAll<HTMLElement>('.panel-group-head')]
      .find(b => (b.textContent ?? '').includes('滤镜'))!

  beforeEach(() => {
    lutsFromTest = []
    lutsKnownFromTest = true
    lutFromTest = null
    lutThumbsFromTest = { none: null, byId: {} }
    needThumbsCalls = 0
    pickedLut = 'x'
    wentImport = false
    retriedLuts = 0
  })

  it('★ 默认收着 —— 而且**收着的时候一次缩略图都不去要**', async () => {
    lutsFromTest = [LUT]
    const c = await mount(<Harness />)
    // 默认收着（spec §8.3：用户原话「不要写个名字显示出来占空间」）
    expect(c.querySelector('.lut-tile')).toBeNull()
    // 没用滤镜 → 标题不点亮（点亮那个类名是"正在用"的信号）
    expect(headOf(c).className).not.toContain('on')
    // ⚠️ 这一句才是这条用例的重点：每张缩略图 = 用当前照片 + 当前参数重画一遍。
    //    收着的时候白画一遍，用户看不见、也没人会报错。
    expect(needThumbsCalls).toBe(0)

    await click(headOf(c))
    expect(c.querySelectorAll('.lut-tile')).toHaveLength(2)   // 「不用」+ 黄昏
    expect(needThumbsCalls).toBe(1)
  })

  it('在用滤镜 → 标题点亮（`.on`）', async () => {
    lutsFromTest = [LUT]
    lutFromTest = { lutId: 1, amount: 80 }
    const c = await mount(<Harness />)
    expect(headOf(c).className).toContain('on')
  })

  it('点格子 → 交出去的是那个 id；点「不用」→ null', async () => {
    lutsFromTest = [LUT]
    const c = await mount(<Harness />)
    await click(headOf(c))
    const tiles = [...c.querySelectorAll<HTMLButtonElement>('.lut-tile')]
    await click(tiles[1]!)                    // 黄昏
    expect(pickedLut).toBe(1)
    await click(tiles[0]!)                    // 不用
    expect(pickedLut).toBeNull()
  })

  it('一个滤镜都没有 → 「去导入」把这件事交出去（去设置里那一页）', async () => {
    const c = await mount(<Harness />)
    await click(headOf(c))
    expect(c.textContent).toContain('还没有导入过滤镜')
    await click(c.querySelector('.lut-import-go')!)
    expect(wentImport).toBe(true)
  })

  it('★ 清单还没到手 → 不摆「还没有导入过滤镜」，摆的是「再试一次」（那块口子接得上）', async () => {
    // 终审修复：这句**关于用户资产**的话只许在"服务端真的回了空清单"时说 ——
    // 这一层钉的是"面板把 `lutsKnown` 一路传到了格子上"（App 那一侧在
    // `App.test.tsx` 的「清单取不到」那条里演）。
    lutsKnownFromTest = false
    const c = await mount(<Harness />)
    await click(headOf(c))
    expect(c.textContent).not.toContain('还没有导入过滤镜')
    expect(c.textContent).toContain('还没到手')
    await click(c.querySelector('.lut-import-go')!)
    expect(retriedLuts).toBe(1)
    expect(wentImport).toBe(false)        // 这一颗不是「去导入」—— 用户该做的不是再导一个
  })
})
