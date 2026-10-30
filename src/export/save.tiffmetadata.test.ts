import { describe, expect, it } from 'vitest'
import piexif from 'piexifjs'
import { exifToTiffMetadata } from './save'

describe('TIFF metadata extraction', () => {
  it('piexif 字典翻成标准 TIFF 元数据字段', () => {
    const metadata = exifToTiffMetadata({
      '0th': {
        [piexif.ImageIFD.Make]: 'FUJIFILM',
        [piexif.ImageIFD.Model]: 'X-T5',
        [piexif.ImageIFD.Software]: 'Camera Firmware',
        [piexif.ImageIFD.DateTime]: '2026:10:21 09:00:00',
      },
      Exif: {
        [piexif.ExifIFD.DateTimeOriginal]: '2026:10:21 08:59:58',
        [piexif.ExifIFD.ExposureTime]: [1, 125],
        [piexif.ExifIFD.FNumber]: [14, 10],
        [piexif.ExifIFD.ISOSpeedRatings]: [200],
        [piexif.ExifIFD.FocalLength]: [33, 1],
        [piexif.ExifIFD.FocalLengthIn35mmFilm]: 50,
        [piexif.ExifIFD.LensModel]: 'XF33mmF1.4 R LM WR',
        [piexif.ExifIFD.WhiteBalance]: 0,
        [piexif.ExifIFD.LensSpecification]: [[33, 1], [33, 1], [14, 10], [16, 10]],
      },
      GPS: {
        [piexif.GPSIFD.GPSLatitudeRef]: 'N',
        [piexif.GPSIFD.GPSLatitude]: [[31, 1], [1, 1], [1, 1]],
        [piexif.GPSIFD.GPSLongitudeRef]: 'E',
        [piexif.GPSIFD.GPSLongitude]: [[121, 1], [28, 1], [24, 1]],
      },
      '1st': {},
      thumbnail: '',
    })
    expect(metadata).toMatchObject({
      make: 'FUJIFILM',
      model: 'X-T5',
      software: 'Camera Firmware',
      dateTimeOriginal: '2026:10:21 08:59:58',
      exposureSeconds: 1 / 125,
      fNumber: 1.4,
      iso: 200,
      focalLength: 33,
      focalLength35: 50,
      lensModel: 'XF33mmF1.4 R LM WR',
      lensSpecification: [33, 33, 1.4, 1.6],
      whiteBalance: 0,
      gps: {
        latitude: expect.closeTo(31.016944, 5),
        longitude: expect.closeTo(121.473333, 5),
      },
    })
  })

  it('关闭位置时保留相机与曝光，只省略 GPS', () => {
    const metadata = exifToTiffMetadata({
      '0th': { [piexif.ImageIFD.Make]: 'Canon' },
      Exif: { [piexif.ExifIFD.ISOSpeedRatings]: [400] },
      GPS: {
        [piexif.GPSIFD.GPSLatitudeRef]: 'N',
        [piexif.GPSIFD.GPSLatitude]: [[31, 1], [1, 1], [1, 1]],
        [piexif.GPSIFD.GPSLongitudeRef]: 'E',
        [piexif.GPSIFD.GPSLongitude]: [[121, 1], [28, 1], [24, 1]],
      },
      '1st': {},
      thumbnail: '',
    }, false)
    expect(metadata.make).toBe('Canon')
    expect(metadata.iso).toBe(400)
    expect(metadata.gps).toBeUndefined()
  })
})
