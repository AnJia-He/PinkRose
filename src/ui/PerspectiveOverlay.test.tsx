// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import PerspectiveOverlay from './PerspectiveOverlay'
import { defaultPerspectiveQuad, type PerspectiveQuad } from '../core/perspective'

const BOX = { left: 10, top: 20, width: 800, height: 600 }
const roots: { root: Root; container: HTMLElement }[] = []

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
})

function Harness({ seen }: { seen: PerspectiveQuad[] }) {
  const [quad, setQuad] = useState(defaultPerspectiveQuad())
  return (
    <PerspectiveOverlay
      box={BOX}
      quad={quad}
      onChange={(next) => {
        seen.push(next)
        setQuad(next)
      }}
    />
  )
}

async function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const seen: PerspectiveQuad[] = []
  await act(async () => root.render(<Harness seen={seen} />))
  roots.push({ root, container })
  return {
    seen,
    handles: () => [...container.querySelectorAll('.perspective-handle')] as HTMLElement[],
  }
}

const press = (el: Element, key: string, shiftKey = false) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key, shiftKey, bubbles: true, cancelable: true,
    }))
  })

describe('透视四角的键盘精确调整', () => {
  it('四个角都在键盘顺序里，有明确角色和名称', async () => {
    const view = await mount()
    const handles = view.handles()
    expect(handles).toHaveLength(4)
    expect(handles.every(el => el.tabIndex === 0)).toBe(true)
    expect(handles.every(el => el.getAttribute('role') === 'button')).toBe(true)
    expect(handles.map(el => el.getAttribute('aria-label'))).toEqual([
      '透视左上角；方向键调整',
      '透视右上角；方向键调整',
      '透视右下角；方向键调整',
      '透视左下角；方向键调整',
    ])
  })

  it('方向键移动 1px，Shift 加速到 10px，并且只动当前这个角', async () => {
    const view = await mount()
    const handle = view.handles()[0]!
    await press(handle, 'ArrowRight')
    expect(view.seen.at(-1)![0].x).toBeCloseTo(1 / 800, 7)
    expect(view.seen.at(-1)![0].y).toBe(0)
    expect(view.seen.at(-1)![1]).toEqual({ x: 1, y: 0 })
    await press(handle, 'ArrowDown', true)
    expect(view.seen.at(-1)![0].y).toBeCloseTo(10 / 600, 7)
  })

  it('键盘移动仍受角点顺序约束，不会让四角交叉', async () => {
    const view = await mount()
    const handle = view.handles()[0]!
    for (let i = 0; i < 100; i++) await press(handle, 'ArrowRight', true)
    expect(view.seen.at(-1)![0].x).toBeLessThan(1)
    expect(view.seen.at(-1)![0].x).toBeLessThanOrEqual(1 - 0.02)
  })
})
