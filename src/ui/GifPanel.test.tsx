// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import GifPanel from './GifPanel'

const { encodeMock, downloadMock, motionMock } = vi.hoisted(() => ({
  encodeMock: vi.fn(),
  downloadMock: vi.fn(),
  motionMock: vi.fn(),
}))

vi.mock('../gif/gif', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gif/gif')>()
  return { ...actual, encodeGifFromFiles: encodeMock }
})
vi.mock('../export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/save')>()
  return { ...actual, downloadImage: downloadMock }
})
vi.mock('../gif/motion', () => ({
  renderMotionMp4: motionMock,
}))

async function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(<GifPanel onBack={() => {}} />)
  })
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

describe('照片动图', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true, value: vi.fn(() => 'blob:gif'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true, value: vi.fn(),
    })
    encodeMock.mockResolvedValue(new Blob(['gif'], { type: 'image/gif' }))
    motionMock.mockResolvedValue(new Blob(['mp4'], { type: 'video/mp4' }))
  })

  it('至少两张才能生成；生成后出现预览和下载', async () => {
    const c = await mount()
    const make = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.includes('生成动图')) as HTMLButtonElement
    expect(make.disabled).toBe(true)
    await act(async () => { choose(c, ['a.jpg', 'b.jpg']) })
    expect(make.disabled).toBe(false)
    await act(async () => {
      make.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(encodeMock).toHaveBeenCalledWith(
      expect.arrayContaining([expect.any(File), expect.any(File)]),
      expect.objectContaining({
        width: 720, height: 720, delayMs: 800, fit: 'cover', loop: true,
      }),
    )
    expect(c.querySelector('.gif-preview')).toBeTruthy()
    const download = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.includes('下载 GIF')) as HTMLButtonElement
    expect(download.disabled).toBe(false)
    await act(async () => { download.click() })
    expect(downloadMock).toHaveBeenCalledWith(
      expect.any(Blob), expect.stringMatching(/^PinkRose-motion-.*\.gif$/),
    )
  })

  it('完整留白可选底色，设置原样交给编码器', async () => {
    const c = await mount()
    await act(async () => { choose(c, ['a.jpg', 'b.jpg']) })
    const fit = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '完整留白') as HTMLButtonElement
    await act(async () => { fit.click() })
    const color = c.querySelector('input[type="color"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(color, '#112233')
      color.dispatchEvent(new Event('input', { bubbles: true }))
      color.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const make = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.includes('生成动图')) as HTMLButtonElement
    await act(async () => {
      make.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(encodeMock.mock.calls.at(-1)![1]).toMatchObject({
      fit: 'contain', background: '#112233',
    })
  })

  it('导出 MP4：把同一组画幅 / 停留参数交给服务端编码', async () => {
    const c = await mount()
    await act(async () => { choose(c, ['a.jpg', 'b.jpg']) })
    const mp4 = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.includes('导出 MP4')) as HTMLButtonElement
    await act(async () => {
      mp4.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(motionMock).toHaveBeenCalledWith(
      expect.arrayContaining([expect.any(File), expect.any(File)]),
      expect.objectContaining({
        width: 720, height: 720, delayMs: 800, fit: 'cover',
      }),
    )
    expect(downloadMock).toHaveBeenCalledWith(
      expect.any(Blob), expect.stringMatching(/^PinkRose-motion-.*\.mp4$/),
    )
  })
})
