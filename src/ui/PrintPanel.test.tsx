// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PrintPanel from './PrintPanel'

const { renderMock, downloadMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  downloadMock: vi.fn(),
}))

vi.mock('../print/printSheet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../print/printSheet')>()
  return { ...actual, renderPrintSheet: renderMock }
})
vi.mock('../export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/save')>()
  return { ...actual, downloadImage: downloadMock }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
  const printBlob = new Blob(['print'], { type: 'image/jpeg' })
  Object.defineProperty(printBlob, 'arrayBuffer', {
    value: async () => new TextEncoder().encode('print').buffer,
  })
  renderMock.mockResolvedValue({
    blob: printBlob,
    width: 900, height: 600,
    filename: 'PinkRose-print-6x4-8-20261017-0805.jpg',
  })
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true, value: vi.fn(() => 'blob:print'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true, value: vi.fn(),
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function mount() {
  await act(async () => {
    root.render(<PrintPanel onBack={() => {}} />)
  })
}

function choose(names: string[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: names.map(name => new File(['x'], name, { type: 'image/jpeg' })),
  })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('打印排版', () => {
  it('没照片时不能下载，七套模板都在', async () => {
    await mount()
    expect(container.textContent).toContain('6 寸 · 8 张')
    expect(container.textContent).toContain('A4 · 9 张')
    expect(container.textContent).toContain('5×7 · 2 张')
    expect(container.textContent).toContain('A5 · 4 张')
    const download = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.includes('下载排版 JPG')) as HTMLButtonElement
    expect(download.disabled).toBe(true)
  })

  it('选照片后生成预览，切 A4 后下载完整排版', async () => {
    await mount()
    await act(async () => {
      choose(['a.jpg', 'b.jpg'])
      await new Promise(r => setTimeout(r, 220))
    })
    expect(renderMock).toHaveBeenCalled()
    expect(renderMock.mock.calls.at(-1)![1]).toBe('6x4-8')
    expect(renderMock.mock.calls.at(-1)![4]).toBe(900)
    expect(container.querySelector('.print-preview')).toBeTruthy()

    const select = container.querySelector('select') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(select, 'a4-9')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 220))
    })
    expect(renderMock.mock.calls.at(-1)![1]).toBe('a4-9')
    const direction = container.querySelectorAll('label.batch-preset select')[1] as HTMLSelectElement
    await act(async () => {
      setter.call(direction, 'portrait')
      direction.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 220))
    })
    expect(renderMock.mock.calls.at(-1)![6]).toBe('portrait')

    const download = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.includes('下载排版 JPG')) as HTMLButtonElement
    await act(async () => {
      download.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(renderMock.mock.calls.at(-1)![4]).toBeUndefined()
    expect(downloadMock).toHaveBeenCalledWith(
      expect.any(Blob), 'PinkRose-print-6x4-8-20261017-0805.jpg',
    )
  })

  it('每格可以单独换图，也能一键恢复按顺序铺', async () => {
    await mount()
    await act(async () => {
      choose(['a.jpg', 'b.jpg'])
      await new Promise(r => setTimeout(r, 220))
    })
    const cells = [...container.querySelectorAll('.print-cell select')] as HTMLSelectElement[]
    expect(cells).toHaveLength(8)
    expect(renderMock.mock.calls.at(-1)![5]).toMatchObject({
      order: [0, 1, 0, 1, 0, 1, 0, 1],
      marginPct: 3.5,
      gapPct: 1.8,
    })

    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(cells[2]!, '1')
      cells[2]!.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 220))
    })
    expect(renderMock.mock.calls.at(-1)![5].order[2]).toBe(1)

    const reset = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '按顺序铺') as HTMLButtonElement
    await act(async () => { reset.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 220)) })
    expect(renderMock.mock.calls.at(-1)![5].order[2]).toBe(0)
  })

  it('下载 PDF：把排好的 JPEG 包成 300dpi 单页 PDF', async () => {
    await mount()
    await act(async () => {
      choose(['a.jpg'])
      await new Promise(r => setTimeout(r, 220))
    })
    const pdf = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.includes('下载 PDF')) as HTMLButtonElement
    await act(async () => {
      pdf.click()
      await new Promise(r => setTimeout(r, 0))
    })
    const [blob, filename] = downloadMock.mock.calls.at(-1)!
    expect(blob).toBeInstanceOf(Blob)
    expect((blob as Blob).type).toBe('application/pdf')
    expect(filename).toMatch(/^PinkRose-print-.*\.pdf$/)
  })

  it('自定义相纸：毫米尺寸换算成 300dpi 像素和行列', async () => {
    await mount()
    await act(async () => {
      choose(['a.jpg'])
      await new Promise(r => setTimeout(r, 220))
    })
    const template = container.querySelectorAll('label.batch-preset select')[0] as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(template, 'custom')
      template.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 220))
    })
    const numbers = [...container.querySelectorAll('.print-custom-fields input')] as HTMLInputElement[]
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      inputSetter.call(numbers[0]!, '100')
      numbers[0]!.dispatchEvent(new Event('input', { bubbles: true }))
      inputSetter.call(numbers[1]!, '150')
      numbers[1]!.dispatchEvent(new Event('input', { bubbles: true }))
      inputSetter.call(numbers[2]!, '3')
      numbers[2]!.dispatchEvent(new Event('input', { bubbles: true }))
      inputSetter.call(numbers[3]!, '2')
      numbers[3]!.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 220))
    })
    expect(renderMock.mock.calls.at(-1)![7]).toMatchObject({
      width: Math.round(100 / 25.4 * 300),
      height: Math.round(150 / 25.4 * 300),
      cols: 3,
      rows: 2,
    })
  })
})
