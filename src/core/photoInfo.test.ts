import { describe, expect, it } from 'vitest'
import piexif from 'piexifjs'
import { exifToLensInfo, exifToPhotoInfo, readLensInfo, readPhotoInfo } from './photoInfo.ts'
import { parseTiffMetadata } from '../image/tiffMetadata.ts'

const file = { name: 'IMG_0001.JPG', type: 'image/jpeg', size: 2_400_000 }

function tinyDng(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(74)
  const view = new DataView(bytes.buffer)
  bytes.set([0x49, 0x49], 0)
  view.setUint16(2, 42, true)
  view.setUint32(4, 8, true)
  view.setUint16(8, 5, true)
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    view.setUint16(at, tag, true)
    view.setUint16(at + 2, type, true)
    view.setUint32(at + 4, count, true)
    if (type === 3) view.setUint16(at + 8, value, true)
    else view.setUint32(at + 8, value, true)
  }
  entry(10, 271, 2, 4, 0x41) // A + NUL padding
  entry(22, 272, 2, 4, 0x42) // B + NUL padding
  entry(34, 42036, 2, 4, 0x4c) // L + NUL padding
  entry(46, 41989, 3, 1, 50)
  entry(58, 34855, 3, 1, 400)
  view.setUint32(70, 0, true)
  return bytes
}

function exifBytes(): Uint8Array<ArrayBuffer> {
  const dumped = piexif.dump({
    '0th': {
      [piexif.ImageIFD.Make]: 'FUJIFILM',
      [piexif.ImageIFD.Model]: 'X-T5',
    },
    Exif: {
      [piexif.ExifIFD.DateTimeOriginal]: '2026:10:20 16:40:03',
      [piexif.ExifIFD.ExposureTime]: [1, 125],
      [piexif.ExifIFD.FNumber]: [2, 1],
      [piexif.ExifIFD.ISOSpeedRatings]: [200],
      [piexif.ExifIFD.FocalLength]: [33, 1],
      [piexif.ExifIFD.FocalLengthIn35mmFilm]: 50,
      [piexif.ExifIFD.LensModel]: 'XF33mmF1.4 R LM WR',
      [piexif.ExifIFD.WhiteBalance]: 0,
    },
    GPS: {
      [piexif.GPSIFD.GPSLatitudeRef]: 'N',
      [piexif.GPSIFD.GPSLatitude]: [[31, 1], [1, 1], [1, 1]],
      [piexif.GPSIFD.GPSLongitudeRef]: 'E',
      [piexif.GPSIFD.GPSLongitude]: [[121, 1], [28, 1], [24, 1]],
    },
  })
  return Uint8Array.from(dumped, char => char.charCodeAt(0))
}

function pngWithExif(exif: Uint8Array): Uint8Array<ArrayBuffer> {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    new DataView(out.buffer).setUint32(0, data.length)
    out.set([...type].map(char => char.charCodeAt(0)), 4)
    out.set(data, 8)
    return out
  }
  return new Uint8Array([
    ...signature,
    ...chunk('eXIf', exif),
    ...chunk('IEND', new Uint8Array()),
  ])
}

function webpWithExif(exif: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefixed = new Uint8Array(6 + exif.length)
  prefixed.set([69, 120, 105, 102, 0, 0])
  prefixed.set(exif, 6)
  const padded = new Uint8Array(prefixed.length + (prefixed.length & 1))
  padded.set(prefixed)
  const bytes = new Uint8Array(20 + padded.length)
  bytes.set([82, 73, 70, 70], 0)
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true)
  bytes.set([87, 69, 66, 80], 8)
  bytes.set([69, 88, 73, 70], 12)
  new DataView(bytes.buffer).setUint32(16, prefixed.length, true)
  bytes.set(padded, 20)
  return bytes
}

describe('exifToPhotoInfo', () => {
  it('相机、镜头、曝光和拍摄时间翻成人能读的字段', () => {
    const info = exifToPhotoInfo(file, 6000, 4000, {
      '0th': {
        [piexif.ImageIFD.Make]: 'Canon',
        [piexif.ImageIFD.Model]: 'EOS R5',
        [piexif.ImageIFD.Artist]: 'Photographer A',
        [piexif.ImageIFD.Copyright]: '(c) 2026 Photographer A',
        [piexif.ImageIFD.DateTime]: '2026:10:19 08:30:00',
      },
      Exif: {
        [piexif.ExifIFD.DateTimeOriginal]: '2026:10:19 08:31:02',
        [piexif.ExifIFD.ExposureTime]: [1, 250],
        [piexif.ExifIFD.FNumber]: [28, 10],
        [piexif.ExifIFD.ISOSpeedRatings]: [400],
        [piexif.ExifIFD.FocalLength]: [50, 1],
        [piexif.ExifIFD.FocalLengthIn35mmFilm]: 50,
        [piexif.ExifIFD.LensModel]: 'RF50mm F1.8 STM',
        [piexif.ExifIFD.WhiteBalance]: 0,
      },
      GPS: {
        [piexif.GPSIFD.GPSLatitudeRef]: 'N',
        [piexif.GPSIFD.GPSLatitude]: [[31, 1], [1, 1], [1, 1]],
        [piexif.GPSIFD.GPSLongitudeRef]: 'E',
        [piexif.GPSIFD.GPSLongitude]: [[121, 1], [28, 1], [24, 1]],
      },
    })
    expect(info).toMatchObject({
      fileName: 'IMG_0001.JPG',
      fileSize: '2.3 MB',
      width: 6000,
      height: 4000,
      camera: 'Canon EOS R5',
      lens: 'RF50mm F1.8 STM',
      takenAt: '2026-10-19 08:31',
      shutter: '1/250 秒',
      aperture: 'f/2.8',
      iso: 'ISO 400',
      focalLength: '50 mm（等效 50 mm）',
      whiteBalance: '自动',
      creator: 'Photographer A',
      copyright: '(c) 2026 Photographer A',
      gps: '31.016944° N, 121.473333° E',
      hasGps: true,
      hasExif: true,
    })
  })

  it('没有 EXIF 时仍给文件与尺寸信息', () => {
    const info = exifToPhotoInfo(file, 1200, 800, null)
    expect(info.camera).toBeNull()
    expect(info.shutter).toBeNull()
    expect(info.hasGps).toBe(false)
    expect(info.hasExif).toBe(false)
    expect(info.width).toBe(1200)
  })

  it('★ 照片信息保留源色彩配置名称', () => {
    const info = exifToPhotoInfo(file, 1200, 800, null, 'Display P3')
    expect(info.colorProfile).toBe('Display P3')
  })

  it('镜头匹配字段保留原始数值，不做展示格式化', () => {
    const lens = exifToLensInfo({
      '0th': {
        [piexif.ImageIFD.Make]: 'SONY',
        [piexif.ImageIFD.Model]: 'ILCE-7RM5',
      },
      Exif: {
        [piexif.ExifIFD.LensModel]: 'FE 24-70mm F2.8 GM II',
        [piexif.ExifIFD.FocalLength]: [50, 1],
        [piexif.ExifIFD.FocalLengthIn35mmFilm]: 50,
        [piexif.ExifIFD.DateTimeOriginal]: '2026:10:20 08:15:30',
      },
    })
    expect(lens).toEqual({
      make: 'SONY',
      model: 'ILCE-7RM5',
      lens: 'FE 24-70mm F2.8 GM II',
      focalMm: 50,
      focal35mm: 50,
      hasExif: true,
      takenAt: '2026-10-20 08:15',
      takenAtMs: new Date(2026, 9, 20, 8, 15, 30).getTime(),
    })
  })

  it('★ TIFF / DNG EXIF 也参与镜头匹配和照片信息', async () => {
    const bytes = tinyDng()
    expect(parseTiffMetadata(bytes)).toMatchObject({ make: 'A', model: 'B', lens: 'L' })
    const raw = new File([bytes], 'shot.DNG', { type: 'image/x-adobe-dng' })
    expect(await readLensInfo(raw)).toMatchObject({
      make: 'A', model: 'B', lens: 'L', focal35mm: 50, hasExif: true,
    })
    expect(await readPhotoInfo(raw, 6000, 4000)).toMatchObject({
      camera: 'A B',
      lens: 'L',
      focalLength: '等效 50 mm',
      iso: 'ISO 400',
      width: 6000,
      height: 4000,
    })
  })

  it('★ iPhone HEIC 内嵌 EXIF 也能读出镜头与拍摄日期', async () => {
    const exif = exifBytes()
    const ftyp = new Uint8Array([
      0, 0, 0, 24,
      ...new TextEncoder().encode('ftypheic'),
      0, 0, 0, 0,
      ...new TextEncoder().encode('heicmif1'),
    ])
    const bytes = new Uint8Array(ftyp.length + exif.length)
    bytes.set(ftyp)
    bytes.set(exif, ftyp.length)
    const raw = new File([bytes], 'IMG_0001.HEIC', { type: 'image/heic' })

    expect(await readLensInfo(raw)).toMatchObject({
      make: 'FUJIFILM',
      model: 'X-T5',
      lens: 'XF33mmF1.4 R LM WR',
      focalMm: 33,
      focal35mm: 50,
      hasExif: true,
      takenAt: '2026-10-20 16:40',
    })
    expect(await readPhotoInfo(raw, 4032, 3024)).toMatchObject({
      camera: 'FUJIFILM X-T5',
      lens: 'XF33mmF1.4 R LM WR',
      takenAt: '2026-10-20 16:40',
      iso: 'ISO 200',
    })
  })

  it('Pentax PEF 等扩展 TIFF-based RAW 也读取机身、镜头和 ISO', async () => {
    const raw = new File([tinyDng()], 'IMGP0001.PEF', { type: 'image/x-pentax-pef' })
    expect(await readLensInfo(raw)).toMatchObject({
      make: 'A', model: 'B', lens: 'L', focal35mm: 50, hasExif: true,
    })
    expect(await readPhotoInfo(raw, 6000, 4000)).toMatchObject({
      camera: 'A B',
      lens: 'L',
      iso: 'ISO 400',
    })
  })

  it('★ PNG eXIf 参与照片信息和自动镜头匹配', async () => {
    const raw = new File([pngWithExif(exifBytes())], 'edited.png', { type: 'image/png' })
    expect(await readLensInfo(raw)).toMatchObject({
      make: 'FUJIFILM',
      model: 'X-T5',
      lens: 'XF33mmF1.4 R LM WR',
      focalMm: 33,
      focal35mm: 50,
      hasExif: true,
    })
    expect(await readPhotoInfo(raw, 4000, 3000)).toMatchObject({
      camera: 'FUJIFILM X-T5',
      lens: 'XF33mmF1.4 R LM WR',
      takenAt: '2026-10-20 16:40',
      shutter: '1/125 秒',
      aperture: 'f/2',
      iso: 'ISO 200',
      focalLength: '33 mm（等效 50 mm）',
      whiteBalance: '自动',
      gps: '31.016944° N, 121.473333° E',
      hasGps: true,
    })
  })

  it('★ WebP EXIF（含 Exif 前缀）同样能读回摄影信息', async () => {
    const raw = new File([webpWithExif(exifBytes())], 'edited.webp', { type: 'image/webp' })
    expect(await readLensInfo(raw)).toMatchObject({
      make: 'FUJIFILM',
      model: 'X-T5',
      lens: 'XF33mmF1.4 R LM WR',
      hasExif: true,
    })
    expect(await readPhotoInfo(raw, 4000, 3000)).toMatchObject({
      camera: 'FUJIFILM X-T5',
      iso: 'ISO 200',
      gps: '31.016944° N, 121.473333° E',
      hasGps: true,
      width: 4000,
      height: 3000,
    })
  })
})
