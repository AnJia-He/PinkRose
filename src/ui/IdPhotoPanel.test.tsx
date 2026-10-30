// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IdPhotoPanel from './IdPhotoPanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('IdPhotoPanel', () => {
  it('有四套标准尺寸、四种底色，没照片时不能下载', async () => {
    const onBack = vi.fn()
    await act(async () => { root.render(<IdPhotoPanel onBack={onBack} />) })

    expect(container.textContent).toContain('证件照')
    for (const label of ['一寸', '二寸', '小二寸', '签证']) {
      expect(container.textContent).toContain(label)
    }
    expect(container.querySelectorAll('.id-photo-swatch')).toHaveLength(4)
    const download = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('下载证件照')) as HTMLButtonElement
    expect(download.disabled).toBe(true)
    const sheet = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('排版 8 张')) as HTMLButtonElement
    expect(sheet.disabled).toBe(true)
    expect(container.querySelector('input[type="file"]')).toBeTruthy()

    const back = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('作品')) as HTMLButtonElement
    await act(async () => { back.click() })
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
