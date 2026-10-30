// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GradientOverlay from './GradientOverlay'
import { DEFAULT_LINEAR_GRADIENT } from '../core/gradientMask'

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

describe('渐变蒙版层', () => {
  it('★ 拖动换算成归一化起终点，松手才交出一份完整渐变', async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(
        <StrictMode>
          <GradientOverlay
            box={{ left: 10, top: 20, width: 500, height: 500 }}
            spec={DEFAULT_LINEAR_GRADIENT}
            onChange={onChange}
          />
        </StrictMode>,
      )
    })
    const layer = container.querySelector('.gradient-mask') as HTMLElement
    layer.getBoundingClientRect = () => ({
      left: 10, top: 20, width: 500, height: 500,
      right: 510, bottom: 520, x: 10, y: 20, toJSON: () => ({}),
    })
    await act(async () => {
      layer.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: 110, clientY: 120,
      }))
      window.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true, clientX: 310, clientY: 420,
      }))
      expect(onChange).not.toHaveBeenCalled()
      window.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true, clientX: 310, clientY: 420,
      }))
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    const sent = onChange.mock.calls[0]![0]
    expect(sent.kind).toBe('linear')
    expect(sent.start.x).toBeCloseTo(0.2, 5)
    expect(sent.start.y).toBeCloseTo(0.2, 5)
    expect(sent.end.x).toBeCloseTo(0.6, 5)
    expect(sent.end.y).toBeCloseTo(0.8, 5)
  })

  it('取消不提交；原地一下也不算拖出渐变', async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(
        <GradientOverlay
          box={{ left: 0, top: 0, width: 500, height: 500 }}
          spec={DEFAULT_LINEAR_GRADIENT}
          onChange={onChange}
        />,
      )
    })
    const layer = container.querySelector('.gradient-mask') as HTMLElement
    layer.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 500, height: 500,
      right: 500, bottom: 500, x: 0, y: 0, toJSON: () => ({}),
    })
    await act(async () => {
      layer.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: 100, clientY: 100,
      }))
      window.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))
    })
    await act(async () => {
      layer.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: 100, clientY: 100,
      }))
      window.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true, clientX: 101, clientY: 100,
      }))
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})
