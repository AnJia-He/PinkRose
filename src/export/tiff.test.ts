import { describe, expect, it, vi } from 'vitest'
import { inflateSync } from 'node:zlib'
import { encodeTiff } from './tiff'
import { buildExportBlob } from './save'
import { createSrgbIccProfile } from './colorProfile'
import { parseTiffMetadata } from '../image/tiffMetadata'

function canvasWith(
  width: number,
  height: number,
  data: Uint8ClampedArray,
): HTMLCanvasElement {
  return {
    width,
    height,
    getContext: () => ({
      getImageData: () => ({ data, width, height }),
    }),
  } as unknown as HTMLCanvasElement
}

type Entry = {
  type: number
  count: number
  value: number
}

function readEntries(bytes: Uint8Array): Map<number, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ifd = view.getUint32(4, true)
  const count = view.getUint16(ifd, true)
  const entries = new Map<number, Entry>()
  for (let i = 0; i < count; i++) {
    const offset = ifd + 2 + i * 12
    entries.set(view.getUint16(offset, true), {
      type: view.getUint16(offset + 2, true),
      count: view.getUint32(offset + 4, true),
      value: view.getUint32(offset + 8, true),
    })
  }
  return entries
}

describe('encodeTiff', () => {
  it('无透明像素时生成无压缩 RGB TIFF，像素保持红绿蓝顺序', async () => {
    const blob = await encodeTiff(canvasWith(2, 1, new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
    ])))
    expect(blob.type).toBe('image/tiff')

    const bytes = new Uint8Array(await blob.arrayBuffer())
    const view = new DataView(bytes.buffer)
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('II')
    expect(view.getUint16(2, true)).toBe(42)

    const entries = readEntries(bytes)
    expect(entries.get(256)?.value).toBe(2)
    expect(entries.get(257)?.value).toBe(1)
    expect(entries.get(277)?.value).toBe(3)
    expect(entries.get(259)?.value).toBe(1)
    expect(entries.get(338)).toBeUndefined()

    const pixels = entries.get(273)!.value
    expect([...bytes.slice(pixels, pixels + 6)])
      .toEqual([255, 0, 0, 0, 255, 0])
  })

  it('检测到透明像素时写 RGBA，并声明未预乘 alpha', async () => {
    const blob = await encodeTiff(canvasWith(2, 1, new Uint8ClampedArray([
      10, 20, 30, 0,
      40, 50, 60, 255,
    ])))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const entries = readEntries(bytes)
    expect(entries.get(277)?.value).toBe(4)
    expect(entries.get(258)?.count).toBe(4)
    expect(entries.get(338)?.value).toBe(2)

    const pixels = entries.get(273)!.value
    expect([...bytes.slice(pixels, pixels + 8)])
      .toEqual([10, 20, 30, 0, 40, 50, 60, 255])
  })

  it('统一导出入口选 image/tiff 时走这套编码器', async () => {
    const blob = await buildExportBlob(
      canvasWith(1, 1, new Uint8ClampedArray([12, 34, 56, 255])),
      new File(['source'], 'source.jpg', { type: 'image/jpeg' }),
      'image/tiff',
      0.95,
      false,
    )
    expect(blob.type).toBe('image/tiff')
    expect(blob.size).toBeGreaterThan(100)
  })

  it('原图没有可读 EXIF 时，作者与版权仍写进 TIFF', async () => {
    class DataUrlReader {
      result: string | ArrayBuffer | null = null
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null
      async readAsDataURL(blob: Blob) {
        const bytes = Buffer.from(await blob.arrayBuffer())
        this.result = `data:${blob.type};base64,${bytes.toString('base64')}`
        this.onload?.({} as ProgressEvent<FileReader>)
      }
    }
    vi.stubGlobal('FileReader', DataUrlReader)
    try {
      const blob = await buildExportBlob(
        canvasWith(1, 1, new Uint8ClampedArray([12, 34, 56, 255])),
        new File(['not-an-exif-image'], 'source.png', { type: 'image/png' }),
        'image/tiff',
        0.95,
        true,
        'srgb',
        true,
        {
          creator: 'Photographer A',
          copyright: '(c) 2026 Photographer A',
        },
      )
      expect(parseTiffMetadata(new Uint8Array(await blob.arrayBuffer()))).toMatchObject({
        artist: 'Photographer A',
        copyright: '(c) 2026 Photographer A',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('★ 内嵌 ICC Profile 标签，字节可原样取回', async () => {
    const profile = createSrgbIccProfile()
    const blob = await encodeTiff(
      canvasWith(1, 1, new Uint8ClampedArray([12, 34, 56, 255])),
      { iccProfile: profile },
    )
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const entries = readEntries(bytes)
    const tag = entries.get(34675)
    expect(tag).toMatchObject({ type: 7, count: profile.length })
    expect([...bytes.slice(tag!.value, tag!.value + tag!.count)]).toEqual([...profile])
  })

  it('★ 写入标准相机 / 曝光 / 镜头 / GPS 标签并可被 TIFF 解析器读回', async () => {
    const blob = await encodeTiff(
      canvasWith(1, 1, new Uint8ClampedArray([12, 34, 56, 255])),
      {
        metadata: {
          make: 'Canon',
          model: 'EOS R5',
          artist: 'Photographer A',
          copyright: '© 2026 Photographer A',
          software: 'PinkRose',
          dateTime: '2026:10:21 08:30:00',
          dateTimeOriginal: '2026:10:21 08:31:02',
          exposureSeconds: 1 / 250,
          fNumber: 2.8,
          iso: 400,
          focalLength: 50,
          focalLength35: 50,
          lensModel: 'RF50mm F1.8 STM',
          whiteBalance: 0,
          gps: { latitude: 31.016944, longitude: 121.473333 },
        },
      },
    )
    const parsed = parseTiffMetadata(new Uint8Array(await blob.arrayBuffer()))
    expect(parsed).toMatchObject({
      make: 'Canon',
      model: 'EOS R5',
      artist: 'Photographer A',
      copyright: '© 2026 Photographer A',
      lens: 'RF50mm F1.8 STM',
      focalMm: 50,
      focal35mm: 50,
      exposureSeconds: 1 / 250,
      fNumber: 2.8,
      iso: 400,
      whiteBalance: 0,
      gps: {
        latitude: expect.closeTo(31.016944, 5),
        longitude: expect.closeTo(121.473333, 5),
      },
    })
    expect(parsed?.takenAt).toBe('2026:10:21 08:31:02')
  })

  it('浏览器支持 CompressionStream 时写 Deflate TIFF，解压后像素不变', async () => {
    const width = 64
    const height = 64
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 20
      data[i + 1] = 90
      data[i + 2] = 160
      data[i + 3] = 255
    }
    const blob = await encodeTiff(canvasWith(width, height, data))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const entries = readEntries(bytes)
    expect(entries.get(259)?.value).toBe(8)
    const offset = entries.get(273)!.value
    const count = entries.get(279)!.value
    expect(count).toBeLessThan(width * height * 3)
    const raw = inflateSync(bytes.subarray(offset, offset + count))
    expect(raw.length).toBe(width * height * 3)
    expect([...raw.slice(0, 6)]).toEqual([20, 90, 160, 20, 90, 160])
  })

  it('没有 CompressionStream 时回退无压缩 TIFF', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    try {
      const width = 8
      const height = 8
      const data = new Uint8ClampedArray(width * height * 4)
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 5
        data[i + 1] = 10
        data[i + 2] = 15
        data[i + 3] = 255
      }
      const blob = await encodeTiff(canvasWith(width, height, data))
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const entries = readEntries(bytes)
      expect(entries.get(259)?.value).toBe(1)
      expect(entries.get(279)?.value).toBe(width * height * 3)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('只拿到 WebGL 画布时，经 createImageBitmap 转到 2D 后仍能编码', async () => {
    const source = {
      width: 1,
      height: 1,
      getContext: () => null,
    } as unknown as HTMLCanvasElement
    const bitmap = { width: 1, height: 1, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    const drawImage = vi.fn()
    const temp = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage,
        getImageData: () => ({
          data: new Uint8ClampedArray([20, 30, 40, 255]),
          width: 1,
          height: 1,
        }),
      }),
    }
    vi.stubGlobal('document', { createElement: () => temp })

    try {
      const blob = await encodeTiff(source)
      expect(blob.type).toBe('image/tiff')
      expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
      expect(bitmap.close).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
