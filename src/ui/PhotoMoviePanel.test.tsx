// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PRESETS } from '../core/presets.ts'
import PhotoMoviePanel from './PhotoMoviePanel'

const { exportMock, previewMock, probeMock, downloadMock } = vi.hoisted(() => ({
  exportMock: vi.fn(),
  previewMock: vi.fn(),
  probeMock: vi.fn(),
  downloadMock: vi.fn(),
}))

vi.mock('../movie/export.ts', () => ({ exportPhotoMovie: exportMock }))
vi.mock('../movie/probe.ts', () => ({ probePhotoFile: probeMock }))
vi.mock('../image/decode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/decode')>()
  return { ...actual, createDecodedImagePreview: previewMock }
})
vi.mock('../export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/save')>()
  return { ...actual, downloadImage: downloadMock }
})

async function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(<PhotoMoviePanel onBack={() => {}} />)
  })
  return container
}

async function pickPhotos(container: HTMLElement, names = ['a.jpg', 'b.jpg']) {
  const input = container.querySelector('input[aria-label="选择要做成电影的照片"]') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: names.map(name => new File(['x'], name, { type: 'image/jpeg' })),
  })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const button = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(text)) as HTMLButtonElement

describe('照片电影', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true, value: vi.fn(() => `blob:${Math.random()}`),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    previewMock.mockResolvedValue({
      url: 'blob:decoded', width: 1920, height: 1080,
    })
    probeMock.mockResolvedValue({ width: 1920, height: 1080 })
    exportMock.mockResolvedValue(new Blob(['mp4'], { type: 'video/mp4' }))
  })

  it('选两张照片：列表两行，全片 5 秒 / 120 帧', async () => {
    const c = await mount()
    expect(button(c, '导出 MP4').disabled).toBe(true)
    await pickPhotos(c)
    expect(c.querySelectorAll('.video-clip')).toHaveLength(2)
    // 默认淡入淡出：2 张各 2.5 秒、24fps，重叠约 0.4 秒 → 110 帧 / 4.6 秒
    expect(c.textContent).toContain('全片 0:04.6')
    expect(c.textContent).toContain('110 帧')
    expect(button(c, '导出 MP4').disabled).toBe(false)
  })

  it('文件选择器包含常见厂商 RAW，而不是只放行八种后缀', async () => {
    const c = await mount()
    const input = c.querySelector(
      'input[aria-label="选择要做成电影的照片"]',
    ) as HTMLInputElement
    expect(input.accept).toContain('.pef')
    expect(input.accept).toContain('.x3f')
    expect(input.accept).toContain('.gpr')
  })

  it('Pentax RAW 能与普通照片一样进入电影选片列表', async () => {
    const c = await mount()
    await pickPhotos(c, ['IMGP1001.PEF'])
    expect(previewMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'IMGP1001.PEF' }),
    )
    expect(c.querySelectorAll('.video-clip')).toHaveLength(1)
    expect(c.textContent).not.toContain('不是照片')
  })

  it('拉远 + 预设 + 配乐原样交给导出，成片可下载', async () => {
    const c = await mount()
    await pickPhotos(c)
    await act(async () => {
      ([...c.querySelectorAll('[aria-label="镜头运动"] button')]
        .find(b => b.textContent === '拉远') as HTMLButtonElement).click()
    })
    const preset = PRESETS[0]!
    await act(async () => {
      ([...c.querySelectorAll('.video-presets button')]
        .find(b => b.textContent === preset.label) as HTMLButtonElement).click()
    })
    const musicInput = c.querySelector('input[aria-label="选择电影配乐"]') as HTMLInputElement
    Object.defineProperty(musicInput, 'files', {
      configurable: true,
      value: [new File(['x'], 'song.mp3', { type: 'audio/mpeg' })],
    })
    await act(async () => {
      musicInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await act(async () => { button(c, '导出 MP4').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    const opts = exportMock.mock.calls[0]![0]
    expect(opts.photos).toHaveLength(2)
    expect(opts.perPhotoMs).toBe(2500)
    expect(opts.motion).toBe('out')
    expect(opts.transition).toBe('fade')
    expect(opts.adjustments.contrast).toBe(preset.adjustments.contrast)
    expect(opts.music).toMatchObject({ volume: 60 })
    expect(button(c, '下载成片').disabled).toBe(false)
  })

  it('取消导出：提示已取消，不留成片', async () => {
    const c = await mount()
    await pickPhotos(c)
    exportMock.mockImplementationOnce((opts: { signal: AbortSignal }) =>
      new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
        })
      }))
    await act(async () => { button(c, '导出 MP4').click() })
    await act(async () => { button(c, '取消').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('已取消')
    expect(button(c, '下载成片').disabled).toBe(true)
  })
})
