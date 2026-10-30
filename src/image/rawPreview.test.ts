import { describe, expect, it } from 'vitest'
import { findEmbeddedJpegPreview } from './rawPreview'

function jpeg(width: number, height: number, filler = 64): Uint8Array {
  const bytes = new Uint8Array(41 + filler)
  let i = 0
  const push = (...values: number[]) => { for (const value of values) bytes[i++] = value }
  push(0xff, 0xd8)
  push(0xff, 0xe0, 0x00, 0x10)
  push(...[0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  push(0xff, 0xc0, 0x00, 0x11, 8,
    height >> 8, height & 0xff, width >> 8, width & 0xff, 3,
    1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0)
  for (let n = 0; n < filler; n++) bytes[i++] = n & 0xff
  push(0xff, 0xd9)
  return bytes
}

function container(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

describe('findEmbeddedJpegPreview', () => {
  it('从 RAW 容器里挑像素面积最大的可用 JPEG 预览', () => {
    const small = jpeg(160, 120, 32)
    const large = jpeg(1600, 1067, 256)
    const bytes = container(
      Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]),
      new Uint8Array(16),
      small,
      new Uint8Array(24),
      large,
      new Uint8Array(12),
    )
    const preview = findEmbeddedJpegPreview(bytes)
    expect(preview).toMatchObject({ width: 1600, height: 1067 })
    const offset = preview!.offset
    expect([...bytes.slice(offset, offset + 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0])
    expect(bytes[offset + preview!.length - 2]).toBe(0xff)
    expect(bytes[offset + preview!.length - 1]).toBe(0xd9)
  })

  it('小于 640px 的缩略图和损坏的 JPEG 不作为正式预览', () => {
    const thumb = jpeg(320, 240, 32)
    const broken = jpeg(2000, 1400, 32).slice(0, -1)
    expect(findEmbeddedJpegPreview(container(thumb, broken))).toBeNull()
  })

  it('没有 JPEG 标记时返回 null', () => {
    expect(findEmbeddedJpegPreview(new Uint8Array(2048))).toBeNull()
  })
})
