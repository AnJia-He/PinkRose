// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import type { Adjustments } from '../../shared/adjustments.ts'
import { serializePresets } from '../core/presetFile.ts'
import { PresetManager } from './PresetManager.tsx'

const { downloadMock } = vi.hoisted(() => ({ downloadMock: vi.fn() }))
vi.mock('../export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/save')>()
  return { ...actual, downloadFile: downloadMock }
})

const preset = (id: number, name: string) => ({
  id,
  name,
  params: { ...ZERO, exposure: 12 },
  createdAt: 0,
})

async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  return container
}

async function importFile(
  container: HTMLElement,
  text: string,
  name = 'presets.json',
  type = 'application/json',
) {
  const input = container.querySelector('.my-presets-file') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File([text], name, { type })],
  })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))
}

describe('我的预设导入 / 导出', () => {
  const onSave = vi.fn(async (_name: string, _params: Adjustments) => {})
  const noop = async () => {}

  beforeEach(() => {
    vi.clearAllMocks()
    onSave.mockResolvedValue(undefined)
  })

  it('导入通过的整套预设逐套交给保存回调', async () => {
    const c = await mount(
      <PresetManager presets={[]} known params={ZERO}
        onSave={onSave} onRename={noop} onDelete={noop} />,
    )
    const text = serializePresets([
      { name: '导入A', params: { ...ZERO, exposure: 10 } },
      { name: '导入B', params: { ...ZERO, temperature: -20 } },
    ])
    await act(async () => { await importFile(c, text) })
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onSave.mock.calls[0]![0]).toBe('导入A')
    expect(onSave.mock.calls[0]![1].exposure).toBe(10)
    expect(c.textContent).toContain('已导入 2 套')
  })

  it('和现有预设重名时整份拒绝，不保存任何一套', async () => {
    const c = await mount(
      <PresetManager presets={[preset(1, '旅行暖调')]} known params={ZERO}
        onSave={onSave} onRename={noop} onDelete={noop} />,
    )
    const text = serializePresets([{ name: '旅行暖调', params: { ...ZERO, exposure: 20 } }])
    await act(async () => { await importFile(c, text) })
    expect(onSave).not.toHaveBeenCalled()
    expect(c.textContent).toContain('已经有一套叫')
  })

  it('导入单套 Lightroom XMP，映射基础调色项', async () => {
    const c = await mount(
      <PresetManager presets={[]} known params={ZERO}
        onSave={onSave} onRename={noop} onDelete={noop} />,
    )
    const xmp = `<?xpacket?>
      <x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:RDF>
          <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
            crs:Exposure2012="1.5" crs:Contrast2012="12" crs:Dehaze="20" />
        </rdf:RDF>
      </x:xmpmeta>`
    await act(async () => {
      await importFile(c, xmp, 'portrait.xmp', 'application/rdf+xml')
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0]).toBe('portrait')
    expect(onSave.mock.calls[0]![1]).toMatchObject({
      exposure: 30,
      contrast: 12,
      dehaze: 20,
    })
    expect(c.textContent).toContain('已导入 1 套')
  })

  it('导出全部会下载一个 JSON 文件', async () => {
    const c = await mount(
      <PresetManager presets={[preset(1, 'A'), preset(2, 'B')]} known params={ZERO}
        onSave={onSave} onRename={noop} onDelete={noop} />,
    )
    const exportBtn = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.includes('导出全部')) as HTMLButtonElement
    await act(async () => { exportBtn.click() })
    expect(downloadMock).toHaveBeenCalledTimes(1)
    const [blob, filename] = downloadMock.mock.calls[0]!
    expect(blob.type).toBe('application/json')
    expect(filename).toMatch(/^PinkRose-presets-\d{8}-\d{4}\.json$/)
    expect(c.textContent).toContain('已导出 2 套')
  })

  it('当前调色可导出单套 XMP', async () => {
    const c = await mount(
      <PresetManager presets={[]} known params={{ ...ZERO, exposure: 10 }}
        onSave={onSave} onRename={noop} onDelete={noop} />,
    )
    const exportXmp = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.includes('导出当前 XMP')) as HTMLButtonElement
    expect(exportXmp).toBeTruthy()
    await act(async () => { exportXmp.click() })
    expect(downloadMock).toHaveBeenCalledTimes(1)
    const [blob, filename] = downloadMock.mock.calls[0]!
    expect(blob.type).toBe('application/rdf+xml')
    expect(filename).toMatch(/^PinkRose-look-\d{8}-\d{4}\.xmp$/)
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.readAsText(blob)
    })
    expect(text).toContain('pinkrose:exposure="10"')
  })

  it('清单没到手时不能导入；没有预设时不能导出', async () => {
    const c = await mount(
      <PresetManager presets={[]} known={false} params={ZERO}
        onSave={onSave} onRename={noop} onDelete={noop} />,
    )
    const importBtn = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.includes('导入预设')) as HTMLButtonElement
    const exportBtn = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.includes('导出全部')) as HTMLButtonElement
    expect(importBtn.disabled).toBe(true)
    expect(exportBtn.disabled).toBe(true)
  })
})
