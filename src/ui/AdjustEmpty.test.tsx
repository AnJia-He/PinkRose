// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdjustEmpty from './AdjustEmpty.tsx'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function waitFor(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    if (test()) return
  }
  throw new Error(`等不到 ${label}`)
}

describe('调色空态', () => {
  it('没有照片时，除了选照片还能从相机桥导入', async () => {
    const onPick = vi.fn()
    await act(async () => {
      root.render(<AdjustEmpty onPick={onPick} />)
    })

    expect(document.body.textContent).toContain('还没有照片。')
    expect(document.body.textContent).toContain('选一张照片')
    expect(document.body.textContent).toContain('从相机导入')

    const bridge = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('从相机导入'))!
    await act(async () => { bridge.click() })
    await waitFor(
      () => !!document.querySelector('button[aria-label="关闭相机桥"]'),
      '相机桥弹层',
    )
    expect(document.body.textContent).toContain('相机桥')

    const close = document.querySelector('button[aria-label="关闭相机桥"]') as HTMLButtonElement
    await act(async () => { close.click() })
    expect(document.body.textContent).not.toContain('相机桥')
    expect(onPick).not.toHaveBeenCalled()
  })
})
