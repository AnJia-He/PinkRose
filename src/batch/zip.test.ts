import { describe, expect, it } from 'vitest'
import { buildZipBlob, crc32, safeZipName } from './zip.ts'

describe('batch ZIP', () => {
  it('writes the standard store-only local / central signatures', async () => {
    const data = new TextEncoder().encode('hello')
    const blob = buildZipBlob([{ name: '照片.jpg', data }])
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800)
    expect(view.getUint32(14, true)).toBe(0x3610a686)
    const centralStart = 30 + new TextEncoder().encode('照片.jpg').length + data.length
    expect(view.getUint32(centralStart, true)).toBe(0x02014b50)
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50)
  })

  it('computes the reference CRC32 for hello', () => {
    expect(crc32(new TextEncoder().encode('hello'))).toBe(0x3610a686)
  })

  it('normalizes archive paths and strips traversal segments', () => {
    expect(safeZipName('..\\private/./photo.jpg')).toBe('private/photo.jpg')
    expect(safeZipName('')).toBe('photo')
  })

  it('refuses to build an empty archive', () => {
    expect(() => buildZipBlob([])).toThrow(/没有可打包/)
  })
})
