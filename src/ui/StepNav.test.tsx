// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StepNav from './StepNav'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('账本历史', () => {
  it('点计数展开每一笔；点某一笔跳到那一笔', async () => {
    const onJump = vi.fn()
    await act(async () => {
      root.render(
        <StepNav
          index={2} total={3}
          items={['原图', '调色', '裁剪']}
          onJump={onJump}
          onPrev={() => {}}
          onNext={() => {}}
        />,
      )
    })
    const count = container.querySelector('.step-nav-count') as HTMLButtonElement
    expect(count.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { count.click() })
    expect(count.getAttribute('aria-expanded')).toBe('true')
    const items = container.querySelectorAll('.step-history-item')
    expect([...items].map(x => x.textContent)).toEqual(['1原图', '2调色', '3裁剪'])
    expect(items[1]!.getAttribute('aria-current')).toBe('step')

    await act(async () => { (items[0] as HTMLButtonElement).click() })
    expect(onJump).toHaveBeenCalledWith(1)
    expect(container.querySelector('.step-history')).toBeNull()
  })

  it('Escape / 点外面都收起；没有 items 时计数仍是普通文本', async () => {
    await act(async () => {
      root.render(<StepNav index={1} total={2} onPrev={() => {}} onNext={() => {}} />)
    })
    expect(container.querySelector('button.step-nav-count')).toBeNull()
    expect(container.querySelector('.step-nav-count')?.textContent).toBe('1 / 2')

    await act(async () => {
      root.render(
        <StepNav
          index={1} total={2}
          items={['原图', '调色']}
          onJump={() => {}}
          onPrev={() => {}}
          onNext={() => {}}
        />,
      )
    })
    const count = container.querySelector('button.step-nav-count') as HTMLButtonElement
    await act(async () => { count.click() })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(container.querySelector('.step-history')).toBeNull()

    await act(async () => { count.click() })
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('.step-history')).toBeNull()
  })
})
