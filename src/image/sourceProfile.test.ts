import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import {
  classifyIccProfile, detectSourceColorProfile, sourceColorProfileLabel,
} from './sourceProfile'

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, char => char.charCodeAt(0))
}

function jpegWithIcc(text: string): Uint8Array<ArrayBuffer> {
  const profile = asciiBytes(`icc header ${text} end`)
  const payload = Uint8Array.from([
    0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00,
    1, 1,
    ...profile,
  ])
  const length = payload.length + 2
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe2, length >> 8, length & 0xff,
    ...payload,
    0xff, 0xd9,
  ])
}

function heifWithNclx(primaries: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    0, 0, 0, 16, 0x63, 0x6f, 0x6c, 0x72, 0x6e, 0x63, 0x6c, 0x78,
    primaries >> 8, primaries & 0xff, 0, 13, 0, 0, 0,
  ])
}

function pngWithIcc(text: string): Uint8Array<ArrayBuffer> {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const chunk = (type: string, data: Uint8Array) => Uint8Array.from([
    0, 0, 0, data.length,
    ...asciiBytes(type), ...data,
    0, 0, 0, 0,
  ])
  const profile = new Uint8Array(deflateSync(Buffer.from(`profile ${text}`)))
  return Uint8Array.from([
    ...signature,
    ...chunk('IHDR', new Uint8Array(13)),
    ...chunk('iCCP', Uint8Array.from([
      ...asciiBytes('profile'), 0, 0, ...profile,
    ])),
    ...chunk('IEND', new Uint8Array()),
  ])
}

function webpWithIcc(text: string): Uint8Array<ArrayBuffer> {
  const profile = asciiBytes(`profile ${text}`)
  const chunk = Uint8Array.from([
    ...asciiBytes('ICCP'),
    profile.length, 0, 0, 0,
    ...profile,
  ])
  return Uint8Array.from([
    ...asciiBytes('RIFF'),
    chunk.length + 4, 0, 0, 0,
    ...asciiBytes('WEBP'),
    ...chunk,
  ])
}

function tiffWithIcc(text: string): Uint8Array<ArrayBuffer> {
  const profile = asciiBytes(`profile ${text}`)
  const out = new Uint8Array(8 + 2 + 12 + 4 + profile.length)
  const view = new DataView(out.buffer)
  out.set([0x49, 0x49], 0)
  view.setUint16(2, 42, true)
  view.setUint32(4, 8, true)
  view.setUint16(8, 1, true)
  view.setUint16(10, 34675, true)
  view.setUint16(12, 7, true)
  view.setUint32(14, profile.length, true)
  view.setUint32(18, 26, true)
  view.setUint32(22, 0, true)
  out.set(profile, 26)
  return out
}

describe('source color profile', () => {
  it('recognizes common ICC names and matrix fallbacks', () => {
    expect(classifyIccProfile(asciiBytes('Display P3 profile'))).toBe('display-p3')
    expect(classifyIccProfile(asciiBytes('Adobe RGB (1998)'))).toBe('adobe-rgb')
    expect(classifyIccProfile(asciiBytes('ProPhoto RGB'))).toBe('prophoto-rgb')
    expect(classifyIccProfile(asciiBytes('sRGB IEC61966-2.1'))).toBe('srgb')
    expect(classifyIccProfile(new Uint8Array([1, 2, 3]))).toBe('other')
  })

  it('reads ICC from JPEG APP2', async () => {
    const file = new File([jpegWithIcc('Display P3')], 'iphone.jpg', {
      type: 'image/jpeg',
    })
    await expect(detectSourceColorProfile(file)).resolves.toBe('display-p3')
  })

  it('reads HEIF nclx primaries without a full image decoder', async () => {
    await expect(detectSourceColorProfile(new File(
      [heifWithNclx(12)], 'iphone.heic', { type: 'image/heic' },
    ))).resolves.toBe('display-p3')
    await expect(detectSourceColorProfile(new File(
      [heifWithNclx(1)], 'photo.heic', { type: 'image/heic' },
    ))).resolves.toBe('srgb')
  })

  it('reads ICC from PNG, WebP and TIFF/DNG', async () => {
    await expect(detectSourceColorProfile(new File(
      [pngWithIcc('Adobe RGB')], 'photo.png', { type: 'image/png' },
    ))).resolves.toBe('adobe-rgb')
    await expect(detectSourceColorProfile(new File(
      [webpWithIcc('Display P3')], 'photo.webp', { type: 'image/webp' },
    ))).resolves.toBe('display-p3')
    await expect(detectSourceColorProfile(new File(
      [tiffWithIcc('ProPhoto RGB')], 'photo.dng', { type: 'image/x-adobe-dng' },
    ))).resolves.toBe('prophoto-rgb')
  })

  it('labels profiles using product-facing Chinese copy', () => {
    expect(sourceColorProfileLabel('display-p3')).toBe('Display P3')
    expect(sourceColorProfileLabel('adobe-rgb')).toBe('Adobe RGB')
    expect(sourceColorProfileLabel('prophoto-rgb')).toBe('ProPhoto RGB')
    expect(sourceColorProfileLabel('srgb')).toBe('sRGB')
  })
})
