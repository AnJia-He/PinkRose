// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const canvasMock = vi.hoisted(() => ({
  drawImage: vi.fn(),
  makeCanvas: vi.fn(),
}))

vi.mock('../core/canvas', () => ({
  makeCanvas: canvasMock.makeCanvas,
}))

import { decodeImageFile, imageDecodeFailureText, isHeicFile } from './decode'

function embeddedRawPreview(): Uint8Array<ArrayBuffer> {
  const width = 1600
  const height = 1067
  const bytes = new Uint8Array(96)
  bytes.set([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0])
  bytes.set([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0x00, 0x11, 8,
    height >> 8, height & 0xff, width >> 8, width & 0xff, 3,
    1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
  ], 8)
  bytes.set([0xff, 0xd9], 94)
  return bytes
}

describe('decodeImageFile 的图片元素兜底', () => {
  beforeEach(() => {
    canvasMock.drawImage.mockReset()
    canvasMock.makeCanvas.mockReset()
    canvasMock.makeCanvas.mockImplementation(() => ({
      canvas: { width: 800, height: 600 },
      ctx: { drawImage: canvasMock.drawImage },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('createImageBitmap 解不开时，改用 img.decode 再画进 sRGB 画布', async () => {
    const fileBitmapError = new Error('bitmap cannot decode')
    const raw = { width: 800, height: 600, close: vi.fn() }
    const out = { width: 800, height: 600, close: vi.fn() }
    const create = vi.fn()
      .mockRejectedValueOnce(fileBitmapError)
      .mockResolvedValueOnce(raw)
      .mockResolvedValueOnce(out)
    vi.stubGlobal('createImageBitmap', create)

    class FakeImage {
      naturalWidth = 800
      naturalHeight = 600
      src = ''
      decode = vi.fn(async () => {})
    }
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:photo'),
      revokeObjectURL: vi.fn(),
    })

    const file = new File([new Uint8Array([0, 1, 2])], 'IMG_0001.HEIC', {
      type: 'image/heic',
    })
    const decoded = await decodeImageFile(file)

    expect(decoded).toMatchObject({ width: 800, height: 600 })
    expect(decoded.bitmap).toBe(out)
    expect(create).toHaveBeenNthCalledWith(1, file, expect.any(Object))
    expect(canvasMock.drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0)
    expect(raw.close).toHaveBeenCalledTimes(1)
  })

  it('浏览器两种解码都失败时，HEIC 交给本机转换器再进入修图链路', async () => {
    const fileBitmapError = new Error('bitmap cannot decode')
    const converted = { width: 800, height: 600, close: vi.fn() }
    const out = { width: 800, height: 600, close: vi.fn() }
    const create = vi.fn()
      .mockRejectedValueOnce(fileBitmapError)
      .mockResolvedValueOnce(converted)
      .mockResolvedValueOnce(out)
    vi.stubGlobal('createImageBitmap', create)

    class FakeImage {
      naturalWidth = 0
      naturalHeight = 0
      src = ''
      decode = vi.fn(async () => { throw new Error('img cannot decode') })
    }
    vi.stubGlobal('Image', FakeImage)
    let objectUrls = 0
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => `blob:photo-${++objectUrls}`),
      revokeObjectURL: vi.fn(),
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      new Uint8Array([255, 216, 255, 217]),
      { status: 200, headers: { 'content-type': 'image/jpeg' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const file = new File([new Uint8Array([0, 1, 2])], 'IMG_0001.HEIC', {
      type: 'image/heic',
    })
    const decoded = await decodeImageFile(file)

    expect(decoded).toMatchObject({ width: 800, height: 600 })
    expect(decoded.bitmap).toBe(out)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/import/convert?name=IMG_0001.HEIC')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'content-type': 'application/octet-stream' })
    expect(init?.body).toBe(file)
    expect(converted.close).toHaveBeenCalledTimes(1)
  })

  it('★ RAW 的本机转换器不可用时，退回相机内嵌 JPEG 预览', async () => {
    const raw = { width: 1600, height: 1067, close: vi.fn() }
    const out = { width: 1600, height: 1067, close: vi.fn() }
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('bitmap cannot decode'))
      .mockResolvedValueOnce(raw)
      .mockResolvedValueOnce(out)
    vi.stubGlobal('createImageBitmap', create)

    class FakeImage {
      naturalWidth = 0
      naturalHeight = 0
      src = ''
      decode = vi.fn(async () => { throw new Error('img cannot decode') })
    }
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:raw'),
      revokeObjectURL: vi.fn(),
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      error: { message: '本机没有 RAW 转换器' },
    }), { status: 501, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const file = new File([embeddedRawPreview()], 'IMG_0001.ARW', {
      type: 'image/x-sony-arw',
    })
    const decoded = await decodeImageFile(file)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      '/api/import/capability',
      '/api/import/convert?name=IMG_0001.ARW',
    ])
    expect(decoded).toMatchObject({
      width: 1600, height: 1067,
      rawPreview: { width: 1600, height: 1067 },
    })
    expect(decoded.bitmap).toBe(out)
    const previewBlob = create.mock.calls[1]![0] as Blob
    expect(previewBlob.type).toBe('image/jpeg')
    expect(raw.close).toHaveBeenCalledTimes(1)
  })

  it('RAW 没有本机转换器时先查能力，不把整份原文件白传一遍', async () => {
    const raw = { width: 1600, height: 1067, close: vi.fn() }
    const out = { width: 1600, height: 1067, close: vi.fn() }
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('bitmap cannot decode'))
      .mockResolvedValueOnce(raw)
      .mockResolvedValueOnce(out)
    vi.stubGlobal('createImageBitmap', create)

    class FakeImage {
      naturalWidth = 0
      naturalHeight = 0
      src = ''
      decode = vi.fn(async () => { throw new Error('img cannot decode') })
    }
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:raw'),
      revokeObjectURL: vi.fn(),
    })
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ raw: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const decoded = await decodeImageFile(new File(
      [embeddedRawPreview()],
      'IMG_0001.ARW',
      { type: 'image/x-sony-arw' },
    ))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['/api/import/capability'])
    expect(decoded).toMatchObject({
      width: 1600, height: 1067,
      rawPreview: { width: 1600, height: 1067 },
    })
    expect(raw.close).toHaveBeenCalledTimes(1)
  })
})

describe('HEIC 识别与失败提示', () => {
  it('按扩展名或 MIME 认出 HEIC / HEIF，不误伤 JPG', () => {
    expect(isHeicFile({ name: 'IMG_0001.HEIC', type: '' })).toBe(true)
    expect(isHeicFile({ name: 'portrait.heif', type: 'application/octet-stream' })).toBe(true)
    expect(isHeicFile({ name: 'photo.bin', type: 'image/heic' })).toBe(true)
    expect(isHeicFile({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false)
  })

  it('HEIC 解不开时给出可执行的转换建议，其它格式保留原提示', () => {
    const heicText = imageDecodeFailureText({ name: 'IMG_0001.HEIC', type: 'image/heic' })
    expect(heicText).toContain('Safari')
    expect(heicText).toContain('导出成 JPG')
    expect(imageDecodeFailureText({ name: 'photo.jpg', type: 'image/jpeg' }))
      .toBe('这张图打不开，换一张试试')
  })
})
