// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BatchPanel from './BatchPanel.tsx'
import { ZERO } from '../../shared/adjustments.ts'
import { DEFAULT_WATERMARK, saveTextWatermark } from '../image/watermark.ts'
import { DEFAULT_BATCH_PREFS, saveBatchPrefs } from '../batch/prefs.ts'

const {
  processMock, downloadMock, analyzePhotoMock, decodeImageFileMock,
  createWorkMock, renameWorkMock, blobToDataUrlMock,
} = vi.hoisted(() => ({
  processMock: vi.fn(),
  downloadMock: vi.fn(),
  analyzePhotoMock: vi.fn(),
  decodeImageFileMock: vi.fn(),
  createWorkMock: vi.fn(),
  renameWorkMock: vi.fn(),
  blobToDataUrlMock: vi.fn(),
}))

vi.mock('../batch/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../batch/process')>()
  return { ...actual, processBatchFiles: processMock }
})
vi.mock('../export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/save')>()
  return { ...actual, downloadImage: downloadMock }
})
vi.mock('../image/cull', () => ({
  analyzePhoto: analyzePhotoMock,
}))
vi.mock('../image/decode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../image/decode')>()
  return { ...actual, decodeImageFile: decodeImageFileMock }
})
vi.mock('../api/works', () => ({
  createWork: createWorkMock,
  renameWork: renameWorkMock,
}))
vi.mock('../image/blob', () => ({
  blobToDataUrl: blobToDataUrlMock,
}))
vi.mock('../app/usePresets', () => ({
  usePresets: () => ({ presets: [], known: true, refresh: vi.fn() }),
}))
vi.mock('../app/useLuts', () => ({
  useLuts: () => ({
    luts: [{ id: 9, name: '黄昏 Lut', size: 2, bytes: 16, createdAt: 0 }],
    lutsKnown: true,
    cube: {
      size: 2,
      rgba: new Uint8Array(2 * 2 * 2 * 4),
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
      title: '黄昏 Lut',
    },
    thumbs: { none: null, byId: {} },
    ensureThumbs: vi.fn(),
    reload: vi.fn(),
  }),
}))

async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  return container
}

function choose(container: HTMLElement, names: string[]) {
  chooseFiles(
    container,
    names.map(name => new File(['x'], name, { type: 'image/jpeg' })),
  )
}

function chooseFiles(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: files,
  })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

async function setBatchSlider(container: HTMLElement, label: string, value: number) {
  const row = [...container.querySelectorAll('label.slider')]
    .find(el => el.querySelector('.slider-label')?.textContent === label) as HTMLElement
  expect(row, `滑块「${label}」应该在`).toBeTruthy()
  await act(async () => {
    ;(row.querySelector('.slider-value') as HTMLElement).click()
    await new Promise(r => setTimeout(r, 0))
  })
  const input = row.querySelector('input.slider-edit') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

describe('批量处理工作区', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    decodeImageFileMock.mockResolvedValue({
      bitmap: { close: vi.fn(), width: 800, height: 600 },
      width: 800,
      height: 600,
    })
    blobToDataUrlMock.mockResolvedValue('data:image/jpeg;base64,full')
    createWorkMock.mockResolvedValue({ id: 9 })
    renameWorkMock.mockResolvedValue({
      id: 9, alias: 'a_pinkrose.jpg', createdAt: 0, updatedAt: 0,
      bytes: 1, hasThumb: true, rating: 0, flag: 0,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('从文件夹带入 RAW + JPG 时只列一张 RAW，并提示已合并', async () => {
    const jpeg = new File(['jpg'], 'IMG_0001.JPG', { type: 'image/jpeg' })
    const raw = new File(['raw'], 'IMG_0001.CR3', { type: '' })
    Object.defineProperty(jpeg, 'webkitRelativePath', { value: 'trip/IMG_0001.JPG' })
    Object.defineProperty(raw, 'webkitRelativePath', { value: 'trip/IMG_0001.CR3' })
    const c = await mount(<BatchPanel
      onBack={() => {}}
      initialFiles={[jpeg, raw]}
    />)

    expect(c.textContent).toContain('IMG_0001.CR3')
    expect(c.textContent).not.toContain('IMG_0001.JPG')
    expect(c.textContent).toContain('保留 RAW 原始数据')
  })

  it('批量页恢复上次保存的文字水印', async () => {
    saveTextWatermark({
      ...DEFAULT_WATERMARK,
      text: 'Studio Mark',
      font: 'serif',
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    const text = c.querySelector('input[aria-label="水印文字"]') as HTMLInputElement
    const font = c.querySelector('select[aria-label="水印字体"]') as HTMLSelectElement
    expect(text.value).toBe('Studio Mark')
    expect(font.value).toBe('serif')
  })

  it('恢复上次的批量画幅 / 方向 / 自动校正 / 命名，并可一键恢复默认', async () => {
    saveBatchPrefs({
      ...DEFAULT_BATCH_PREFS,
      aspect: '4:5',
      orientation: 'left',
      autoEnhance: true,
      autoLens: true,
      smartCrop: true,
      nameMode: 'date',
      namePrefix: 'Trip',
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    const presetLabel = (text: string) => [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.querySelector('span')?.textContent === text)!
    expect((presetLabel('画幅').querySelector('select') as HTMLSelectElement).value).toBe('4:5')
    expect((presetLabel('方向').querySelector('select') as HTMLSelectElement).value).toBe('left')
    expect((presetLabel('命名').querySelector('select') as HTMLSelectElement).value).toBe('date')
    expect((c.querySelector('input[aria-label="文件名前缀"]') as HTMLInputElement).value).toBe('Trip')
    const toggle = (text: string) => [...c.querySelectorAll('label.batch-toggle')]
      .find(label => label.textContent?.includes(text))!.querySelector('input') as HTMLInputElement
    expect(toggle('每张自动增强').checked).toBe(true)
    expect(toggle('按 EXIF 自动镜头校正').checked).toBe(true)
    expect(toggle('智能主体构图').checked).toBe(true)

    const reset = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '恢复默认')!
    await act(async () => { reset.click() })
    expect((presetLabel('画幅').querySelector('select') as HTMLSelectElement).value).toBe('original')
    expect((presetLabel('方向').querySelector('select') as HTMLSelectElement).value).toBe('original')
    expect((presetLabel('命名').querySelector('select') as HTMLSelectElement).value).toBe('source')
  })

  it('没选照片时不能开始；选完之后才亮', async () => {
    const c = await mount(<BatchPanel onBack={() => {}} />)
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    expect(run.disabled).toBe(true)
    expect((c.querySelector('input.batch-file-input') as HTMLInputElement).accept)
      .toContain('.cr3')
    await act(async () => { choose(c, ['a.jpg']) })
    expect(run.disabled).toBe(false)
    expect(c.textContent).toContain('a.jpg')
  })

  it('默认风格作为批量的初始预设（相机桥「导入全部」也按它起手）', async () => {
    const c = await mount(<BatchPanel onBack={() => {}} initialPresetId="film" />)
    const style = [...c.querySelectorAll('label.batch-preset')]
      .find(el => el.querySelector('span')?.textContent === '风格') as HTMLElement
    const select = style.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('film')
    expect([...c.querySelectorAll('.slider-label')]
      .some(el => el.textContent === '胶片强度')).toBe(true)
  })

  it('批量页也能一键套社交平台尺寸', async () => {
    const c = await mount(<BatchPanel onBack={() => {}} />)
    const xhs = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '小红书') as HTMLButtonElement
    expect(xhs).toBeTruthy()
    await act(async () => { xhs.click() })

    const aspect = [...c.querySelectorAll('label.batch-preset')]
      .find(el => el.querySelector('span')?.textContent === '画幅')
      ?.querySelector('select') as HTMLSelectElement
    expect(aspect.value).toBe('3:4')
    expect((c.querySelector('input[name="export-size"][value="1080"]') as HTMLInputElement).checked)
      .toBe(true)
    expect((c.querySelector('input[name="export-format"][value="image/jpeg"]') as HTMLInputElement).checked)
      .toBe(true)
    expect((c.querySelector('input[name="export-quality"]') as HTMLInputElement).value).toBe('92')
  })

  it('服务端有 HEIC 编码器时，批量导出也能选择 HEIC', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/convert/heic/capability')) {
        return Response.json({ available: true, encoder: 'sips' })
      }
      return Response.json({})
    }))
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(c.querySelector(
      'input[name="export-format"][value="image/heic"]')).toBeTruthy()
  })

  it('批量导出选择的 Display P3 会进入处理选项', async () => {
    processMock.mockResolvedValue({
      archive: null,
      archiveName: '',
      successes: [],
      failures: [],
      portraitSkipped: 0,
      smartCropFallbacks: 0,
      upscaleSkipped: 0,
      cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const p3 = c.querySelector(
      'input[name="export-color-space"][value="display-p3"]',
    ) as HTMLInputElement
    expect(p3).toBeTruthy()
    await act(async () => { p3.click() })
    const run = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('开始处理')) as HTMLButtonElement
    await act(async () => {
      run.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(processMock.mock.calls[0]![2]).toMatchObject({ colorSpace: 'display-p3' })
  })

  it('处理成功和失败都如实显示，并能下载 ZIP', async () => {
    processMock.mockImplementation(async (_files, _adj, _opts, onProgress) => {
      onProgress({ completed: 1, total: 2, currentName: 'b.jpg' })
      return {
        archive: new Blob(['zip'], { type: 'application/zip' }),
        archiveName: 'PinkRose-batch-20261017-1800.zip',
        successes: [
          {
            id: '1', sourceName: 'a.jpg', filename: 'a_pinkrose.jpg',
            bytes: 2048, width: 1200, height: 800,
            preview: 'data:image/jpeg;base64,thumb',
          },
        ],
        failures: [{ id: '2', sourceName: 'b.jpg', message: '这张图打不开' }],
        lensMatched: 1,
        lensSkipped: 1,
        cancelled: false,
      }
    })

    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg', 'b.jpg']) })
    const watermark = c.querySelector('input[aria-label="水印文字"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(watermark, 'PinkRose')
      watermark.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const tile = c.querySelector('input[name="batch-watermark-tile"][value="tile"]') as HTMLInputElement
    await act(async () => { tile.click() })
    const aspectLabel = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('画幅'))!
    const aspect = aspectLabel.querySelector('select') as HTMLSelectElement
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      selectSetter.call(aspect, '4:5')
      aspect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const auto = [...c.querySelectorAll('label.batch-toggle')]
      .find(label => label.textContent?.includes('每张自动增强'))!
      .querySelector('input') as HTMLInputElement
    await act(async () => { auto.click() })
    const autoLens = [...c.querySelectorAll('label.batch-toggle')]
      .find(label => label.textContent?.includes('按 EXIF 自动镜头校正'))!
      .querySelector('input') as HTMLInputElement
    await act(async () => { autoLens.click() })
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })

    expect(processMock).toHaveBeenCalledTimes(1)
    expect(processMock.mock.calls[0]![5]).toMatchObject({ text: 'PinkRose', tile: true })
    expect(processMock.mock.calls[0]![7]).toMatchObject({
      aspect: '4:5', autoEnhance: true, autoLens: true,
    })
    expect(c.textContent).toContain('成功 1 张，失败 1 张')
    expect(c.textContent).toContain('按 EXIF 套用镜头配置 1 张')
    expect(c.textContent).toContain('1 张没认出镜头、保留原校正值')
    expect(c.textContent).toContain('a_pinkrose.jpg')
    expect(c.textContent).toContain('这张图打不开')
    expect(c.querySelector('.batch-done-thumb')).toBeTruthy()
    const download = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('下载 ZIP'))!
    await act(async () => { download.click() })
    expect(downloadMock).toHaveBeenCalledWith(
      expect.any(Blob),
      'PinkRose-batch-20261017-1800.zip',
    )
  })

  it('文件分享可用的设备可分享 ZIP；取消不下载，真失败才退回下载', async () => {
    const share = vi.fn(async (_data: { files?: File[] }) => {})
    const canShare = vi.fn((_data: { files?: File[] }) => true)
    vi.stubGlobal('navigator', { share, canShare })
    processMock.mockResolvedValue({
      archive: new Blob(['zip'], { type: 'application/zip' }),
      archiveName: 'PinkRose-batch-20261017-1800.zip',
      successes: [{
        id: '1', sourceName: 'a.jpg', filename: 'a_pinkrose.jpg',
        bytes: 2048, width: 1200, height: 800,
      }],
      failures: [],
      portraitSkipped: 0,
      cancelled: false,
    })

    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const run = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })

    const shareButton = [...c.querySelectorAll('button')]
      .find(button => button.textContent?.includes('分享 ZIP')) as HTMLButtonElement
    expect(shareButton).toBeTruthy()
    await act(async () => {
      shareButton.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(share.mock.calls[0]![0].files?.[0]).toMatchObject({
      name: 'PinkRose-batch-20261017-1800.zip',
      type: 'application/zip',
    })
    expect(downloadMock).not.toHaveBeenCalled()
    expect(c.textContent).toContain('批量成片 ZIP 已分享')

    share.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'))
    await act(async () => {
      shareButton.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(downloadMock).not.toHaveBeenCalled()

    share.mockRejectedValueOnce(new Error('NotAllowedError'))
    await act(async () => {
      shareButton.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(downloadMock).toHaveBeenCalledWith(
      expect.any(Blob),
      'PinkRose-batch-20261017-1800.zip',
    )
    expect(c.textContent).toContain('系统分享没成功，已改为下载批量成片 ZIP')
  })

  it('批量成片可以直接存进作品，文件名写回作品别名', async () => {
    processMock.mockResolvedValue({
      archive: null,
      archiveName: 'x.zip',
      successes: [{
        id: '1', sourceName: 'a.jpg', filename: 'a_pinkrose.jpg',
        capturedAt: new Date(2026, 9, 21, 8, 15, 30).getTime(),
        cameraMake: 'SONY', cameraModel: 'ILCE-7CM2', lensModel: 'FE 50mm F1.4 GM',
        bytes: 2048, width: 1200, height: 800,
        blob: new Blob(['output'], { type: 'image/jpeg' }),
        preview: 'data:image/jpeg;base64,thumb',
      }],
      failures: [],
      cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    const save = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.includes('存进作品')) as HTMLButtonElement
    expect(save).toBeTruthy()
    const single = c.querySelector('.batch-done-download') as HTMLButtonElement
    await act(async () => { single.click() })
    expect(downloadMock).toHaveBeenCalledWith(expect.any(Blob), 'a_pinkrose.jpg')
    await act(async () => {
      save.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(blobToDataUrlMock).toHaveBeenCalled()
    expect(createWorkMock).toHaveBeenCalledWith({
      image: 'data:image/jpeg;base64,full',
      thumb: 'data:image/jpeg;base64,thumb',
      sourceName: 'a.jpg',
      capturedAt: new Date(2026, 9, 21, 8, 15, 30).getTime(),
      cameraMake: 'SONY',
      cameraModel: 'ILCE-7CM2',
      lensModel: 'FE 50mm F1.4 GM',
    })
    expect(renameWorkMock).toHaveBeenCalledWith(9, 'a_pinkrose.jpg')
    expect(c.textContent).toContain('已存进作品 1 张')
  })

  it('HEIC 批量成片存进作品时使用独立 JPEG 母版', async () => {
    const heic = new Blob(['heic'], { type: 'image/heic' })
    const work = new Blob(['jpeg'], { type: 'image/jpeg' })
    processMock.mockResolvedValue({
      archive: null,
      archiveName: 'x.zip',
      successes: [{
        id: '1', sourceName: 'a.jpg', filename: 'a_pinkrose.heic',
        bytes: 4, width: 1200, height: 800,
        blob: heic,
        workBlob: work,
        preview: 'data:image/jpeg;base64,thumb',
      }],
      failures: [],
      cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    const save = [...c.querySelectorAll('button')]
      .find(b => b.textContent?.includes('存进作品')) as HTMLButtonElement
    await act(async () => {
      save.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(blobToDataUrlMock).toHaveBeenCalledWith(work)
    expect(createWorkMock).toHaveBeenCalledWith({
      image: 'data:image/jpeg;base64,full',
      thumb: 'data:image/jpeg;base64,thumb',
      sourceName: 'a.jpg',
    })
  })

  it('一张都没成功时明确说没有可下载的结果', async () => {
    processMock.mockResolvedValue({
      archive: null,
      archiveName: 'x.zip',
      successes: [],
      failures: [{ id: '1', sourceName: 'a.jpg', message: '打不开' }],
      cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(c.textContent).toContain('一张都没处理成')
    expect(c.textContent).not.toContain('下载 ZIP')
  })

  it('★ 可以把编辑器里正在用的那套调色原样套到整批照片', async () => {
    processMock.mockResolvedValue({
      archive: null, archiveName: 'x.zip', successes: [], failures: [], cancelled: false,
    })
    const current = { ...ZERO, exposure: 37, contrast: 12, temperature: -8, skinSmooth: 24 }
    const c = await mount(<BatchPanel onBack={() => {}} currentParams={current} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const styleLabel = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('风格'))!
    const style = styleLabel.querySelector('select') as HTMLSelectElement
    expect([...style.options].some(o => o.textContent === '当前调色')).toBe(true)
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(style, '__current__')
      style.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![1]).toEqual(current)
  })

  it('★ 批量预设强度：按比例混合整批参数，再交给处理器', async () => {
    processMock.mockResolvedValue({
      archive: null, archiveName: 'x.zip', successes: [], failures: [], cancelled: false,
    })
    const current = { ...ZERO, exposure: 40, contrast: -20, temperature: 30 }
    const c = await mount(<BatchPanel onBack={() => {}} currentParams={current} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const styleLabel = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('风格'))!
    const style = styleLabel.querySelector('select') as HTMLSelectElement
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      selectSetter.call(style, '__current__')
      style.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const strength = [...c.querySelectorAll('label.slider')]
      .find(label => label.textContent?.includes('当前调色强度')) as HTMLElement
    expect(strength).toBeTruthy()
    await act(async () => {
      ;(strength.querySelector('.slider-value') as HTMLElement).click()
      await new Promise(r => setTimeout(r, 0))
    })
    const edit = strength.querySelector('input.slider-edit') as HTMLInputElement
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      inputSetter.call(edit, '50')
      edit.dispatchEvent(new Event('input', { bubbles: true }))
      edit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![1]).toMatchObject({
      exposure: 20, contrast: -10, temperature: 15,
    })
  })

  it('★ 批量可叠加 Lut：选中的 cube 和强度一起交给处理器', async () => {
    processMock.mockResolvedValue({
      archive: null, archiveName: 'x.zip', successes: [], failures: [], cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const lutLabel = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('Lut'))!
    const select = lutLabel.querySelector('select') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(select, '9')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![7]).toMatchObject({
      lut: { amount: 100, cube: { size: 2, title: '黄昏 Lut' } },
    })
  })

  it('★ 整批方向：左转 90° 交给处理器', async () => {
    processMock.mockResolvedValue({
      archive: null, archiveName: 'x.zip', successes: [], failures: [], cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const direction = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('方向'))!
    const select = direction.querySelector('select') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(select, 'left')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![7]).toMatchObject({
      rotateTurns: 1, flipH: false, flipV: false,
    })
  })

  it('没有正在编辑的照片时不摆「当前调色」这个空选项', async () => {
    const c = await mount(<BatchPanel onBack={() => {}} />)
    const styleLabel = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('风格'))!
    const style = styleLabel.querySelector('select') as HTMLSelectElement
    expect([...style.options].some(o => o.textContent === '当前调色')).toBe(false)
  })

  it('★ 按前缀 + 序号重命名：控件值原样交给批处理', async () => {
    processMock.mockResolvedValue({
      archive: null, archiveName: 'x.zip', successes: [], failures: [], cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const naming = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('命名'))!
    const mode = naming.querySelector('select') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(mode, 'sequence')
      mode.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const prefix = c.querySelector('input[aria-label="文件名前缀"]') as HTMLInputElement
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      inputSetter.call(prefix, 'Trip')
      prefix.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![7]).toMatchObject({
      rename: { mode: 'sequence', prefix: 'Trip' },
    })
  })

  it('可选择按拍摄日期 + 序号命名，并把模式交给批处理', async () => {
    processMock.mockResolvedValue({
      archive: null, archiveName: 'x.zip', successes: [], failures: [], cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const naming = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('命名'))!
    const mode = naming.querySelector('select') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(mode, 'date')
      mode.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const prefix = c.querySelector('input[aria-label="文件名前缀"]') as HTMLInputElement
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      inputSetter.call(prefix, 'Trip')
      prefix.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(c.textContent).toContain('没有 EXIF 日期时用文件修改日期')
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![7]).toMatchObject({
      rename: { mode: 'date', prefix: 'Trip' },
    })
  })

  it('★ 智能挑图：本地分析后给保留 / 复查建议，不自动删文件', async () => {
    analyzePhotoMock
      .mockResolvedValueOnce({ sharpness: 900, exposure: 0.9, clipping: 0, meanLuma: 0.5 })
      .mockResolvedValueOnce({ sharpness: 10, exposure: 0.9, clipping: 0, meanLuma: 0.5 })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['sharp.jpg', 'soft.jpg']) })
    const button = [...c.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('智能挑图'))!
    expect(button.disabled).toBe(false)
    await act(async () => {
      button.click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(analyzePhotoMock).toHaveBeenCalledTimes(2)
    expect(c.textContent).toContain('1 张推荐保留')
    expect(c.textContent).toContain('保留')
    expect(c.textContent).toContain('复查')
    expect(c.textContent).toContain('不会自动删照片')
    expect(c.querySelectorAll('.batch-file-row')).toHaveLength(2)
    expect(processMock).not.toHaveBeenCalled()
  })

  it('★ 批量透明背景：选项交给处理器，并明确说明会导出 PNG', async () => {
    processMock.mockResolvedValue({
      archive: null, archiveName: 'x.zip', successes: [], failures: [], cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const backgroundLabel = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('背景'))!
    const background = backgroundLabel.querySelector('select') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(background, 'transparent')
      background.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(c.textContent).toContain('透明背景固定导出 PNG')
    expect(c.textContent).toContain('没认出主体的那张会单独跳过')
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![7]).toMatchObject({
      background: { kind: 'transparent' },
    })
  })

  it('★ 批量自定义背景色：颜色控件原样交给处理器', async () => {
    processMock.mockResolvedValue({
      archive: null, archiveName: 'x.zip', successes: [], failures: [], cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const backgroundLabel = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('背景'))!
    const background = backgroundLabel.querySelector('select') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(background, 'color')
      background.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const color = c.querySelector('input[aria-label="批量背景颜色"]') as HTMLInputElement
    expect(color).toBeTruthy()
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      inputSetter.call(color, '#123456')
      color.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![7]).toMatchObject({
      background: { kind: 'color', color: '#123456' },
    })
  })

  it('★ 批量自定义背景图：只选一次，整批共用同一个位图', async () => {
    processMock.mockResolvedValue({
      archive: null, archiveName: 'x.zip', successes: [], failures: [], cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const backgroundLabel = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('背景'))!
    const background = backgroundLabel.querySelector('select') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(background, 'image')
      background.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const fileInput = c.querySelector('input[aria-label="选择批量背景图"]') as HTMLInputElement
    const file = new File(['x'], 'studio.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [file],
    })
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(decodeImageFileMock).toHaveBeenCalledWith(file)
    expect(c.textContent).toContain('studio.png')

    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![7]).toMatchObject({
      background: {
        kind: 'image',
        name: 'studio.png',
        bitmap: expect.objectContaining({ width: 800, height: 600 }),
      },
    })
  })

  it('★ 批量人像精修：磨皮 / 补光 / 肤色 / 去斑原样交给处理器，并显示没找到人脸的张数', async () => {
    processMock.mockResolvedValue({
      archive: null,
      archiveName: 'x.zip',
      successes: [
        {
          id: '1', sourceName: 'a.jpg', filename: 'a_pinkrose.jpg',
          bytes: 1024, width: 1200, height: 800,
        },
      ],
      failures: [],
      portraitSkipped: 2,
      portraitFaces: 4,
      cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    await setBatchSlider(c, '磨皮', 30)
    await setBatchSlider(c, '面部补光', 20)
    await setBatchSlider(c, '美白', 18)
    await setBatchSlider(c, '红润', 12)
    await setBatchSlider(c, '瘦脸', 15)
    await setBatchSlider(c, '瘦颈', 25)
    await setBatchSlider(c, '双下巴', 35)
    await setBatchSlider(c, '直角肩', 45)
    await setBatchSlider(c, '微笑', 20)
    const blemish = [...c.querySelectorAll('label.batch-toggle')]
      .find(label => label.textContent?.includes('自动去斑'))!
      .querySelector('input') as HTMLInputElement
    await act(async () => { blemish.click() })
    const multi = [...c.querySelectorAll('label.batch-toggle')]
      .find(label => label.textContent?.includes('合影多人脸'))!
      .querySelector('input') as HTMLInputElement
    await act(async () => { multi.click() })

    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![7]).toMatchObject({
      portrait: {
        multiFace: true,
        smooth: 30, light: 20, whiten: 18, rosy: 12, blemish: true,
        slim: 15, neck: 25, doubleChin: 35, shoulder: 45, smile: 20,
      },
    })
    expect(c.textContent).toContain('其中 2 张没找到人脸，已保留原样')
    expect(c.textContent).toContain('共处理了 4 张脸')
  })

  it('★ 批量双色调：开关、预设和强度原样交给处理器', async () => {
    processMock.mockResolvedValue({
      archive: null,
      archiveName: 'x.zip',
      successes: [
        {
          id: '1', sourceName: 'a.jpg', filename: 'a_pinkrose.jpg',
          bytes: 1024, width: 1200, height: 800,
        },
      ],
      failures: [],
      portraitSkipped: 0,
      smartCropFallbacks: 0,
      upscaleSkipped: 0,
      cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const toggle = c.querySelector('input[name="batch-duotone"]') as HTMLInputElement
    await act(async () => { toggle.click() })
    const preset = [...c.querySelectorAll('button.batch-chip')]
      .find(button => button.textContent?.trim() === '紫夜') as HTMLButtonElement
    await act(async () => { preset.click() })
    await setBatchSlider(c, '双色调强度', 80)

    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![7]).toMatchObject({
      duotone: {
        preset: 'violet',
        shadow: '#160b2e',
        highlight: '#f0c8ff',
        intensity: 80,
      },
    })
  })

  it('★ 批量智能构图：只在选了非原图比例时交给处理器，并显示退回居中的张数', async () => {
    processMock.mockResolvedValue({
      archive: null,
      archiveName: 'x.zip',
      successes: [
        {
          id: '1', sourceName: 'a.jpg', filename: 'a_pinkrose.jpg',
          bytes: 1024, width: 800, height: 800,
        },
      ],
      failures: [],
      portraitSkipped: 0,
      smartCropFallbacks: 2,
      cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const aspectLabel = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('画幅'))!
    const aspect = aspectLabel.querySelector('select') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(aspect, '4:5')
      aspect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const smart = [...c.querySelectorAll('label.batch-toggle')]
      .find(label => label.textContent?.includes('智能主体构图'))!
      .querySelector('input') as HTMLInputElement
    await act(async () => { smart.click() })

    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![7]).toMatchObject({
      aspect: '4:5', smartCrop: true,
    })
    expect(c.textContent).toContain('其中 2 张没认出主体，已居中裁切')
  })

  it('★ 逐张取景入口：只有选了统一画幅才出现，原图比例不打扰用户', async () => {
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg', 'b.jpg']) })
    expect(c.querySelectorAll('.batch-frame')).toHaveLength(0)

    const aspectLabel = [...c.querySelectorAll('label.batch-preset')]
      .find(label => label.textContent?.includes('画幅'))!
    const aspect = aspectLabel.querySelector('select') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(aspect, '1:1')
      aspect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const frames = [...c.querySelectorAll('.batch-frame')] as HTMLButtonElement[]
    expect(frames).toHaveLength(2)
    expect(frames.map(b => b.textContent)).toEqual(['取景', '取景'])
    expect(c.textContent).toContain('在照片列表里逐张点「取景」')
  })

  it('★ 批量超清放大：开关交给处理器，并显示保留原尺寸的张数', async () => {
    processMock.mockResolvedValue({
      archive: null,
      archiveName: 'x.zip',
      successes: [
        {
          id: '1', sourceName: 'a.jpg', filename: 'a_pinkrose.jpg',
          bytes: 1024, width: 2400, height: 1600,
        },
      ],
      failures: [],
      portraitSkipped: 0,
      smartCropFallbacks: 0,
      upscaleSkipped: 2,
      cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const upscale = [...c.querySelectorAll('label.batch-toggle')]
      .find(label => label.textContent?.includes('超清放大'))!
      .querySelector('input') as HTMLInputElement
    await act(async () => { upscale.click() })
    const four = [...c.querySelectorAll('button.batch-chip')]
      .find(button => button.textContent?.trim() === '4×') as HTMLButtonElement
    await act(async () => { four.click() })

    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![7]).toMatchObject({ upscale: true, upscaleFactor: 4 })
    expect(c.textContent).toContain('其中 2 张没有放大，已保留原尺寸')
  })

  it('★ 批量附带 XMP：开关交给处理器', async () => {
    processMock.mockResolvedValue({
      archive: null,
      archiveName: 'x.zip',
      successes: [],
      failures: [],
      portraitSkipped: 0,
      smartCropFallbacks: 0,
      upscaleSkipped: 0,
      cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    await act(async () => { choose(c, ['a.jpg']) })
    const xmp = [...c.querySelectorAll('label.batch-toggle')]
      .find(label => label.textContent?.includes('附带 XMP 调色配方'))!
      .querySelector('input') as HTMLInputElement
    await act(async () => { xmp.click() })
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![7]).toMatchObject({ includeXmp: true })
  })

  it('★ 多张照片匹配各自 XMP：旁车随对应照片交给处理器', async () => {
    processMock.mockResolvedValue({
      archive: null,
      archiveName: 'x.zip',
      successes: [],
      failures: [],
      portraitSkipped: 0,
      smartCropFallbacks: 0,
      upscaleSkipped: 0,
      cancelled: false,
    })
    const c = await mount(<BatchPanel onBack={() => {}} />)
    const a = new File(['a'], 'a.jpg', { type: 'image/jpeg' })
    const b = new File(['b'], 'b.jpg', { type: 'image/jpeg' })
    const ax = new File(['ax'], 'a.xmp', { type: 'application/rdf+xml' })
    const bx = new File(['bx'], 'b.xmp', { type: 'application/rdf+xml' })
    await act(async () => { chooseFiles(c, [a, ax, b, bx]) })

    expect(c.textContent).toContain('已匹配 2 份同名 XMP')
    expect(c.textContent).not.toContain('a.xmp')
    const run = [...c.querySelectorAll('button')].find(b => b.textContent?.includes('开始处理'))!
    await act(async () => { run.click() })
    expect(processMock.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ file: a, sidecar: ax }),
      expect.objectContaining({ file: b, sidecar: bx }),
    ])
  })
})
