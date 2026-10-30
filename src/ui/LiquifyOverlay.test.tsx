// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LiquifyOverlay from './LiquifyOverlay'

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

describe('液化画笔层', () => {
  it('★ 拖动换算成图片坐标，松手才交出一笔', async () => {
    const onStroke = vi.fn()
    await act(async () => {
      root.render(
        <StrictMode>
          <LiquifyOverlay
            box={{ left: 10, top: 20, width: 500, height: 500 }}
            imageWidth={1000}
            imageHeight={1000}
            radius={40}
            onStroke={onStroke}
          />
        </StrictMode>,
      )
    })
    const layer = container.querySelector('.liquify') as HTMLElement
    layer.getBoundingClientRect = () => ({
      left: 10, top: 20, width: 500, height: 500,
      right: 510, bottom: 520, x: 10, y: 20, toJSON: () => ({}),
    })
    await act(async () => {
      layer.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: 100, clientY: 100,
      }))
      window.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true, clientX: 150, clientY: 140,
      }))
      expect(onStroke).not.toHaveBeenCalled()
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })
    expect(onStroke).toHaveBeenCalledTimes(1)
    expect(onStroke.mock.calls[0]![0]).toEqual({
      x0: 180, y0: 160, x1: 280, y1: 240,
    })
  })
})
