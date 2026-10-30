// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import * as photoInfo from '../core/photoInfo.ts'
import LensProfilePicker from './LensProfilePicker.tsx'

vi.mock('../core/photoInfo.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/photoInfo.ts')>()
  return { ...actual, readLensInfo: vi.fn() }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

const file = new File(['x'], 'IMG_0001.JPG', { type: 'image/jpeg' })

async function render(onChange = vi.fn()) {
  await act(async () => {
    root.render(<LensProfilePicker file={file} value={ZERO} onChange={onChange} />)
    await Promise.resolve()
  })
  return onChange
}

describe('镜头配置文件', () => {
  it('认出镜头后给出配置，点「套用配置」只写三条校正值', async () => {
    vi.mocked(photoInfo.readLensInfo).mockResolvedValue({
      make: 'SONY', model: 'ILCE-7RM5', lens: 'FE 85mm F1.8',
      focalMm: 85, focal35mm: 85, hasExif: true,
    })
    const onChange = await render()
    expect(container.textContent).toContain('已识别')
    expect(container.textContent).toContain('Sony FE 85mm F1.8')
    const apply = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '套用配置') as HTMLButtonElement
    await act(async () => { apply.click() })
    expect(onChange).toHaveBeenCalledWith({
      ...ZERO, lensDistortion: 6, lensVignette: 24, lensChromatic: 5,
    })
    expect(container.textContent).toContain('已套用')
  })

  it('认不出镜头时仍能手动选一支并套用', async () => {
    vi.mocked(photoInfo.readLensInfo).mockResolvedValue({
      make: 'Mystery', model: 'X', lens: 'Unknown 135mm', focalMm: 135,
      focal35mm: 135, hasExif: true,
    })
    const onChange = await render()
    expect(container.textContent).toContain('未收录')
    const select = container.querySelector('select') as HTMLSelectElement
    await act(async () => {
      select.value = 'canon-rf-50-18'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('Canon RF 50mm F1.8 STM')
    expect(container.textContent).toContain('手动选择')
    const apply = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '套用配置') as HTMLButtonElement
    expect(apply.disabled).toBe(false)
    await act(async () => { apply.click() })
    expect(onChange).toHaveBeenCalledWith({
      ...ZERO, lensDistortion: 5, lensVignette: 26, lensChromatic: 4,
    })
  })

  it('没有原文件（恢复会话）时下拉仍可用，不报错', async () => {
    vi.mocked(photoInfo.readLensInfo).mockResolvedValue({
      make: null, model: null, lens: null, focalMm: null, focal35mm: null, hasExif: false,
    })
    await act(async () => {
      root.render(<LensProfilePicker file={null} value={ZERO} onChange={vi.fn()} />)
    })
    expect(container.textContent).toContain('手动选择')
    expect(container.querySelector('select')).toBeTruthy()
  })

  it('把当前三根存成「我的配置」，可再次套用和删除', async () => {
    vi.mocked(photoInfo.readLensInfo).mockResolvedValue({
      make: 'Mystery', model: 'X', lens: 'Unknown 135mm', focalMm: 135,
      focal35mm: 135, hasExif: true,
    })
    const value = { ...ZERO, lensDistortion: 12, lensVignette: -8, lensChromatic: 7 }
    const onChange = vi.fn()
    await act(async () => {
      root.render(<LensProfilePicker file={file} value={value} onChange={onChange} />)
      await Promise.resolve()
    })
    const input = container.querySelector('input[aria-label="自定义镜头配置名称"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '我的 135')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '存为我的配置') as HTMLButtonElement
    await act(async () => { save.click() })
    const select = container.querySelector('select') as HTMLSelectElement
    expect(select.value.startsWith('custom-')).toBe(true)
    expect(container.textContent).toContain('我的 135')
    expect(container.textContent).toContain('已保存在这台设备')

    const apply = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '套用配置') as HTMLButtonElement
    await act(async () => { apply.click() })
    expect(onChange).toHaveBeenCalledWith({
      ...value, lensDistortion: 12, lensVignette: -8, lensChromatic: 7,
    })

    const remove = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '删除这条') as HTMLButtonElement
    await act(async () => { remove.click() })
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('')
    expect(container.textContent).not.toContain('我的 135')
  })
})
