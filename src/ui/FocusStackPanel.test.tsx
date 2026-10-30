// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FocusStackPanel from './FocusStackPanel.tsx'

const { exportMock, previewMock, downloadMock, renderMock } = vi.hoisted(() => ({
  exportMock: vi.fn(),
  previewMock: vi.fn(),
  downloadMock: vi.fn(),
  renderMock: vi.fn(),
}))

vi.mock('../image/focusStack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/focusStack')>()
  return {
    ...actual,
    exportFocusStack: exportMock,
    renderFocusStackCanvas: renderMock,
  }
})
vi.mock('../export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/save')>()
  return { ...actual, downloadImage: downloadMock }
})
vi.mock('../image/decode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/decode')>()
  return { ...actual, createDecodedImagePreview: previewMock }
})

async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  return container
}

async function choose(container: HTMLElement, names: string[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: names.map(name => new File(['x'], name, { type: 'image/jpeg' })),
  })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('焦点堆栈工作区', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    previewMock.mockResolvedValue({
      url: 'blob:decoded', width: 1200, height: 800,
    })
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
      value: vi.fn(() => ({ clearRect: vi.fn(), drawImage: vi.fn() })),
    })
  })

  it('至少两张对焦照片才能生成', async () => {
    const c = await mount(<FocusStackPanel onBack={() => {}} />)
    const run = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('生成焦点堆栈'))!
    expect(run.disabled).toBe(true)
    await act(async () => { await choose(c, ['near.jpg']) })
    expect(run.disabled).toBe(true)
    await act(async () => { await choose(c, ['far.jpg']) })
    expect(run.disabled).toBe(false)
    expect(c.querySelectorAll('.batch-file-row')).toHaveLength(2)
  })

  it('★ 相机焦点包围带来的整组照片会直接预填', async () => {
    const files = [
      new File(['a'], 'focus-1.jpg', { type: 'image/jpeg' }),
      new File(['b'], 'focus-2.jpg', { type: 'image/jpeg' }),
      new File(['c'], 'focus-3.jpg', { type: 'image/jpeg' }),
    ]
    const c = await mount(<FocusStackPanel onBack={() => {}} initialFiles={files} />)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(c.querySelectorAll('.batch-file-row')).toHaveLength(3)
    expect(c.textContent).toContain('focus-1.jpg')
    expect(c.textContent).toContain('focus-3.jpg')
  })

  it('★ StrictMode 的模拟卸载不会提前释放预填照片的 blob', async () => {
    const revoke = vi.fn()
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revoke,
    })
    const files = [
      new File(['a'], 'focus-1.jpg', { type: 'image/jpeg' }),
      new File(['b'], 'focus-2.jpg', { type: 'image/jpeg' }),
    ]
    const c = await mount(
      <StrictMode>
        <FocusStackPanel onBack={() => {}} initialFiles={files} />
      </StrictMode>,
    )
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(c.querySelectorAll('.batch-file-row')).toHaveLength(2)
    expect(revoke).not.toHaveBeenCalled()
  })

  it('文件选择器包含常见厂商 RAW，而不是只放行八种后缀', async () => {
    const c = await mount(<FocusStackPanel onBack={() => {}} />)
    const accept = (c.querySelector('input[type="file"]') as HTMLInputElement).accept
    expect(accept).toContain('.pef')
    expect(accept).toContain('.x3f')
    expect(accept).toContain('.gpr')
  })

  it('Pentax RAW 能进入焦点堆栈列表并使用解码后的预览', async () => {
    const c = await mount(<FocusStackPanel onBack={() => {}} />)
    await act(async () => { await choose(c, ['IMGP2001.PEF']) })
    expect(previewMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'IMGP2001.PEF' }),
    )
    expect(c.querySelectorAll('.batch-file-row')).toHaveLength(1)
    expect(c.textContent).not.toContain('不是照片')
  })

  it('对齐和导出参数原样交给引擎，生成后直接下载', async () => {
    exportMock.mockResolvedValue({
      blob: new Blob(['focus'], { type: 'image/png' }),
      filename: 'PinkRose-focus-20261019-1200.png',
      width: 2400,
      height: 1600,
    })
    const c = await mount(<FocusStackPanel onBack={() => {}} />)
    await act(async () => { await choose(c, ['a.jpg', 'b.jpg']) })
    const align = c.querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => { align.click() })
    const png = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === 'PNG')!
    await act(async () => { png.click() })
    const height = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '2000')!
    await act(async () => { height.click() })
    const run = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('生成焦点堆栈'))!
    await act(async () => { run.click() })

    expect(exportMock).toHaveBeenCalledTimes(1)
    expect(exportMock.mock.calls[0]![1]).toMatchObject({
      align: false, format: 'image/png', height: 2000,
    })
    expect(downloadMock).toHaveBeenCalledWith(
      expect.any(Blob),
      'PinkRose-focus-20261019-1200.png',
    )
    expect(c.textContent).toContain('焦点堆栈已下载')
    expect(c.textContent).toContain('2400×1600')
  })
})
