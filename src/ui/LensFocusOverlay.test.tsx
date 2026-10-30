// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LensFocusOverlay from './LensFocusOverlay'

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

const BOX = { left: 100, top: 50, width: 200, height: 100 }

async function mount(
  onChange: (x: number, y: number) => void,
  x = 0.5,
  y = 0.5,
  extra: { shape?: 'radial' | 'tilt'; angle?: number; band?: number } = {},
) {
  await act(async () => {
    root.render(<LensFocusOverlay box={BOX} x={x} y={y} onChange={onChange} {...extra} />)
  })
  return container.querySelector('.lens-focus-handle') as HTMLButtonElement
}

describe('镜头虚化焦点环', () => {
  it('★ 按下和拖动都换算成照片上的 0~1 坐标，拖出边界会夹住', async () => {
    const onChange = vi.fn()
    const handle = await mount(onChange)

    await act(async () => {
      handle.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: 150, clientY: 100,
      }))
      window.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true, clientX: 250, clientY: 130,
      }))
      window.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true, clientX: 999, clientY: -999,
      }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })

    expect(onChange.mock.calls[0]).toEqual([0.25, 0.5])
    expect(onChange.mock.calls[1]).toEqual([0.75, 0.8])
    expect(onChange.mock.calls[2]).toEqual([1, 0])
  })

  it('★ 方向键移动 0.02、Shift 加速到 0.1、Home 回中心', async () => {
    const onChange = vi.fn()
    const handle = await mount(onChange)

    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: 'ArrowRight',
      }))
    })
    expect(onChange).toHaveBeenLastCalledWith(0.52, 0.5)

    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: 'ArrowDown', shiftKey: true,
      }))
    })
    expect(onChange).toHaveBeenLastCalledWith(0.5, 0.6)

    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: 'Home',
      }))
    })
    expect(onChange).toHaveBeenLastCalledWith(0.5, 0.5)
  })

  it('卸载时摘掉 window 上的拖动监听（不会继续改参数）', async () => {
    const onChange = vi.fn()
    const handle = await mount(onChange)
    await act(async () => {
      handle.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: 150, clientY: 100,
      }))
    })
    const before = onChange.mock.calls.length
    await act(async () => root.render(null))
    window.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true, clientX: 250, clientY: 130,
    }))
    expect(onChange).toHaveBeenCalledTimes(before)
  })

  it('★ 移轴模式显示可旋转的清晰带，拖动手柄仍改清晰带位置', async () => {
    const onChange = vi.fn()
    const handle = await mount(onChange, 0.5, 0.35, { shape: 'tilt', angle: 28, band: 0.24 })
    const band = container.querySelector('.lens-focus-band') as HTMLDivElement
    expect(band).toBeTruthy()
    expect(band.style.transform).toContain('rotate(28deg)')
    expect(band.style.height).toBe('48%')
    expect(handle.getAttribute('aria-label')).toContain('清晰带')
  })
})
