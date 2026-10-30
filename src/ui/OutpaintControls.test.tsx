// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OutpaintControls from './OutpaintControls'

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

describe('AI 扩图控件', () => {
  it('选比例后把比例和预估尺寸交给用户，再触发生成', async () => {
    const onGenerate = vi.fn()
    await act(async () => {
      root.render(
        <OutpaintControls
          image={{ width: 1200, height: 800 }}
          busy={false}
          canGenerate
          onBack={() => {}}
          onCancel={() => {}}
          onGenerate={onGenerate}
        />,
      )
    })
    const fourFive = [...container.querySelectorAll('button')]
      .find(b => b.textContent === '4:5') as HTMLButtonElement
    await act(async () => { fourFive.click() })
    expect(container.textContent).toContain('目标 4:5')
    const generate = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.includes('生成扩图')) as HTMLButtonElement
    await act(async () => { generate.click() })
    expect(onGenerate).toHaveBeenCalledWith('4:5')
  })

  it('不在最新一版或正在生成时按不到', async () => {
    await act(async () => {
      root.render(
        <OutpaintControls
          image={{ width: 1200, height: 800 }}
          busy
          canGenerate={false}
          onBack={() => {}}
          onCancel={() => {}}
          onGenerate={() => {}}
        />,
      )
    })
    const generate = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.includes('正在扩图')) as HTMLButtonElement
    expect(generate.disabled).toBe(true)
  })
})
