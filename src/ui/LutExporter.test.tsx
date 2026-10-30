// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import * as lutExport from '../export/lutExport.ts'
import LutExporter from './LutExporter.tsx'

vi.mock('../export/lutExport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/lutExport.ts')>()
  return { ...actual, exportLookCube: vi.fn() }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true, value: vi.fn(() => 'blob:look'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true, value: vi.fn(),
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node)
    await Promise.resolve()
  })
}

describe('当前外观导出 LUT', () => {
  it('先异步生成，再把下载放到第二次点击（苹果端不抢用户手势）', async () => {
    vi.mocked(lutExport.exportLookCube).mockResolvedValue('cube-text')
    let downloaded = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download
    })
    await render(
      <LutExporter params={ZERO} cube={null} lutAmount={0} filenameStem="IMG_0001.JPG" />,
    )
    const generate = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '生成 .cube') as HTMLButtonElement
    await act(async () => {
      generate.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(vi.mocked(lutExport.exportLookCube)).toHaveBeenCalledTimes(1)
    const download = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '下载 .cube') as HTMLButtonElement
    expect(download).toBeTruthy()
    await act(async () => { download.click() })
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(downloaded).toBe('IMG_0001-look.cube')
  })

  it('参数变了，旧的 LUT 失效；生成失败时给出可照做的提示', async () => {
    vi.mocked(lutExport.exportLookCube).mockResolvedValue('cube-text')
    await render(
      <LutExporter params={ZERO} cube={null} lutAmount={0} filenameStem="a.jpg" />,
    )
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find(b => b.textContent?.trim() === '生成 .cube')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('下载 .cube')
    await render(
      <LutExporter params={{ ...ZERO, saturation: 40 }} cube={null} lutAmount={0} filenameStem="a.jpg" />,
    )
    expect(container.textContent).not.toContain('下载 .cube')

    vi.mocked(lutExport.exportLookCube).mockRejectedValueOnce(new Error('no webgl'))
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find(b => b.textContent?.trim() === '生成 .cube')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('换 Chrome / Safari')
  })
})
