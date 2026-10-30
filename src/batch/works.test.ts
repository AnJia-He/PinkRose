import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadWorksZip, worksArchiveName } from './works.ts'

const work = (id: number, alias: string): {
  id: number; alias: string; createdAt: number; updatedAt: number; bytes: number
  hasThumb: boolean; rating: number; flag: -1 | 0 | 1
} => ({
  id,
  alias,
  createdAt: 1000,
  updatedAt: 2000,
  bytes: 10,
  hasThumb: true, flag: 0,
  rating: 0,
})

function zipNames(buffer: ArrayBuffer): string[] {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const names: string[] = []
  let offset = 0
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const compressed = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    names.push(new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength)))
    offset += 30 + nameLength + extraLength + compressed
  }
  return names
}

describe('works batch download', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps successful works, reports failures, and makes duplicate names unique', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/works/2/')) return new Response('no', { status: 404 })
      return new Response('image', {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const progress: number[] = []
    const result = await downloadWorksZip(
      [work(1, '同一张'), work(2, '同一张'), work(3, '同一张')],
      p => progress.push(p.completed),
    )

    expect(result.succeeded).toBe(2)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.id).toBe(2)
    expect(result.archive).not.toBeNull()
    expect(zipNames(await result.archive!.arrayBuffer())).toEqual(['同一张.jpg', '同一张_2.jpg'])
    expect(progress.at(-1)).toBe(3)
  })

  it('returns no archive when every work fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })))
    const result = await downloadWorksZip([work(1, 'A')], () => {})
    expect(result.archive).toBeNull()
    expect(result.succeeded).toBe(0)
    expect(result.failures).toHaveLength(1)
  })

  it('作品原图是 TIFF 时，ZIP 里保留 .tif 后缀', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('tiff', {
      status: 200,
      headers: { 'content-type': 'image/tiff' },
    })))
    const result = await downloadWorksZip([work(1, '打印母版')], () => {})
    expect(result.succeeded).toBe(1)
    expect(zipNames(await result.archive!.arrayBuffer())).toEqual(['打印母版.tif'])
  })

  it('names the archive by local time', () => {
    expect(worksArchiveName(new Date('2026-10-17T18:05:00')))
      .toBe('PinkRose-works-20261017-1805.zip')
  })
})
