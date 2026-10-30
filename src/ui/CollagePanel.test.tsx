// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CollagePanel from './CollagePanel.tsx'

const { exportMock, downloadMock } = vi.hoisted(() => ({
  exportMock: vi.fn(),
  downloadMock: vi.fn(),
}))

vi.mock('../image/collage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/collage')>()
  return {
    ...actual,
    exportCollage: exportMock,
    renderCollageCanvas: () => {
      const canvas = document.createElement('canvas')
      canvas.width = 720
      canvas.height = 900
      return canvas
    },
  }
})
vi.mock('../export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/save')>()
  return { ...actual, downloadImage: downloadMock }
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

describe('拼图工作区', () => {
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
      value: vi.fn(() => ({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
      })),
    })
  })

  it('至少两张照片才能生成拼图', async () => {
    const c = await mount(<CollagePanel onBack={() => {}} />)
    const run = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('生成拼图'))!
    expect(run.disabled).toBe(true)
    await act(async () => { choose(c, ['a.jpg']) })
    expect(run.disabled).toBe(true)
    await act(async () => { choose(c, ['b.jpg']) })
    expect(run.disabled).toBe(false)
    expect(c.querySelectorAll('.collage-file-row')).toHaveLength(2)
  })

  it('生成后直接下载，并留下再下载一次的入口', async () => {
    exportMock.mockResolvedValue({
      blob: new Blob(['collage'], { type: 'image/jpeg' }),
      filename: 'PinkRose-collage-20261017-1805.jpg',
      width: 1638,
      height: 2048,
    })
    const c = await mount(<CollagePanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg', 'b.jpg']) })
    const magazine = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '杂志')!
    await act(async () => { magazine.click() })
    const run = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('生成拼图'))!
    await act(async () => { run.click() })
    expect(exportMock).toHaveBeenCalledTimes(1)
    expect(exportMock.mock.calls[0]![1]).toMatchObject({
      ratio: '4:5', layout: 'feature-left', gap: 6, radius: 0, background: '#111111',
    })
    expect(downloadMock).toHaveBeenCalledWith(
      expect.any(Blob),
      'PinkRose-collage-20261017-1805.jpg',
    )
    expect(c.textContent).toContain('拼图已下载')
    const again = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('再下载一次'))!
    await act(async () => { again.click() })
    expect(downloadMock).toHaveBeenCalledTimes(2)
  })
})
