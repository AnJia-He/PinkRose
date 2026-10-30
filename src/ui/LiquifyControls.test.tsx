// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LiquifyControls from './LiquifyControls'

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

const base = {
  image: { width: 1000, height: 800 },
  mode: 'push' as const,
  radius: 80,
  strength: 60,
  dirty: true,
  applying: false,
  onMode: () => {},
  onRadius: () => {},
  onStrength: () => {},
  onReset: () => {},
  onTone: () => {},
  onCancel: () => {},
  onDone: () => {},
}

const btn = (label: string) => [...container.querySelectorAll('button')]
  .find(b => (b.textContent ?? '').trim() === label) as HTMLButtonElement

describe('液化控件', () => {
  it('推移 / 收拢 / 调色 / 重来 / 应用液化都接上', async () => {
    const onMode = vi.fn()
    const onTone = vi.fn()
    const onReset = vi.fn()
    const onDone = vi.fn()
    await act(async () => {
      root.render(
        <LiquifyControls {...base} onMode={onMode} onTone={onTone} onReset={onReset} onDone={onDone} />,
      )
    })
    await act(async () => { btn('收拢').click() })
    await act(async () => { btn('调色').click() })
    await act(async () => { btn('重来').click() })
    await act(async () => { btn('应用液化').click() })
    expect(onMode).toHaveBeenCalledWith('pinch')
    expect(onTone).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('没动过 / 正在应用时主按钮禁用', async () => {
    await act(async () => {
      root.render(<LiquifyControls {...base} dirty={false} />)
    })
    expect(btn('应用液化').disabled).toBe(true)
    await act(async () => {
      root.render(<LiquifyControls {...base} applying />)
    })
    expect(btn('应用液化').disabled).toBe(true)
  })
})
