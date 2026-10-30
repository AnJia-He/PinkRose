// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PosterPanel from './PosterPanel'

const { renderMock, downloadMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  downloadMock: vi.fn(),
}))

vi.mock('../poster/poster', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../poster/poster')>()
  return { ...actual, renderPoster: renderMock }
})
vi.mock('../export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/save')>()
  return { ...actual, downloadImage: downloadMock }
})

async function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(<PosterPanel onBack={() => {}} />)
  })
  return container
}

function choose(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File(['x'], 'portrait.jpg', { type: 'image/jpeg' })],
  })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('社交封面', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true, value: vi.fn(() => 'blob:poster'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true, value: vi.fn(),
    })
    renderMock.mockResolvedValue({
      blob: new Blob(['poster'], { type: 'image/jpeg' }),
      width: 1080, height: 1440,
      filename: 'PinkRose-poster-xiaohongshu-20261020-0100.jpg',
    })
  })

  it('选照片后生成预览，标题变化会重新排版，并可下载', async () => {
    const c = await mount()
    await act(async () => {
      choose(c)
      await new Promise(r => setTimeout(r, 240))
    })
    expect(renderMock).toHaveBeenCalled()
    expect(renderMock.mock.calls.at(-1)![1]).toMatchObject({
      template: 'xiaohongshu',
      title: '把今天的光留住',
      format: 'image/jpeg',
    })
    expect(c.querySelector('.poster-preview')).toBeTruthy()

    const title = [...c.querySelectorAll('input')]
      .find(el => (el as HTMLInputElement).value === '把今天的光留住') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(title, '新的封面标题')
      title.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 240))
    })
    expect(renderMock.mock.calls.at(-1)![1]).toMatchObject({ title: '新的封面标题' })

    const download = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.includes('下载海报')) as HTMLButtonElement
    await act(async () => { download.click() })
    expect(downloadMock).toHaveBeenCalledWith(
      expect.any(Blob), 'PinkRose-poster-xiaohongshu-20261020-0100.jpg',
    )
  })
})
