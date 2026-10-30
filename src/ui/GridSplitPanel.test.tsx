// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import GridSplitPanel from './GridSplitPanel.tsx'

const { splitMock, downloadMock } = vi.hoisted(() => ({
  splitMock: vi.fn(),
  downloadMock: vi.fn(),
}))

vi.mock('../image/gridSplit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/gridSplit')>()
  return { ...actual, splitGrid: splitMock }
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

function choose(container: HTMLElement, name = 'a.jpg') {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File(['x'], name, { type: 'image/jpeg' })],
  })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function buttonWith(container: HTMLElement, text: string): HTMLButtonElement {
  const hit = [...container.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').includes(text))
  expect(hit, `找不到按钮：${text}`).toBeTruthy()
  return hit as HTMLButtonElement
}

describe('九宫格切图工作区', () => {
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
  })

  it('没选照片时不能下载；选了之后可以按当前切法导出', async () => {
    splitMock.mockResolvedValue({
      tiles: Array.from({ length: 4 }, (_, index) => ({
        index, row: Math.floor(index / 2), col: index % 2,
        width: 600, height: 400, blob: new Blob(['x']),
      })),
      zip: new Blob(['zip'], { type: 'application/zip' }),
      zipFilename: 'a_grid.zip',
    })
    const c = await mount(<GridSplitPanel onBack={() => {}} />)
    const download = buttonWith(c, '下载')
    expect(download.disabled).toBe(true)

    await act(async () => { choose(c) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(download.disabled).toBe(false)

    await act(async () => { buttonWith(c, '2×2').click() })
    await act(async () => { download.click(); await new Promise(r => setTimeout(r, 0)) })
    expect(splitMock).toHaveBeenCalledTimes(1)
    const [image, width, height, options, baseName] = splitMock.mock.calls[0]!
    expect(image).toMatchObject({ naturalWidth: 1200, naturalHeight: 800 })
    expect([width, height]).toEqual([1200, 800])
    expect(options).toMatchObject({ size: 2, format: 'image/jpeg', tileLongEdge: 1080 })
    expect(baseName).toBe('a.jpg')
    expect(downloadMock).toHaveBeenCalledWith(
      expect.any(Blob), 'a_grid.zip',
    )
    expect(c.textContent).toContain('九宫格已下载')
  })

  it('PNG 可以选透明底，格式和背景一起交给切图引擎', async () => {
    splitMock.mockResolvedValue({
      tiles: Array.from({ length: 9 }, (_, index) => ({
        index, row: Math.floor(index / 3), col: index % 3,
        width: 400, height: 267, blob: new Blob(['x']),
      })),
      zip: new Blob(['zip'], { type: 'application/zip' }),
      zipFilename: 'b_grid.zip',
    })
    const c = await mount(<GridSplitPanel onBack={() => {}} />)
    await act(async () => { choose(c, 'b.png') })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    await act(async () => { buttonWith(c, 'PNG').click() })
    expect(buttonWith(c, '透明底').getAttribute('aria-pressed')).toBe('false')
    await act(async () => { buttonWith(c, '透明底').click() })
    expect(buttonWith(c, '透明底').getAttribute('aria-pressed')).toBe('true')
    await act(async () => {
      buttonWith(c, '下载').click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(splitMock.mock.calls[0]![3]).toMatchObject({
      size: 3, format: 'image/png', background: 'transparent',
    })
  })
})
