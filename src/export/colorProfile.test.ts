import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import {
  createDisplayP3IccProfile, createSrgbIccProfile,
  injectJpegIcc, injectPngExif, injectPngIcc, injectWebpExif, injectWebpIcc,
} from './colorProfile'
import { buildExportBlob } from './save'
import { classifyIccProfile } from '../image/sourceProfile'

const profile = createSrgbIccProfile()

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function jpegSegments(bytes: Uint8Array): { marker: number; start: number; length: number }[] {
  const segments: { marker: number; start: number; length: number }[] = []
  let offset = 2
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!
    if (marker === 0xda) break
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    segments.push({ marker, start: offset, length })
    offset += 2 + length
  }
  return segments
}

function pngChunks(bytes: Uint8Array): { type: string; start: number; length: number }[] {
  const chunks: { type: string; start: number; length: number }[] = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4)
    const length = view.getUint32(0)
    const type = ascii(bytes, offset + 4, 4)
    chunks.push({ type, start: offset, length })
    offset += 12 + length
  }
  return chunks
}

function syntheticPng(): Uint8Array<ArrayBuffer> {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = new Uint8Array(13)
  ihdr.set([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    new DataView(out.buffer).setUint32(0, data.length)
    out.set([...type].map(c => c.charCodeAt(0)), 4)
    out.set(data, 8)
    return out
  }
  return new Uint8Array([
    ...signature,
    ...chunk('IHDR', ihdr),
    ...chunk('IEND', new Uint8Array()),
  ])
}

function syntheticWebp(): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array([0x2f, 0, 0, 0, 0])
  const bytes = new Uint8Array(26)
  bytes.set([82, 73, 70, 70], 0)
  new DataView(bytes.buffer).setUint32(4, 18, true)
  bytes.set([87, 69, 66, 80], 8)
  bytes.set([86, 80, 56, 76], 12)
  new DataView(bytes.buffer).setUint32(16, data.length, true)
  bytes.set(data, 20)
  return bytes
}

function webpChunks(bytes: Uint8Array): { type: string; start: number; length: number }[] {
  const chunks: { type: string; start: number; length: number }[] = []
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8)
    const length = view.getUint32(4, true)
    chunks.push({ type: ascii(bytes, offset, 4), start: offset, length })
    offset += 8 + length + (length & 1)
  }
  return chunks
}

describe('sRGB ICC profile', () => {
  it('生成可识别、带完整尺寸和必需标签的 ICC v4 RGB 配置', () => {
    const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength)
    expect(view.getUint32(0)).toBe(profile.length)
    expect(ascii(profile, 12, 4)).toBe('mntr')
    expect(ascii(profile, 16, 4)).toBe('RGB ')
    expect(ascii(profile, 20, 4)).toBe('XYZ ')
    expect(ascii(profile, 36, 4)).toBe('acsp')

    const count = view.getUint32(128)
    const tags = new Set<string>()
    for (let i = 0; i < count; i++) {
      const at = 132 + i * 12
      tags.add(ascii(profile, at, 4))
    }
    expect([...tags].sort()).toEqual([
      'bTRC', 'bXYZ', 'chad', 'cprt', 'desc', 'gTRC', 'gXYZ',
      'lumi', 'rTRC', 'rXYZ', 'wtpt',
    ])
  })
})

describe('Display P3 ICC profile', () => {
  it('生成能被源色域解析器认出的 Display P3 v4 配置', () => {
    const p3 = createDisplayP3IccProfile()
    expect(classifyIccProfile(p3)).toBe('display-p3')

    const view = new DataView(p3.buffer, p3.byteOffset, p3.byteLength)
    expect(view.getUint32(0)).toBe(p3.length)
    expect(ascii(p3, 12, 4)).toBe('mntr')
    expect(ascii(p3, 16, 4)).toBe('RGB ')
    expect(ascii(p3, 36, 4)).toBe('acsp')
  })
})

describe('embed ICC metadata', () => {
  it('JPEG 在 SOI 后写入 ICC_PROFILE，重复执行不会堆多份', async () => {
    const source = new Blob([
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xda, 0, 2]),
    ], { type: 'image/jpeg' })
    const once = new Uint8Array(await (await injectJpegIcc(source, profile)).arrayBuffer())
    const twice = new Uint8Array(await (await injectJpegIcc(
      new Blob([once], { type: 'image/jpeg' }), profile,
    )).arrayBuffer())
    const icc = jpegSegments(twice).filter(s => s.marker === 0xe2
      && ascii(twice, s.start + 4, 12) === 'ICC_PROFILE\0')
    expect(icc).toHaveLength(1)
    expect(twice[0]).toBe(0xff)
    expect(twice[1]).toBe(0xd8)
    expect(twice[2]).toBe(0xff)
    expect(twice[3]).toBe(0xe2)
  })

  it('PNG 写入可解压的 iCCP，且保留其它 chunk', async () => {
    const source = new Blob([syntheticPng()], { type: 'image/png' })
    const once = new Uint8Array(await (await injectPngIcc(source, profile)).arrayBuffer())
    const twice = new Uint8Array(await (await injectPngIcc(
      new Blob([once], { type: 'image/png' }), profile,
    )).arrayBuffer())
    const chunks = pngChunks(twice)
    expect(chunks.map(c => c.type)).toEqual(['IHDR', 'iCCP', 'IEND'])
    const iccp = chunks.find(c => c.type === 'iCCP')!
    const body = twice.slice(iccp.start + 8, iccp.start + 8 + iccp.length)
    const nul = body.indexOf(0)
    expect(body[nul + 1]).toBe(0)
    expect([...inflateSync(body.slice(nul + 2))]).toEqual([...profile])
  })

  it('WebP 写入 ICCP，更新 RIFF 长度，重复执行不会堆多份', async () => {
    const source = new Blob([syntheticWebp()], { type: 'image/webp' })
    const once = new Uint8Array(await (await injectWebpIcc(source, profile)).arrayBuffer())
    const twice = new Uint8Array(await (await injectWebpIcc(
      new Blob([once], { type: 'image/webp' }), profile,
    )).arrayBuffer())
    expect(ascii(twice, 0, 4)).toBe('RIFF')
    expect(ascii(twice, 8, 4)).toBe('WEBP')
    expect(new DataView(twice.buffer).getUint32(4, true)).toBe(twice.length - 8)
    const chunks = webpChunks(twice)
    expect(chunks.filter(c => c.type === 'ICCP')).toHaveLength(1)
    expect(chunks.map(c => c.type)).toEqual(['VP8X', 'ICCP', 'VP8L'])
    const iccp = chunks.find(c => c.type === 'ICCP')!
    expect([...twice.slice(iccp.start + 8, iccp.start + 8 + iccp.length)])
      .toEqual([...profile])
  })

  it('统一导出入口给 PNG 和 WebP 自动带 profile', async () => {
    const sourceFile = new File([], 'source.jpg', { type: 'image/jpeg' })
    for (const format of ['image/png', 'image/webp'] as const) {
      const source = format === 'image/png' ? syntheticPng() : syntheticWebp()
      const canvas = {
        width: 1,
        height: 1,
        toBlob: (callback: BlobCallback, type?: string) => {
          callback(new Blob([source], { type }))
        },
      } as unknown as HTMLCanvasElement
      const out = await buildExportBlob(canvas, sourceFile, format, 0.9, false)
      const bytes = new Uint8Array(await out.arrayBuffer())
      if (format === 'image/png') {
        expect(pngChunks(bytes).some(c => c.type === 'iCCP')).toBe(true)
      } else {
        expect(webpChunks(bytes).some(c => c.type === 'ICCP')).toBe(true)
      }
    }
  })
})

describe('embed EXIF metadata', () => {
  const exif = Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0])

  it('PNG 写入 eXIf，重复执行不会堆多份', async () => {
    const source = new Blob([syntheticPng()], { type: 'image/png' })
    const once = new Uint8Array(await (await injectPngExif(source, exif)).arrayBuffer())
    const twice = new Uint8Array(await (await injectPngExif(
      new Blob([once], { type: 'image/png' }), exif,
    )).arrayBuffer())
    const chunks = pngChunks(twice)
    const found = chunks.filter(chunk => chunk.type === 'eXIf')
    expect(found).toHaveLength(1)
    const chunk = found[0]!
    expect([...twice.slice(chunk.start + 8, chunk.start + 8 + chunk.length)])
      .toEqual([...exif])
  })

  it('WebP 写入 EXIF chunk，并设置 VP8X 的 EXIF 标志', async () => {
    const source = new Blob([syntheticWebp()], { type: 'image/webp' })
    const once = new Uint8Array(await (await injectWebpExif(source, exif)).arrayBuffer())
    const twice = new Uint8Array(await (await injectWebpExif(
      new Blob([once], { type: 'image/webp' }), exif,
    )).arrayBuffer())
    const chunks = webpChunks(twice)
    expect(chunks.filter(chunk => chunk.type === 'EXIF')).toHaveLength(1)
    const vp8x = chunks.find(chunk => chunk.type === 'VP8X')!
    expect(vp8x).toBeTruthy()
    expect(twice[vp8x.start + 8]! & 0x08).toBe(0x08)
  })
})
