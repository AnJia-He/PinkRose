// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TextOverlay from './TextOverlay'
import { DEFAULT_TEXT } from '../image/text'

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

const box = { left: 10, top: 20, width: 500, height: 400 }

describe('文字预览层', () => {
  it('★ 字号按照片缩放；多行以中心排开', async () => {
    await act(async () => {
      root.render(
        <TextOverlay
          box={box}
          imageWidth={1000}
          imageHeight={800}
          options={{ ...DEFAULT_TEXT, text: '上\n下', fontPx: 100 }}
          onMove={() => {}}
        />,
      )
    })

    const preview = container.querySelector('.text-preview') as HTMLElement
    expect(preview).toBeTruthy()
    expect(preview.style.fontSize).toBe('50px')
    expect(preview.style.left).toBe(`${0.5 * box.width}px`)
    expect(preview.style.top).toBe(`${0.5 * box.height}px`)
    const lines = [...container.querySelectorAll('.text-preview-line')] as HTMLElement[]
    expect(lines.map(l => l.textContent)).toEqual(['上', '下'])
  })

  it('★ 拖动文字块 = 屏幕位移换算回 0~1', async () => {
    const moved = vi.fn()
    await act(async () => {
      root.render(
        <TextOverlay
          box={box}
          imageWidth={1000}
          imageHeight={800}
          options={{ ...DEFAULT_TEXT, text: '你好' }}
          onMove={moved}
        />,
      )
    })

    const preview = container.querySelector('.text-preview') as HTMLElement
    await act(async () => {
      preview.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: 300, clientY: 240,
      }))
      window.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true, clientX: 350, clientY: 280,
      }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })

    expect(moved).toHaveBeenCalledTimes(1)
    const [x, y] = moved.mock.calls[0]!
    expect(x).toBeCloseTo(0.6, 6)
    expect(y).toBeCloseTo(0.6, 6)
  })

  it('空文字不画预览', async () => {
    await act(async () => {
      root.render(
        <TextOverlay
          box={box}
          imageWidth={1000}
          imageHeight={800}
          options={{ ...DEFAULT_TEXT }}
          onMove={() => {}}
        />,
      )
    })
    expect(container.querySelector('.text-preview')).toBeNull()
  })

  it('★ 对齐 / 加粗 / 描边 / 阴影 / 底色都进预览样式', async () => {
    await act(async () => {
      root.render(
        <TextOverlay
          box={box}
          imageWidth={1000}
          imageHeight={800}
          options={{
            ...DEFAULT_TEXT, text: '样式', fontPx: 100,
            align: 'left', bold: true, outlineWidth: 4, outlineColor: '#ff0000',
            shadow: true, background: true, backgroundColor: '#000000', backgroundOpacity: 50,
          }}
          onMove={() => {}}
        />
      )
    })
    const preview = container.querySelector('.text-preview') as HTMLElement
    expect(preview.style.fontWeight).toBe('700')
    expect(preview.style.textAlign).toBe('left')
    expect(preview.style.background).toContain('rgba')
    expect(preview.style.getPropertyValue('-webkit-text-stroke')).toContain('2px')
    expect(preview.style.textShadow).toContain('rgba')
  })

  it('★ 旋转角度跟着预览转，拖动中心不变', async () => {
    await act(async () => {
      root.render(
        <TextOverlay
          box={box}
          imageWidth={1000}
          imageHeight={800}
          options={{ ...DEFAULT_TEXT, text: '斜着', rotation: 30 }}
          onMove={() => {}}
        />,
      )
    })
    const preview = container.querySelector('.text-preview') as HTMLElement
    expect(preview.style.transform).toContain('translate(-50%, -50%)')
    expect(preview.style.transform).toContain('rotate(30deg)')
    expect(preview.style.left).toBe(`${0.5 * box.width}px`)
    expect(preview.style.top).toBe(`${0.5 * box.height}px`)
  })

  it('★ 行距和字距跟着屏幕缩放进入预览样式', async () => {
    await act(async () => {
      root.render(
        <TextOverlay
          box={box}
          imageWidth={1000}
          imageHeight={800}
          options={{
            ...DEFAULT_TEXT, text: '排\n版', fontPx: 100,
            lineHeight: 1.6, letterSpacing: 20,
          }}
          onMove={() => {}}
        />,
      )
    })
    const preview = container.querySelector('.text-preview') as HTMLElement
    expect(preview.style.lineHeight).toBe('80px')
    expect(preview.style.letterSpacing).toBe('10px')
  })
})
