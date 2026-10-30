// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LayerPanel from './LayerPanel'
import { DEFAULT_TEXT } from '../../shared/text.ts'
import { DEFAULT_SHAPE } from '../../shared/shape.ts'
import { DEFAULT_STICKER } from '../../shared/sticker.ts'
import type { EditLayer } from '../../shared/layers.ts'

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

const text = (id: string, value: string, visible = true): EditLayer => ({
  kind: 'text', id,
  options: { ...DEFAULT_TEXT, text: value },
  ...(visible ? {} : { visible: false }),
})
const shape = (id: string): EditLayer => ({
  kind: 'shape', id, options: { ...DEFAULT_SHAPE, kind: 'ellipse' },
})
const sticker = (id: string): EditLayer => ({
  kind: 'sticker', id, options: { ...DEFAULT_STICKER, shape: 'heart' }, image: null,
})
const local = (id: string): EditLayer => ({
  kind: 'local', id,
  mask: 'data:image/png;base64,AA', maskWidth: 100, maskHeight: 100, feather: 20,
  options: { effect: 'tone', exposure: 20, contrast: 0, saturation: 0, temperature: 0 },
})

async function renderPanel(layers: EditLayer[], handlers: Partial<{
  onToggle: (id: string) => void
  onMove: (id: string, dir: 'up' | 'down') => void
  onDelete: (id: string) => void
  onEdit: (id: string) => void
}> = {}) {
  const onToggle = vi.fn(handlers.onToggle)
  const onMove = vi.fn(handlers.onMove)
  const onDelete = vi.fn(handlers.onDelete)
  const onEdit = vi.fn(handlers.onEdit)
  await act(async () => {
    root.render(
      <LayerPanel
        layers={layers}
        onToggle={onToggle}
        onMove={onMove}
        onDelete={onDelete}
        onEdit={onEdit}
      />,
    )
  })
  return { onToggle, onMove, onDelete, onEdit }
}

describe('统一图层面板', () => {
  it('没有层时不画；叠图层在上、局部层在下，组内各自倒序', async () => {
    await renderPanel([])
    expect(container.querySelector('.layer-panel')).toBeNull()

    await renderPanel([
      local('l1'), text('t1', '第一'), local('l2'), text('t2', '第二'),
      shape('s1'), sticker('k1'),
    ])
    const rows = [...container.querySelectorAll('.layer-row')]
    expect(rows.map(row => row.querySelector('.layer-name')?.textContent)).toEqual([
      '贴纸 · 爱心', '形状 · 椭圆', '文字 · 第二', '文字 · 第一', '局部层 2', '局部层 1',
    ])
    expect(container.querySelector('.layer-count')?.textContent).toBe('6')
  })

  it('眼睛 = 显示 / 隐藏；点名字回来改；上下移和删除都把 id 交出去', async () => {
    const handlers = await renderPanel([
      text('t1', '第一'), text('t2', '第二', false), local('l1'),
    ])
    const firstRow = container.querySelector('.layer-row')!
    const eye = firstRow.querySelector('.layer-eye') as HTMLButtonElement
    expect(eye.getAttribute('aria-pressed')).toBe('false')
    expect(firstRow.classList.contains('off')).toBe(true)
    await act(async () => { eye.click() })
    expect(handlers.onToggle).toHaveBeenCalledWith('t2')

    await act(async () => {
      (container.querySelector('.layer-row .layer-name') as HTMLButtonElement).click()
    })
    expect(handlers.onEdit).toHaveBeenCalledWith('t2')

    const upSecond = container.querySelector('[aria-label="上移文字 · 第一"]') as HTMLButtonElement
    const upTop = container.querySelector('[aria-label="上移文字 · 第二"]') as HTMLButtonElement
    expect(upSecond.disabled).toBe(false)
    expect(upTop.disabled).toBe(true)
    await act(async () => { upSecond.click() })
    expect(handlers.onMove).toHaveBeenCalledWith('t1', 'up')

    await act(async () => {
      (container.querySelector('[aria-label="删除文字 · 第一"]') as HTMLButtonElement).click()
    })
    expect(handlers.onDelete).toHaveBeenCalledWith('t1')
  })
})
