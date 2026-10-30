// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loadMock, insertMock, dumpMock } = vi.hoisted(() => ({
  loadMock: vi.fn(() => ({ '0th': {}, Exif: {}, GPS: {}, '1st': {}, thumbnail: null })),
  insertMock: vi.fn((_exif: string, dataUrl: string) => dataUrl),
  dumpMock: vi.fn((_exif: unknown) => '\x49\x49\x2a\x00\x08\x00\x00\x00\x00\x00\x00\x00'),
}))

vi.mock('piexifjs', () => ({
  default: {
    load: loadMock,
    dump: dumpMock,
    insert: insertMock,
    ImageIFD: { Artist: 315, Copyright: 33432 },
    ExifIFD: {},
  },
}))

import { attachExifMetadata } from './save'

function syntheticPng(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
  ])
}

function syntheticWebp(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(26)
  bytes.set([82, 73, 70, 70], 0)
  new DataView(bytes.buffer).setUint32(4, 18, true)
  bytes.set([87, 69, 66, 80], 8)
  bytes.set([86, 80, 56, 76], 12)
  new DataView(bytes.buffer).setUint32(16, 5, true)
  bytes.set([0x2f, 0, 0, 0, 0], 20)
  return bytes
}

function chunkTypes(bytes: Uint8Array, webp = false): string[] {
  const types: string[] = []
  let offset = webp ? 12 : 8
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8)
    const length = webp ? view.getUint32(4, true) : view.getUint32(0)
    const typeOffset = offset + (webp ? 0 : 4)
    types.push(String.fromCharCode(...bytes.slice(typeOffset, typeOffset + 4)))
    offset += 8 + length + (webp && (length & 1) ? 1 : 0)
    if (!webp) offset += 4
  }
  return types
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

describe('导出元数据', () => {
  beforeEach(() => loadMock.mockClear())

  it('关掉「保留拍摄信息」时原样返回图片，不读取原图 EXIF', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    const got = await attachExifMetadata(blob, new File(['x'], 'IMG.jpg'), false)
    expect(got).toBe(blob)
    expect(loadMock).not.toHaveBeenCalled()
  })

  it('保留时读取 EXIF 并写回图片', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    const got = await attachExifMetadata(blob, new File(['x'], 'IMG.jpg'), true)
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(got).not.toBe(blob)
    expect(got.type).toBe('image/jpeg')
  })

  it('关闭位置时只删 GPS，相机和曝光仍交给 dump', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    loadMock.mockReturnValueOnce({
      '0th': { 271: 'Canon', 272: 'EOS R5' },
      Exif: { 33434: [1, 125] },
      GPS: { 1: 'N', 2: [[31, 1], [1, 1], [1, 1]] },
      '1st': {},
      thumbnail: null,
    })
    await attachExifMetadata(blob, new File(['x'], 'IMG.jpg'), true, false)
    const dumped = dumpMock.mock.calls.at(-1)![0] as Record<string, unknown>
    expect(dumped.GPS).toBeUndefined()
    expect(dumped['0th']).toMatchObject({ 271: 'Canon', 272: 'EOS R5' })
    expect(dumped.Exif).toMatchObject({ 33434: [1, 125] })
  })

  it('作者与版权会覆盖进 EXIF，非西文降级为 ?，空白输入不抹掉原值', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    loadMock.mockReturnValueOnce({
      '0th': { 315: '原作者', 33432: '原版权' },
      Exif: {},
      GPS: {},
      '1st': {},
      thumbnail: null,
    })
    await attachExifMetadata(
      blob,
      new File(['x'], 'IMG.jpg'),
      true,
      true,
      { creator: '  摄影师甲  ', copyright: ' © PinkRose ' },
    )
    const dumped = dumpMock.mock.calls.at(-1)![0] as Record<string, unknown>
    expect(dumped['0th']).toMatchObject({
      315: '????',
      33432: '© PinkRose',
    })

    dumpMock.mockClear()
    loadMock.mockReturnValueOnce({
      '0th': { 315: '原作者', 33432: '原版权' },
      Exif: {},
      GPS: {},
      '1st': {},
      thumbnail: null,
    })
    await attachExifMetadata(blob, new File(['x'], 'IMG.jpg'), true, true, {
      creator: '  ',
      copyright: '',
    })
    const kept = dumpMock.mock.calls.at(-1)![0] as Record<string, unknown>
    expect(kept['0th']).toMatchObject({ 315: '原作者', 33432: '原版权' })
  })

  it('原图没有可读 EXIF 时，用户填写的作者与版权仍然写进去', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    loadMock.mockRejectedValueOnce(new Error('not an exif container'))
    const got = await attachExifMetadata(
      blob,
      new File(['png'], 'source.png', { type: 'image/png' }),
      true,
      true,
      { creator: 'Photographer A', copyright: '(c) 2026 Photographer A' },
    )
    expect(got).not.toBe(blob)
    const dumped = dumpMock.mock.calls.at(-1)![0] as Record<string, unknown>
    expect(dumped['0th']).toMatchObject({
      315: 'Photographer A',
      33432: '(c) 2026 Photographer A',
    })
  })

  it('PNG 保留拍摄信息时写入 eXIf', async () => {
    const blob = new Blob([syntheticPng()], { type: 'image/png' })
    const got = await attachExifMetadata(blob, new File(['x'], 'IMG.jpg'), true)
    const bytes = await blobBytes(got)
    expect(chunkTypes(bytes)).toContain('eXIf')
  })

  it('WebP 保留拍摄信息时写入 EXIF', async () => {
    const blob = new Blob([syntheticWebp()], { type: 'image/webp' })
    const got = await attachExifMetadata(blob, new File(['x'], 'IMG.jpg'), true)
    const bytes = await blobBytes(got)
    expect(chunkTypes(bytes, true)).toContain('EXIF')
  })
})
