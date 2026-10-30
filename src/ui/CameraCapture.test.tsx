// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CameraCapture, { cameraFrameRect } from './CameraCapture.tsx'

let container: HTMLDivElement
let root: Root

const media = vi.hoisted(() => ({
  stop: vi.fn(),
  applyConstraints: vi.fn().mockResolvedValue(undefined),
  getUserMedia: vi.fn(),
  enumerateDevices: vi.fn(),
  drawImage: vi.fn(),
  translate: vi.fn(),
  scale: vi.fn(),
  captureStream: vi.fn(),
}))

function stream(options: {
  capabilities?: Record<string, unknown>
  settings?: Record<string, unknown>
} = {}) {
  const track = {
    stop: media.stop,
    getCapabilities: () => options.capabilities ?? { torch: true },
    getSettings: () => options.settings ?? { deviceId: 'cam-1', width: 1280, height: 720 },
    applyConstraints: media.applyConstraints,
  }
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  }
}

async function mount(node: React.ReactNode) {
  await act(async () => { root.render(node) })
}

describe('实时相机', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
    localStorage.clear()
    let shotSeq = 0
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => `blob:shot-${++shotSeq}`),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    media.getUserMedia.mockResolvedValue(stream())
    media.enumerateDevices.mockResolvedValue([
      { kind: 'videoinput', deviceId: 'cam-1', label: 'USB Camera' },
      { kind: 'videoinput', deviceId: 'cam-2', label: 'FaceTime HD' },
    ])
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: media.getUserMedia,
        enumerateDevices: media.enumerateDevices,
      },
    })
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    })
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
      configurable: true,
      get: () => 1280,
    })
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
      configurable: true,
      get: () => 720,
    })
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: vi.fn(() => ({
        drawImage: media.drawImage,
        translate: media.translate,
        scale: media.scale,
      })),
    })
    Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
      configurable: true,
      value: (cb: (blob: Blob | null) => void, type: string) => {
        cb(new Blob(['frame'], { type }))
      },
    })
    media.captureStream.mockReturnValue({
      getTracks: () => [],
      getVideoTracks: () => [],
    })
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
      configurable: true,
      value: media.captureStream,
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('打开即请求相机，快门产出一张 JPEG 交给上层', async () => {
    const onCapture = vi.fn()
    await mount(<CameraCapture open onClose={() => {}} onCapture={onCapture} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(media.getUserMedia).toHaveBeenCalledTimes(1)
    expect(media.getUserMedia.mock.calls[0]![0]).toMatchObject({ audio: false })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const shutter = [...document.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('拍照')) as HTMLButtonElement
    expect(shutter.disabled).toBe(false)
    await act(async () => { shutter.click(); await new Promise(r => setTimeout(r, 0)) })

    expect(onCapture).toHaveBeenCalledTimes(1)
    const file = onCapture.mock.calls[0]![0] as File
    expect(file.type).toBe('image/jpeg')
    expect(file.name).toMatch(/^camera-\d+\.jpg$/)
  })

  it('浏览器支持 ImageCapture 时优先取全分辨率静态照', async () => {
    const onCapture = vi.fn()
    const takePhoto = vi.fn().mockResolvedValue(new Blob(['full'], { type: 'image/jpeg' }))
    class FakeImageCapture {
      takePhoto = takePhoto
      constructor(_track: MediaStreamTrack) {}
    }
    vi.stubGlobal('ImageCapture', FakeImageCapture)
    await mount(<CameraCapture open onClose={() => {}} onCapture={onCapture} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const shutter = [...document.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('拍照')) as HTMLButtonElement
    await act(async () => {
      shutter.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(takePhoto).toHaveBeenCalledTimes(1)
    expect(onCapture).toHaveBeenCalledTimes(1)
    const file = onCapture.mock.calls[0]![0] as File
    expect(file.type).toBe('image/jpeg')
    expect(file.size).toBe(4)
  })

  it('录像：录完把短片交给短片调色入口', async () => {
    const onRecorded = vi.fn()
    class FakeRecorder {
      static isTypeSupported = () => true
      state = 'inactive'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor(_stream: MediaStream, readonly options: MediaRecorderOptions) {}
      start() { this.state = 'recording' }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['video'], { type: 'video/mp4' }) })
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    await mount(<CameraCapture open onClose={() => {}} onCapture={() => {}}
      onRecorded={onRecorded} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const record = [...document.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('录像')) as HTMLButtonElement
    expect(record.disabled).toBe(false)
    await act(async () => { record.click() })
    expect(document.querySelector('.camera-rec-badge')).toBeTruthy()

    const stop = [...document.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('停止录像')) as HTMLButtonElement
    await act(async () => { stop.click() })
    const use = [...document.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('用短片调色打开')) as HTMLButtonElement
    expect(use).toBeTruthy()
    await act(async () => { use.click() })

    expect(onRecorded).toHaveBeenCalledTimes(1)
    const file = onRecorded.mock.calls[0]![0] as File
    // 录像容器优先 WebM（Chromium 的 MP4 录制实际写的是 VP9，播不了）
    expect(file.type).toBe('video/webm')
    expect(file.name).toMatch(/^PinkRose-camera-.*\.webm$/)
  })

  it('关掉取景会停掉所有 track', async () => {
    await mount(<CameraCapture open onClose={() => {}} onCapture={() => {}} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    await act(async () => {
      root.render(<CameraCapture open={false} onClose={() => {}} onCapture={() => {}} />)
    })
    expect(media.stop).toHaveBeenCalled()
  })

  it('权限被拒绝时给出可执行提示，不把页面带走', async () => {
    media.getUserMedia.mockRejectedValueOnce(
      new DOMException('denied', 'NotAllowedError'),
    )
    await mount(<CameraCapture open onClose={() => {}} onCapture={() => {}} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(document.body.textContent).toContain('相机权限被拒绝')
    expect(document.body.textContent).toContain('再试一次')
  })

  it('相机支持变焦时显示滑杆，并把值交给 track', async () => {
    media.getUserMedia.mockResolvedValueOnce(stream({
      capabilities: { torch: false, zoom: { min: 1, max: 4, step: 0.5 } },
      settings: { deviceId: 'cam-1', width: 1280, height: 720, zoom: 2 },
    }))
    await mount(<CameraCapture open onClose={() => {}} onCapture={() => {}} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const zoom = document.querySelector('[aria-label="相机变焦"]') as HTMLInputElement
    expect(zoom).toBeTruthy()
    expect(zoom.value).toBe('2')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(zoom, '3.5')
      zoom.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(media.applyConstraints).toHaveBeenCalledWith({
      advanced: [{ zoom: 3.5 }],
    })
  })

  it('相机支持变焦时，取景画面可用双指捏合变焦', async () => {
    media.getUserMedia.mockResolvedValueOnce(stream({
      capabilities: { torch: false, zoom: { min: 1, max: 4, step: 0.1 } },
      settings: { deviceId: 'cam-1', width: 1280, height: 720, zoom: 2 },
    }))
    await mount(<CameraCapture open onClose={() => {}} onCapture={() => {}} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const video = document.querySelector('.camera-video') as HTMLVideoElement
    const fire = (type: string, pointerId: number, x: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        clientX: { value: x },
        clientY: { value: 100 },
        pointerId: { value: pointerId },
        pointerType: { value: 'touch' },
        isPrimary: { value: pointerId === 1 },
      })
      video.dispatchEvent(event)
    }

    await act(async () => {
      fire('pointerdown', 1, 100)
      fire('pointerdown', 2, 200)
      fire('pointermove', 2, 250)
      await new Promise(r => setTimeout(r, 60))
    })
    expect(media.applyConstraints).toHaveBeenCalledWith({
      advanced: [{ zoom: 3 }],
    })
  })

  it('点按取景画面会把兴趣点和单次对焦交给相机', async () => {
    await mount(<CameraCapture open onClose={() => {}} onCapture={() => {}} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const video = document.querySelector('.camera-video') as HTMLVideoElement
    const stage = document.querySelector('.camera-stage') as HTMLDivElement
    Object.defineProperty(video, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 640, height: 360 }),
    })
    Object.defineProperty(stage, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 640, height: 360 }),
    })
    const fire = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        clientX: { value: x }, clientY: { value: y },
        pointerId: { value: 1 }, pointerType: { value: 'mouse' },
        isPrimary: { value: true },
      })
      video.dispatchEvent(event)
    }
    await act(async () => {
      fire('pointerdown', 320, 180)
      fire('pointerup', 320, 180)
      await new Promise(r => setTimeout(r, 0))
    })

    expect(media.applyConstraints).toHaveBeenCalledWith({
      advanced: [{
        pointsOfInterest: [{ x: 0.5, y: 0.5 }],
        focusMode: 'single-shot',
      }],
    })
    expect(document.querySelector('.camera-focus-point')).toBeTruthy()
  })

  it('相机支持曝光补偿 / 手动对焦时显示滑杆，并把值交给 track', async () => {
    media.getUserMedia.mockResolvedValueOnce(stream({
      capabilities: {
        torch: false,
        exposureCompensation: { min: -2, max: 2, step: 0.5 },
        focusDistance: { min: 0.1, max: 10, step: 0.1 },
      },
      settings: {
        deviceId: 'cam-1', width: 1280, height: 720,
        exposureCompensation: 0.5, focusDistance: 2.5,
      },
    }))
    await mount(<CameraCapture open onClose={() => {}} onCapture={() => {}} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const exposure = document.querySelector('[aria-label="相机曝光补偿"]') as HTMLInputElement
    const focus = document.querySelector('[aria-label="相机对焦"]') as HTMLInputElement
    expect(exposure.value).toBe('0.5')
    expect(focus.value).toBe('2.5')

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(exposure, '1.5')
      exposure.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(media.applyConstraints).toHaveBeenCalledWith({
      advanced: [{ exposureCompensation: 1.5 }],
    })

    await act(async () => {
      setter.call(focus, '4')
      focus.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 0))
    })
    expect(media.applyConstraints).toHaveBeenCalledWith({
      advanced: [{ focusDistance: 4 }],
    })
  })

  it('记住上次选择的相机设备', async () => {
    localStorage.setItem('pinkrose.camera.device', 'cam-2')
    media.getUserMedia.mockResolvedValueOnce(stream({
      settings: { deviceId: 'cam-2', width: 1280, height: 720 },
    }))
    await mount(<CameraCapture open onClose={() => {}} onCapture={() => {}} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(media.getUserMedia.mock.calls[0]![0].video).toMatchObject({
      deviceId: { exact: 'cam-2' },
    })
  })

  it('3 张连拍后可以选其中一张送入修图', async () => {
    const onCapture = vi.fn()
    await mount(<CameraCapture open onClose={() => {}} onCapture={onCapture} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    await act(async () => {
      const three = [...document.querySelectorAll('button')]
        .find(b => (b.textContent ?? '').trim() === '3 张') as HTMLButtonElement
      three.click()
    })
    const shutter = [...document.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('拍照')) as HTMLButtonElement
    await act(async () => {
      shutter.click()
      await new Promise(r => setTimeout(r, 1400))
    })

    const shots = [...document.querySelectorAll('.camera-shot')] as HTMLButtonElement[]
    expect(shots).toHaveLength(3)
    await act(async () => {
      shots[1]!.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(onCapture.mock.calls[0]![0].name).toMatch(/-2\.jpg$/)
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })

  it('倒计时支持 10 秒，并能在等待中取消而不拍照', async () => {
    const onCapture = vi.fn()
    await mount(<CameraCapture open onClose={() => {}} onCapture={onCapture} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const ten = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '10 秒') as HTMLButtonElement
    expect(ten).toBeTruthy()
    expect(ten.getAttribute('aria-pressed')).toBe('false')

    const three = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '3 秒') as HTMLButtonElement
    await act(async () => { three.click() })
    const shutter = [...document.querySelectorAll('button')]
      .find(button => button.textContent?.includes('拍照')) as HTMLButtonElement
    await act(async () => {
      shutter.click()
      await new Promise(r => setTimeout(r, 20))
    })
    const cancel = document.querySelector('[aria-label="取消倒计时"]') as HTMLButtonElement
    expect(cancel).toBeTruthy()
    await act(async () => { cancel.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 1100)) })

    expect(onCapture).not.toHaveBeenCalled()
    expect(document.querySelector('[aria-label="取消倒计时"]')).toBeNull()
  })

  it('3 张连拍可以整组送入批量', async () => {
    const onCapture = vi.fn()
    const onCaptureMany = vi.fn()
    await mount(
      <CameraCapture open onClose={() => {}} onCapture={onCapture} onCaptureMany={onCaptureMany} />,
    )
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    await act(async () => {
      const three = [...document.querySelectorAll('button')]
        .find(b => (b.textContent ?? '').trim() === '3 张') as HTMLButtonElement
      three.click()
    })
    const shutter = [...document.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('拍照')) as HTMLButtonElement
    await act(async () => {
      shutter.click()
      await new Promise(r => setTimeout(r, 1400))
    })

    const many = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '全部送入批量') as HTMLButtonElement
    expect(many).toBeTruthy()
    await act(async () => {
      many.click()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(onCapture).not.toHaveBeenCalled()
    expect(onCaptureMany).toHaveBeenCalledTimes(1)
    expect((onCaptureMany.mock.calls[0]![0] as File[]).map(f => f.name))
      .toHaveLength(3)
  })

  it('选择画幅会显示裁切框并记住选择', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 800,
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 600,
    })
    await mount(<CameraCapture open onClose={() => {}} onCapture={() => {}} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const portrait = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '4:5') as HTMLButtonElement
    await act(async () => { portrait.click() })

    const guide = document.querySelector('.camera-frame-guide') as HTMLElement
    expect(guide).toBeTruthy()
    expect(guide.getAttribute('aria-label')).toBe('取景画幅 4:5')
    expect(portrait.getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('pinkrose.camera.frame')).toBe('4:5')
    expect(guide.style.left).toBe('220px')
    expect(guide.style.top).toBe('75px')
    expect(guide.style.width).toBe('360px')
    expect(guide.style.height).toBe('450px')
  })

  it('1:1 拍照会按取景框裁切预览帧', async () => {
    const onCapture = vi.fn()
    await mount(<CameraCapture open onClose={() => {}} onCapture={onCapture} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const square = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '1:1') as HTMLButtonElement
    await act(async () => { square.click() })
    media.drawImage.mockClear()
    const shutter = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.includes('拍照')) as HTMLButtonElement
    await act(async () => {
      shutter.click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(media.drawImage).toHaveBeenCalledWith(
      expect.any(HTMLVideoElement),
      280, 0, 720, 720,
      0, 0, 720, 720,
    )
  })

  it('录像也使用当前画幅和镜像，而不是绕过取景框', async () => {
    class FakeMediaStream {
      constructor(readonly tracks: unknown[] = []) {}
      getTracks() { return this.tracks }
      getVideoTracks() { return this.tracks }
      getAudioTracks() { return [] }
    }
    class FakeRecorder {
      static isTypeSupported = () => true
      state = 'inactive'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor(_stream: MediaStream, readonly options: MediaRecorderOptions) {}
      start() { this.state = 'recording' }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['video'], { type: 'video/webm' }) })
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaStream', FakeMediaStream)
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    await mount(<CameraCapture open onClose={() => {}} onCapture={() => {}} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const square = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '1:1') as HTMLButtonElement
    const sound = document.querySelector('[aria-label="录制声音"]') as HTMLButtonElement
    const mirror = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '镜像') as HTMLButtonElement
    await act(async () => {
      square.click()
      sound.click()
      mirror.click()
    })
    media.drawImage.mockClear()
    media.translate.mockClear()
    media.scale.mockClear()
    const record = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '录像') as HTMLButtonElement
    await act(async () => {
      record.click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(media.captureStream).toHaveBeenCalledWith(30)
    expect(media.translate).toHaveBeenCalledWith(720, 0)
    expect(media.scale).toHaveBeenCalledWith(-1, 1)
    expect(media.drawImage).toHaveBeenCalledWith(
      expect.any(HTMLVideoElement),
      280, 0, 720, 720,
      0, 0, 720, 720,
    )
  })

  it('录像画布不可用时明确说明回退，不假装已经裁切', async () => {
    class FakeRecorder {
      static isTypeSupported = () => true
      state = 'inactive'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor(_stream: MediaStream, readonly options: MediaRecorderOptions) {}
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; this.onstop?.() }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    media.captureStream.mockImplementationOnce(() => {
      throw new Error('captureStream unavailable')
    })
    await mount(<CameraCapture open onClose={() => {}} onCapture={() => {}} />)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const portrait = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '4:5') as HTMLButtonElement
    const sound = document.querySelector('[aria-label="录制声音"]') as HTMLButtonElement
    await act(async () => {
      portrait.click()
      sound.click()
    })
    const record = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === '录像') as HTMLButtonElement
    await act(async () => {
      record.click()
      await new Promise(r => setTimeout(r, 0))
    })

    expect(document.querySelector('.camera-note')?.textContent)
      .toContain('保留相机原始构图')
    expect(document.body.textContent).toContain('停止录像')
  })
})

describe('相机画幅裁切', () => {
  it('原生画幅不改尺寸', () => {
    expect(cameraFrameRect(1280, 720, 'native')).toEqual({
      x: 0, y: 0, w: 1280, h: 720,
    })
  })

  it('横拍 1:1 从两侧居中裁切', () => {
    expect(cameraFrameRect(1920, 1080, '1:1')).toEqual({
      x: 420, y: 0, w: 1080, h: 1080,
    })
  })

  it('竖拍 16:9 从上下居中裁切', () => {
    expect(cameraFrameRect(1080, 1920, '16:9')).toEqual({
      x: 0, y: 656, w: 1080, h: 608,
    })
  })

  it('拒绝无尺寸画面', () => {
    expect(() => cameraFrameRect(0, 720, '1:1')).toThrow(/尺寸/)
  })
})
