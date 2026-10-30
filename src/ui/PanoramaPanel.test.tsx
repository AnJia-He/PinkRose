// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PanoramaPanel from './PanoramaPanel.tsx'

const { exportMock, downloadMock, renderMock } = vi.hoisted(() => ({
  exportMock: vi.fn(),
  downloadMock: vi.fn(),
  renderMock: vi.fn(),
}))

vi.mock('../image/panorama', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/panorama')>()
  return {
    ...actual,
    exportPanorama: exportMock,
    renderPanoramaCanvas: renderMock,
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

describe('全景工作区', () => {
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
      canvas: Object.assign(document.createElement('canvas'), { width: 1440, height: 480 }),
      layout: { width: 1440, height: 480, placements: [] },
    })
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: vi.fn(() => ({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
      })),
    })
  })

  it('至少两张照片才能生成全景', async () => {
    const c = await mount(<PanoramaPanel onBack={() => {}} />)
    const run = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('生成全景'))!
    expect(run.disabled).toBe(true)
    await act(async () => { choose(c, ['a.jpg']) })
    expect(run.disabled).toBe(true)
    await act(async () => { choose(c, ['b.jpg']) })
    expect(run.disabled).toBe(false)
    expect(c.querySelectorAll('.panorama-file-row')).toHaveLength(2)
  })

  it('可以把照片上移 / 下移，顺序就是拼接顺序', async () => {
    const c = await mount(<PanoramaPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg', 'b.jpg', 'c.jpg']) })
    const names = () => [...c.querySelectorAll('.batch-file-name')]
      .map(node => node.textContent)
    expect(names()).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
    const upB = c.querySelector('[aria-label="上移 b.jpg"]') as HTMLButtonElement
    await act(async () => { upB.click() })
    expect(names()).toEqual(['b.jpg', 'a.jpg', 'c.jpg'])
    const downB = c.querySelector('[aria-label="下移 b.jpg"]') as HTMLButtonElement
    await act(async () => { downB.click() })
    expect(names()).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
  })

  it('生成后直接下载，并留下再下载一次的入口', async () => {
    exportMock.mockResolvedValue({
      blob: new Blob(['panorama'], { type: 'image/jpeg' }),
      filename: 'PinkRose-panorama-20261018-0930.jpg',
      width: 4200,
      height: 1600,
    })
    const c = await mount(<PanoramaPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg', 'b.jpg']) })
    const vertical = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '纵向')!
    await act(async () => { vertical.click() })
    const run = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('生成全景'))!
    await act(async () => { run.click() })
    expect(exportMock).toHaveBeenCalledTimes(1)
    expect(exportMock.mock.calls[0]![0]).toHaveLength(2)
    expect(exportMock.mock.calls[0]![1]).toMatchObject({ axis: 'vertical' })
    expect(downloadMock).toHaveBeenCalledWith(
      expect.any(Blob),
      'PinkRose-panorama-20261018-0930.jpg',
    )
    expect(c.textContent).toContain('全景已下载')
    expect(c.textContent).toContain('4200×1600')
    const again = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('再下载一次'))!
    await act(async () => { again.click() })
    expect(downloadMock).toHaveBeenCalledTimes(2)
  })
})
