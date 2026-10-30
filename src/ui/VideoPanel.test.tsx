// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PRESETS } from '../core/presets.ts'
import VideoPanel from './VideoPanel'

const { exportMock, downloadMock, createWorkMock, renameWorkMock, probeMock } = vi.hoisted(() => ({
  exportMock: vi.fn(),
  downloadMock: vi.fn(),
  createWorkMock: vi.fn(),
  renameWorkMock: vi.fn(),
  probeMock: vi.fn(),
}))

vi.mock('../video/export', () => ({ exportVideo: exportMock }))
vi.mock('../api/works', () => ({ createWork: createWorkMock, renameWork: renameWorkMock }))
vi.mock('../video/probe.ts', () => ({ probeVideoFile: probeMock }))
// jsdom 没有 canvas 2D：截帧那一条只验"接线"，画面本身由真实浏览器探针覆盖。
vi.mock('../core/canvas.ts', () => ({
  makeCanvas: (width: number, height: number) => ({ canvas: { width, height }, ctx: {} }),
}))
vi.mock('../core/thumbnail.ts', () => ({
  bitmapToDataUrl: () => 'data:image/jpeg;base64,FRAME',
  makeThumbnail: () => 'data:image/jpeg;base64,THUMB',
}))
vi.mock('../video/frames.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../video/frames')>()
  return { ...actual, drawVideoCover: vi.fn() }
})
vi.mock('../render/pipeline', () => ({
  TonePipeline: class {
    setLut() {}
    setImage() {}
    resizeToImage() {}
    render() {}
    dispose() {}
  },
}))
vi.mock('../export/save', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/save')>()
  return { ...actual, downloadImage: downloadMock }
})

async function mount(props: { initialFiles?: File[]; onSeedUsed?: () => void } = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(<VideoPanel onBack={() => {}} {...props} />)
  })
  return container
}

async function pick(container: HTMLElement, names: string[] = ['clip.mp4']) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: names.map(name => new File(['x'], name, { type: 'video/mp4' })),
  })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const button = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(text)) as HTMLButtonElement

describe('短片调色', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true, value: vi.fn(() => `blob:${Math.random()}`),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true, value: vi.fn(),
    })
    exportMock.mockResolvedValue(new Blob(['mp4'], { type: 'video/mp4' }))
    createWorkMock.mockResolvedValue({ id: 9 })
    renameWorkMock.mockResolvedValue({})
    probeMock.mockResolvedValue({ width: 1920, height: 1080, durationMs: 2000 })
    // jsdom 的 HTMLMediaElement.load 只会打一条 "Not implemented"；
    // 导出收尾会把预览切回当前段，这里换成空实现，别让日志盖住真正的失败。
    Object.defineProperty(HTMLMediaElement.prototype, 'load', {
      configurable: true, value: vi.fn(),
    })
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true, value: vi.fn(async () => ({ close: vi.fn() })),
    })
  })

  it('不是视频 → 当场说清楚；是视频 → 读出时长、尺寸和默认可导出的状态', async () => {
    const c = await mount()
    const input = c.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['x'], 'note.txt', { type: 'text/plain' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('不是视频')

    await pick(c)
    expect(c.textContent).toContain('0:02.0')
    expect(c.textContent).toContain('1280 × 720')
    expect(button(c, '导出 MP4').disabled).toBe(false)
  })

  it('多段：两段各 2 秒，列表两行、全片 4 秒', async () => {
    const c = await mount()
    await pick(c, ['a.mp4', 'b.mp4'])
    expect(c.querySelectorAll('.video-clip')).toHaveLength(2)
    expect(c.textContent).toContain('0:04.0')
    expect(button(c, '导出 MP4').disabled).toBe(false)
  })

  it('超过 20 秒的源片：默认先取前 20 秒，可以再拖', async () => {
    probeMock.mockResolvedValueOnce({ width: 1080, height: 1920, durationMs: 45_000 })
    const c = await mount()
    await pick(c, ['long.mp4'])
    expect(c.textContent).toContain('0:20.0')
    expect(button(c, '导出 MP4').disabled).toBe(false)
  })

  it('预设 + 强度 + 两段顺序原样交给导出，进度和成片都显示', async () => {
    const c = await mount()
    await pick(c, ['a.mp4', 'b.mp4'])
    const preset = PRESETS[0]!
    const chip = [...c.querySelectorAll('.video-presets button')]
      .find(b => b.textContent === preset.label) as HTMLButtonElement
    await act(async () => { chip.click() })

    exportMock.mockImplementationOnce(async (opts: {
      onProgress?: (done: number, total: number, stage: 'render' | 'upload' | 'encode') => void
    }) => {
      opts.onProgress?.(96, 96, 'encode')
      return new Blob(['mp4'], { type: 'video/mp4' })
    })
    await act(async () => { button(c, '导出 MP4').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    const opts = exportMock.mock.calls[0]![0]
    expect(opts.clips).toHaveLength(2)
    expect(opts.clips[0]).toMatchObject({ startMs: 0, endMs: 2000 })
    expect(opts.clips[1]).toMatchObject({ startMs: 0, endMs: 2000 })
    expect(opts.fps).toBe(24)
    expect(opts.aspect).toBe('source')
    expect(opts.keepAudio).toBe(true)
    expect(opts.adjustments.contrast).toBe(preset.adjustments.contrast)
    expect(button(c, '下载成片').disabled).toBe(false)
  })

  it('9:16 + 关掉原声：尺寸和开关原样交给导出', async () => {
    const c = await mount()
    await pick(c)
    await act(async () => {
      ([...c.querySelectorAll('button')].find(b => b.textContent === '9:16') as HTMLButtonElement).click()
    })
    await act(async () => {
      (c.querySelector('.batch-toggle input') as HTMLInputElement).click()
    })
    // 1920×1080 裁成 9:16：从原片里取 608×1080（不放大）
    expect(c.textContent).toContain('608 × 1080')
    await act(async () => { button(c, '导出 MP4').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const opts = exportMock.mock.calls[0]![0]
    expect(opts.aspect).toBe('9:16')
    expect(opts.keepAudio).toBe(false)
  })

  it('导出中可以取消，取消后不留成片', async () => {
    const c = await mount()
    await pick(c)
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

  it('截一帧存作品：把当前画面和缩略图交给 createWork', async () => {
    const c = await mount()
    await pick(c)
    await act(async () => { button(c, '截一帧存作品').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(createWorkMock).toHaveBeenCalledTimes(1)
    const input = createWorkMock.mock.calls[0]![0]
    expect(input.image).toMatch(/^data:image\/jpeg;base64,/)
    expect(input.thumb).toMatch(/^data:image\/jpeg;base64,/)
    expect(input.sourceName).toBe('clip.mp4')
    expect(renameWorkMock).toHaveBeenCalledWith(9, 'clip-帧.jpg')
    expect(c.textContent).toContain('已经存进作品')
  })

  it('背景音乐：选歌、替换模式、音量原样交给导出', async () => {
    const c = await mount()
    await pick(c)
    const musicInput = c.querySelector('input[aria-label="选择背景音乐"]') as HTMLInputElement
    Object.defineProperty(musicInput, 'files', {
      configurable: true,
      value: [new File(['x'], 'song.mp3', { type: 'audio/mpeg' })],
    })
    await act(async () => {
      musicInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(c.textContent).toContain('song.mp3')

    await act(async () => {
      ([...c.querySelectorAll('button')].find(b => b.textContent === '替换原声') as HTMLButtonElement).click()
    })
    await act(async () => {
      const range = c.querySelector('input[aria-label="音乐音量"]') as HTMLInputElement
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(range, '30')
      range.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { button(c, '导出 MP4').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    const opts = exportMock.mock.calls[0]![0]
    expect(opts.music.mode).toBe('replace')
    expect(opts.music.volume).toBe(30)
    expect(opts.keepAudio).toBe(false)
  })

  it('字幕：加一条、改文字 / 位置 / 大小，导出时带上全片时间', async () => {
    const c = await mount()
    await pick(c)
    await act(async () => { button(c, '加一条字幕').click() })
    const input = c.querySelector('input[aria-label="字幕文字"]') as HTMLInputElement
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      set.call(input, '周末去海边')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ([...c.querySelectorAll('[aria-label="字幕位置"] button')]
        .find(b => b.textContent === '上') as HTMLButtonElement).click()
      ;([...c.querySelectorAll('[aria-label="字幕大小"] button')]
        .find(b => b.textContent === '大') as HTMLButtonElement).click()
    })
    expect(c.textContent).toContain('周末去海边')

    await act(async () => { button(c, '导出 MP4').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const caps = exportMock.mock.calls[0]![0].captions
    expect(caps).toHaveLength(1)
    expect(caps[0]).toMatchObject({
      text: '周末去海边', position: 'top', size: 'l', startMs: 0,
    })
  })

  it('人像：磨皮 / 美白 / 红润叠加在预设上', async () => {
    const c = await mount()
    await pick(c)
    const preset = PRESETS.find(p => p.label === '柔光人像')!
    await act(async () => {
      ([...c.querySelectorAll('.video-presets button')]
        .find(b => b.textContent === preset.label) as HTMLButtonElement).click()
    })
    const setRange = async (label: string, value: number) => {
      await act(async () => {
        const el = c.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        set.call(el, String(value))
        el.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setRange('磨皮', 40)
    await setRange('美白', 20)
    await setRange('红润', 10)
    await act(async () => { button(c, '导出 MP4').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const adjustments = exportMock.mock.calls[0]![0].adjustments
    expect(adjustments.skinSmooth).toBe(95)
    expect(adjustments.skinBrighten).toBe(35)
    expect(adjustments.skinRosy).toBe(18)
  })

  it('相机录好的短片带进来：自动加进列表，并把种子标记为已用', async () => {
    const onSeedUsed = vi.fn()
    const c = await mount({
      initialFiles: [new File(['x'], 'cam.mp4', { type: 'video/mp4' })],
      onSeedUsed,
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(c.querySelectorAll('.video-clip')).toHaveLength(1)
    expect(onSeedUsed).toHaveBeenCalledTimes(1)
    expect(c.textContent).toContain('cam.mp4')
  })

  it('2× 变速：全片时长减半，导出带上速度', async () => {
    const c = await mount()
    await pick(c)
    expect(c.textContent).toContain('全片 0:02.0')
    await act(async () => {
      ([...c.querySelectorAll('[aria-label="播放速度"] button')]
        .find(b => b.textContent === '2×') as HTMLButtonElement).click()
    })
    expect(c.textContent).toContain('全片 0:01.0')
    await act(async () => { button(c, '导出 MP4').click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(exportMock.mock.calls[0]![0].speed).toBe(2)
  })
})
