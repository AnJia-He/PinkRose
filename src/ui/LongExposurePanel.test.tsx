// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LongExposurePanel from './LongExposurePanel.tsx'

const { exportMock, downloadMock, renderMock } = vi.hoisted(() => ({
  exportMock: vi.fn(),
  downloadMock: vi.fn(),
  renderMock: vi.fn(),
}))

vi.mock('../image/longExposure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/longExposure')>()
  return {
    ...actual,
    exportLongExposure: exportMock,
    renderLongExposureCanvas: renderMock,
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

describe('长曝光工作区', () => {
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
    renderMock.mockReturnValue({
      canvas: Object.assign(document.createElement('canvas'), { width: 720, height: 480 }),
      width: 720,
      height: 480,
    })
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: vi.fn(() => ({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
      })),
    })
  })

  it('至少两张照片才能生成长曝光', async () => {
    const c = await mount(<LongExposurePanel onBack={() => {}} />)
    const run = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('生成长曝光'))!
    expect(run.disabled).toBe(true)
    await act(async () => { choose(c, ['frame-1.jpg']) })
    expect(run.disabled).toBe(true)
    await act(async () => { choose(c, ['frame-2.jpg']) })
    expect(run.disabled).toBe(false)
    expect(c.querySelectorAll('.batch-file-row')).toHaveLength(2)
  })

  it('光轨模式、自动对齐和输出设置会传给合成引擎', async () => {
    exportMock.mockResolvedValue({
      blob: new Blob(['long'], { type: 'image/jpeg' }),
      filename: 'PinkRose-long-exposure-20261018-1100.jpg',
      width: 2400,
      height: 1600,
    })
    const c = await mount(<LongExposurePanel onBack={() => {}} />)
    await act(async () => { choose(c, ['frame-1.jpg', 'frame-2.jpg']) })
    const trail = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '车流光轨')!
    await act(async () => { trail.click() })
    const align = c.querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => { align.click() })
    const run = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('生成长曝光'))!
    await act(async () => { run.click() })
    expect(exportMock).toHaveBeenCalledTimes(1)
    expect(exportMock.mock.calls[0]![1]).toMatchObject({
      mode: 'trail', align: false, format: 'image/jpeg',
    })
  })

  it('生成后直接下载，并留下再下载一次的入口', async () => {
    exportMock.mockResolvedValue({
      blob: new Blob(['long'], { type: 'image/jpeg' }),
      filename: 'PinkRose-long-exposure-20261018-1100.jpg',
      width: 2400,
      height: 1600,
    })
    const c = await mount(<LongExposurePanel onBack={() => {}} />)
    await act(async () => { choose(c, ['frame-1.jpg', 'frame-2.jpg']) })
    const run = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('生成长曝光'))!
    await act(async () => { run.click() })
    expect(downloadMock).toHaveBeenCalledWith(
      expect.any(Blob),
      'PinkRose-long-exposure-20261018-1100.jpg',
    )
    expect(c.textContent).toContain('长曝光已下载')
    expect(c.textContent).toContain('2400×1600')
    const again = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('再下载一次'))!
    await act(async () => { again.click() })
    expect(downloadMock).toHaveBeenCalledTimes(2)
  })
})
