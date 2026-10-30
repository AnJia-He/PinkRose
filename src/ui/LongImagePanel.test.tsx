// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LongImagePanel from './LongImagePanel.tsx'

const { exportMock, renderMock, downloadMock } = vi.hoisted(() => ({
  exportMock: vi.fn(),
  renderMock: vi.fn(),
  downloadMock: vi.fn(),
}))

vi.mock('../image/longImage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/longImage')>()
  return {
    ...actual,
    exportLongImage: exportMock,
    renderLongImageCanvas: renderMock,
  }
})
vi.mock('../export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/save')>()
  return { ...actual, downloadFile: downloadMock }
})

async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  return container
}

function choose(container: HTMLElement, names: string[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: names.map(name => new File(['x'], name, { type: 'image/jpeg' })),
  })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function buttonWith(container: HTMLElement, text: string): HTMLButtonElement {
  const hit = [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').includes(text))
  expect(hit, `找不到按钮：${text}`).toBeTruthy()
  return hit as HTMLButtonElement
}

describe('长图拼接工作区', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    class FakeImage {
      naturalWidth = 1200
      naturalHeight = 800
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) { queueMicrotask(() => this.onload?.()) }
    }
    vi.stubGlobal('Image', FakeImage)
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: vi.fn(() => new Proxy({} as Record<string, unknown>, {
        get: (target, prop) => (
          prop in target ? target[prop as string] : vi.fn()
        ),
        set: (target, prop, value) => {
          target[prop as string] = value
          return true
        },
      })),
    })
    renderMock.mockReturnValue({ width: 720, height: 900 } as HTMLCanvasElement)
    exportMock.mockResolvedValue({
      blob: new Blob(['long'], { type: 'image/jpeg' }),
      filename: 'a_long.jpg',
      width: 1080,
      height: 1542,
    })
  })

  it('至少两张照片才能生成；横向和顺序都会交给引擎', async () => {
    const c = await mount(<LongImagePanel onBack={() => {}} />)
    const run = buttonWith(c, '生成长图')
    expect(run.disabled).toBe(true)
    await act(async () => { choose(c, ['a.jpg']) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(run.disabled).toBe(true)
    await act(async () => { choose(c, ['b.jpg']) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(run.disabled).toBe(false)

    await act(async () => { buttonWith(c, '横向').click() })
    await act(async () => {
      run.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(exportMock).toHaveBeenCalledTimes(1)
    const [sources, options, baseName] = exportMock.mock.calls[0]!
    expect(sources).toHaveLength(2)
    expect(options).toMatchObject({ direction: 'horizontal', format: 'image/jpeg' })
    expect(baseName).toBe('a.jpg')
    expect(downloadMock).toHaveBeenCalledWith(
      expect.any(Blob), 'a_long.jpg',
    )
    expect(c.textContent).toContain('长图已下载')
  })

  it('上移会改变顺序，下一次导出用新的第一张命名', async () => {
    const c = await mount(<LongImagePanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg', 'b.jpg']) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    await act(async () => {
      ;(c.querySelector('[aria-label="上移 b.jpg"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      buttonWith(c, '生成长图').click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(exportMock).toHaveBeenCalledTimes(1)
    const [sources, , baseName] = exportMock.mock.calls[0]!
    expect(sources).toHaveLength(2)
    expect(baseName).toBe('b.jpg')
  })
})
