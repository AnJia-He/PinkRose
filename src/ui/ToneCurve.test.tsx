// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import ToneCurve from './ToneCurve.tsx'

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

const button = (text: string) => [...container.querySelectorAll('button')]
  .find(node => (node.textContent ?? '').trim() === text) as HTMLButtonElement

describe('影调曲线预设', () => {
  it('选中红色通道后点「强对比」，只把该通道预设交给上层', async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(<ToneCurve value={{ ...ZERO, exposure: 17 }} onChange={onChange} />)
    })

    act(() => button('红').click())
    act(() => button('强对比').click())

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]![0]).toMatchObject({
      exposure: 17,
      curveRedBlack: 4,
      curveRedShadows: -28,
      curveRedMidtones: 0,
      curveRedHighlights: 28,
      curveRedWhite: -4,
      curveMidtones: 0,
      curveGreenMidtones: 0,
    })
  })
})
