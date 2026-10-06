// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import StepStrip, { type StripStep } from './StepStrip.tsx'

// ⚠️ 挂载方式照 `PresetRail.test.tsx`（act 从 'react' 进，不引 @testing-library —— 零新增依赖）
async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  await act(async () => {})
  return container
}

const THREE: StripStep[] = [
  { id: 1, thumb: 'thumb:原图', isOriginal: true },
  { id: 3, thumb: 'thumb:第一版', isOriginal: false },
  { id: 5, thumb: 'thumb:第二版', isOriginal: false },
]
const noop = () => {}
const base = { steps: THREE, currentId: 5, generating: false, onJump: noop }

/** 每一格/每一颗占位块是什么（按 DOM 顺序）—— 结构断言全用它。 */
function kinds(c: HTMLElement): string[] {
  return [...c.querySelector('.strip')!.children].map(el => el.className.split(' ')[0]!)
}

describe('历史时间轴（照片上方那一条）', () => {
  it('一步一格 + 格子之间的连线；原图在最前', async () => {
    const c = await mount(<StepStrip {...base} />)
    expect(kinds(c)).toEqual(['strip-node', 'strip-link', 'strip-node', 'strip-link', 'strip-node'])
    expect([...c.querySelectorAll('.strip-thumb')].map(i => i.getAttribute('src')))
      .toEqual(['thumb:原图', 'thumb:第一版', 'thumb:第二版'])
  })

  it('点某一格 = 回到那一步（onJump 收到那一格的 id）', async () => {
    const jumps: number[] = []
    const c = await mount(<StepStrip {...base} onJump={id => jumps.push(id)} />)
    await act(async () => { (c.querySelectorAll('.strip-node')[0] as HTMLButtonElement).click() })
    expect(jumps).toEqual([1])
  })

  it('★ 站的那一格是位置标记、不是按钮（和对话里「你在这里」同一条规矩）', async () => {
    const jumps: number[] = []
    const c = await mount(<StepStrip {...base} currentId={3} onJump={id => jumps.push(id)} />)
    const nodes = [...c.querySelectorAll<HTMLElement>('.strip-node')]
    expect(nodes[1]!.tagName).toBe('SPAN')
    expect(nodes[1]!.getAttribute('aria-current')).toBe('step')
    expect(nodes[1]!.className).toContain('current')
    expect(nodes[0]!.tagName).toBe('BUTTON')
    expect(nodes[2]!.tagName).toBe('BUTTON')
    // 点它什么都不会发生 —— 它不是一个能按的东西
    await act(async () => { nodes[1]!.click() })
    expect(jumps).toEqual([])
  })

  it('按钮的名字分得开（原图 / 第 N 步）—— 读屏念得出点的是哪一步', async () => {
    const c = await mount(<StepStrip {...base} />)
    expect([...c.querySelectorAll('.strip-node')].map(n => n.getAttribute('aria-label')))
      .toEqual(['回到这一步：原图', '回到这一步：第 1 步', null])   // 站着那格不是按钮，没有名字
  })

  it('★ 生成中：站的那格后面挂一颗"正在画"的占位块，宽度按照片比例', async () => {
    const c = await mount(<StepStrip {...base} generating aspectRatio={1.5} />)
    expect(kinds(c)).toEqual([
      'strip-node', 'strip-link', 'strip-node', 'strip-link', 'strip-node', 'strip-pending',
    ])
    const pending = c.querySelector<HTMLElement>('.strip-pending')!
    expect(pending.getAttribute('aria-hidden')).toBe('true')
    expect(pending.style.aspectRatio).toBe('1.5')
    // 没传比例就别写内联样式（退回 CSS 那条兜底）
    const bare = await mount(<StepStrip {...base} generating />)
    expect(bare.querySelector<HTMLElement>('.strip-pending')!.style.aspectRatio).toBe('')
  })

  it('★ 从旧步骤再生成：占位块落在**站的那一格**后面，不是整条尾巴', async () => {
    // 人站在第 1 步上重掷时，新的一版落地会顶掉后面那两步 ——
    // 占位块挂到尾巴上的话，它指的位置和东西真正出现的地方是两回事。
    const c = await mount(<StepStrip {...base} currentId={3} generating />)
    expect(kinds(c)).toEqual([
      'strip-node', 'strip-link', 'strip-node', 'strip-pending', 'strip-link', 'strip-node',
    ])
  })

  it('没在生成就不摆占位块（「正在思考」那 1.5 秒也不算）', async () => {
    const c = await mount(<StepStrip {...base} generating={false} />)
    expect(c.querySelector('.strip-pending')).toBeNull()
  })

  it('小图还没画出来时（空串）不画空 img —— 那会是一个破图图标', async () => {
    const c = await mount(<StepStrip {...base} steps={[
      { id: 1, thumb: '', isOriginal: true },
      { id: 3, thumb: 'thumb:x', isOriginal: false },
    ]} />)
    expect(c.querySelectorAll('.strip-node')).toHaveLength(2)   // 格子本身照旧在
    expect(c.querySelectorAll('.strip-thumb')).toHaveLength(1)
  })

  /**
   * ★ 站的那一格要滑进**视野的中间**（用户点名要的"可左右滚动"—— 步数多起来
   * 这条轴自己滚，但不该让用户自己把它滚回来）。
   * ⚠️ jsdom 没有排版（`offsetLeft` / `clientWidth` 全是 0），所以这里自己摆
   * 一套几何、再给 `scrollLeft` 接一根线 —— 断言的是"往右滚了多少"这个数。
   * 走的是**小图挂上来那一刻**（`<img>` 的 `onLoad`）：data URL 解码完宽度才
   * 长出来，早于这一步算出来的位置是错的。
   */
  it('★ 小图长出来时把"站的那一格"滑到视野中间', async () => {
    const c = await mount(<StepStrip {...base} currentId={5} />)
    const strip = c.querySelector('.strip') as HTMLElement
    const current = c.querySelectorAll<HTMLElement>('.strip-node')[2]!
    // 摆几何：这一格在 1000px 处、宽 60，容器可视宽 600
    Object.defineProperty(current, 'offsetLeft', { value: 1000 })
    Object.defineProperty(current, 'offsetWidth', { value: 60 })
    Object.defineProperty(strip, 'clientWidth', { value: 600 })
    let written = -1
    Object.defineProperty(strip, 'scrollLeft', {
      configurable: true, get: () => written, set: (v: number) => { written = v },
    })

    const img = current.querySelector('img') as HTMLImageElement
    await act(async () => { img.dispatchEvent(new Event('load')) })
    // 1000 - (600 - 60) / 2 = 730
    expect(written).toBe(730)
  })
})
