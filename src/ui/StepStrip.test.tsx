// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
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

const ringOf = (c: HTMLElement) => c.querySelector('.strip-ring') as HTMLElement

/**
 * 带状态的父级 —— **拖动那几条必须用它**：真 App 里 `onJump` 会回头把
 * `currentId` 改掉（转盘的角度只是它的画法）。只传死 prop 的话，组件会
 * 发现"圈转过去了、可爹说还站在老地方"，又把自己拉回来 —— 那是真实
 * 语义，不是 bug（测试假环境才不该那么演）。
 */
function Harness({ initial, onJump }: { initial: number; onJump: (id: number) => void }) {
  const [cur, setCur] = useState(initial)
  return <StepStrip steps={THREE} currentId={cur} generating={false}
    onJump={id => { onJump(id); setCur(id) }} />
}

describe('历史转盘（照片上方那圈）', () => {
  it('一步一格；站的那一格被转到正面（整圈转 -120°）', async () => {
    const c = await mount(<StepStrip {...base} />)
    expect(c.querySelectorAll('.strip-node')).toHaveLength(3)
    expect([...c.querySelectorAll('.strip-thumb')].map(i => i.getAttribute('src')))
      .toEqual(['thumb:原图', 'thumb:第一版', 'thumb:第二版'])
    // currentId=5 是第 3 格（index 2）→ 转盘转 -2×60 = -120°，把它转到正面
    expect(ringOf(c).style.transform).toContain('rotateY(-120deg)')
    // 每一格自己还摆在自己的角位上（0°/60°/120°）
    const nodes = [...c.querySelectorAll<HTMLElement>('.strip-node')]
    expect(nodes[0]!.style.transform).toContain('rotateY(0deg)')
    expect(nodes[2]!.style.transform).toContain('rotateY(120deg)')
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
    await act(async () => { nodes[1]!.click() })
    expect(jumps).toEqual([])
  })

  it('按钮的名字分得开（原图 / 第 N 步）—— 读屏念得出点的是哪一步', async () => {
    const c = await mount(<StepStrip {...base} />)
    expect([...c.querySelectorAll('.strip-node')].map(n => n.getAttribute('aria-label')))
      .toEqual(['回到这一步：原图', '回到这一步：第 1 步', null])   // 站着那格不是按钮
  })

  it('★ currentId 从外面变了（对话里点了「回到这一步」）→ 转盘自己转过去', async () => {
    // "转盘的角度"和"站在哪一步"必须只有一个真相：从外面跳步时，转盘不能
    // 自己停在原处（那样正面那格和大图指的不是同一版）。
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => { root.render(<StepStrip {...base} currentId={1} />) })
    expect(ringOf(container).style.transform).toContain('rotateY(0deg)')

    await act(async () => { root.render(<StepStrip {...base} currentId={5} />) })
    expect(ringOf(container).style.transform).toContain('rotateY(-120deg)')

    await act(async () => { root.render(<StepStrip {...base} currentId={3} />) })
    expect(ringOf(container).style.transform).toContain('rotateY(-60deg)')
  })

  it('★ 按住往左拖 = 往前转：拖过一格松手，落到那一格（onJump 收到它）', async () => {
    const jumps: number[] = []
    const c = await mount(<Harness initial={1} onJump={id => jumps.push(id)} />)
    const strip = c.querySelector('.strip') as HTMLElement

    await act(async () => {
      strip.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 300 }))
    })
    await act(async () => {
      // 往左拖 160px ≈ 67°（系数 0.42）→ 转过一格还多
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 140 }))
      window.dispatchEvent(new MouseEvent('pointerup'))
    })

    expect(jumps.at(-1)).toBe(3)                                  // 落到第 2 格（id 3）
    expect(ringOf(c).style.transform).toContain('rotateY(-60deg)') // 吸附到整格
  })

  it('拖完手一松落在原来的格子上时，不重复喊 onJump', async () => {
    const jumps: number[] = []
    const c = await mount(<Harness initial={1} onJump={id => jumps.push(id)} />)
    const strip = c.querySelector('.strip') as HTMLElement
    await act(async () => {
      strip.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 300 }))
    })
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 285 }))   // 只挪 15px ≈ 6°
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(jumps).toEqual([])                                     // 还在第 1 格
    expect(ringOf(c).style.transform).toContain('rotateY(0deg)')
  })

  it('★ 生成中：一颗会扫光的空格子摆在"轮到它的位置"（队尾的后一格）；六格满了不摆', async () => {
    const c = await mount(<StepStrip {...base} generating />)
    const pending = c.querySelector('.strip-pending') as HTMLElement
    expect(pending, '生成中该有一颗占位格子').toBeTruthy()
    expect(pending.getAttribute('aria-hidden')).toBe('true')
    // 三格占了 0/1/2 号位 → 它落在 3 号位（180°）
    expect(pending.style.transform).toContain('rotateY(180deg)')

    // 六格满了（MAX_SNAPSHOTS = 6）—— 没有空位，不摆（画布暗罩和对话里那三颗点还在说"在忙"）
    const SIX: StripStep[] = Array.from({ length: 6 }, (_, i) =>
      ({ id: i * 2 + 1, thumb: 'thumb:' + i, isOriginal: i === 0 }))
    const full = await mount(<StepStrip steps={SIX} currentId={11} generating onJump={noop} />)
    expect(full.querySelector('.strip-pending')).toBeNull()
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

  it('★ 超过六步时按步数均分，谁也不叠在谁身上（恢复出来的会话可能有 7 步）', async () => {
    // 写死 60° 的话第 7 格正好转回 0°，和第一格重合 —— 两格叠在一起，点不准。
    const SEVEN: StripStep[] = Array.from({ length: 7 }, (_, i) =>
      ({ id: i * 2 + 1, thumb: 'thumb:' + i, isOriginal: i === 0 }))
    const c = await mount(<StepStrip steps={SEVEN} currentId={13} generating={false} onJump={noop} />)
    const angles = [...c.querySelectorAll<HTMLElement>('.strip-node')]
      .map(el => /rotateY\(([-\d.]+)deg\)/.exec(el.style.transform)?.[1])
    expect(angles).toHaveLength(7)
    expect(new Set(angles).size).toBe(7)     // 七个角位互不相同
  })
})
