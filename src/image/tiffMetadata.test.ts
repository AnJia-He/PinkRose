import { describe, expect, it } from 'vitest'
import { parseTiffMetadata } from './tiffMetadata'

function ascii(value: string): Uint8Array {
  return Uint8Array.from([...value].map(char => char.charCodeAt(0)).concat(0))
}

function fixture(): Uint8Array<ArrayBuffer> {
  const make = ascii('Canon')
  const model = ascii('EOS R5')
  const lens = ascii('RF50mm F1.8 STM')
  const date = ascii('2026:10:21 12:34:56')
  const ifd0 = 8
  const exifAt = ifd0 + 2 + 3 * 12 + 4
  const exifEntries = 6
  const dataAt = exifAt + 2 + exifEntries * 12 + 4
  const makeAt = dataAt
  const modelAt = makeAt + make.length
  const lensAt = modelAt + model.length
  const dateAt = lensAt + lens.length
  const focalAt = dateAt + date.length
  const exposureAt = focalAt + 8
  const apertureAt = exposureAt + 8
  const bytes = new Uint8Array(apertureAt + 8)
  const view = new DataView(bytes.buffer)
  bytes.set([0x49, 0x49], 0)
  view.setUint16(2, 42, true)
  view.setUint32(4, ifd0, true)
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    view.setUint16(at, tag, true)
    view.setUint16(at + 2, type, true)
    view.setUint32(at + 4, count, true)
    if (type === 3 && count === 1) view.setUint16(at + 8, value, true)
    else view.setUint32(at + 8, value, true)
  }
  view.setUint16(ifd0, 3, true)
  entry(ifd0 + 2, 271, 2, make.length, makeAt)
  entry(ifd0 + 14, 272, 2, model.length, modelAt)
  entry(ifd0 + 26, 34665, 4, 1, exifAt)
  view.setUint32(ifd0 + 38, 0, true)

  view.setUint16(exifAt, exifEntries, true)
  entry(exifAt + 2, 42036, 2, lens.length, lensAt)
  entry(exifAt + 14, 37386, 5, 1, focalAt)
  entry(exifAt + 26, 41989, 3, 1, 50)
  entry(exifAt + 38, 36867, 2, date.length, dateAt)
  entry(exifAt + 50, 33434, 5, 1, exposureAt)
  entry(exifAt + 62, 33437, 5, 1, apertureAt)
  view.setUint32(exifAt + 74, 0, true)

  bytes.set(make, makeAt)
  bytes.set(model, modelAt)
  bytes.set(lens, lensAt)
  bytes.set(date, dateAt)
  view.setUint32(focalAt, 50, true)
  view.setUint32(focalAt + 4, 1, true)
  view.setUint32(exposureAt, 1, true)
  view.setUint32(exposureAt + 4, 250, true)
  view.setUint32(apertureAt, 28, true)
  view.setUint32(apertureAt + 4, 10, true)
  return bytes
}

describe('parseTiffMetadata', () => {
  it('reads camera, lens, exposure and date through Exif IFD', () => {
    expect(parseTiffMetadata(fixture())).toEqual({
      make: 'Canon',
      model: 'EOS R5',
      artist: null,
      copyright: null,
      lens: 'RF50mm F1.8 STM',
      focalMm: 50,
      focal35mm: 50,
      takenAt: '2026:10:21 12:34:56',
      exposureSeconds: 1 / 250,
      fNumber: 2.8,
      iso: null,
      whiteBalance: null,
      gps: null,
      hasExif: true,
    })
  })

  it('returns null instead of guessing for malformed TIFF', () => {
    expect(parseTiffMetadata(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(parseTiffMetadata(Uint8Array.from([0x49, 0x49, 0x2a, 0, 255, 255, 0, 0]))).toBeNull()
  })
})
