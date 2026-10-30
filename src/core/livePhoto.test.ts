import { describe, expect, it } from 'vitest'
import {
  imageContentIdentifier, inspectLivePhotoBytes, movieContentIdentifier,
  pairLivePhoto, pairLivePhotos,
} from './livePhoto'

const file = (name: string, type = '') => new File(['x'], name, { type })
const text = (value: string) => new TextEncoder().encode(value)
const IMAGE_ID = '12345678-1234-5678-9abc-def012345678'
const OTHER_ID = '87654321-4321-8765-cba9-fedcba987654'

describe('Live Photo 文件配对', () => {
  it('同名照片与 MOV 配成一对，扩展名大小写不影响', () => {
    const image = file('IMG_1001.HEIC', 'image/heic')
    const movie = file('IMG_1001.MOV', 'video/quicktime')
    expect(pairLivePhoto([image, movie])).toEqual({ image, movie })
    expect(pairLivePhoto([movie, image])).toEqual({ image, movie })
  })

  it('JPEG + MOV 也按同一套规则识别', () => {
    const image = file('IMG_1002.JPG', 'image/jpeg')
    const movie = file('IMG_1002.mov', '')
    expect(pairLivePhoto([image, movie])).toEqual({ image, movie })
  })

  it('不同文件名 / 多出来一张 / 只有半边都不冒充实况照片', () => {
    expect(pairLivePhoto([
      file('IMG_1003.HEIC', 'image/heic'),
      file('IMG_1004.MOV', 'video/quicktime'),
    ])).toBeNull()
    expect(pairLivePhoto([
      file('IMG_1005.HEIC', 'image/heic'),
      file('IMG_1005.MOV', 'video/quicktime'),
      file('other.jpg', 'image/jpeg'),
    ])).toBeNull()
    expect(pairLivePhoto([file('IMG_1006.HEIC', 'image/heic')])).toBeNull()
    expect(pairLivePhoto([file('IMG_1007.MOV', 'video/quicktime')])).toBeNull()
  })

  it('一次选择多组实况照片时按同名 stem 全部配对', () => {
    const oneImage = file('IMG_2001.JPG', 'image/jpeg')
    const oneMovie = file('IMG_2001.MOV', 'video/quicktime')
    const twoImage = file('IMG_2002.HEIC', 'image/heic')
    const twoMovie = file('IMG_2002.mov', 'video/quicktime')
    expect(pairLivePhotos([oneMovie, twoImage, oneImage, twoMovie])).toEqual([
      { image: oneImage, movie: oneMovie },
      { image: twoImage, movie: twoMovie },
    ])
  })

  it('同名文件有歧义时放弃那一组，但仍然返回能够确定的其它组', () => {
    const goodImage = file('IMG_3001.JPG', 'image/jpeg')
    const goodMovie = file('IMG_3001.MOV', 'video/quicktime')
    const ambiguousImage = file('IMG_3002.JPG', 'image/jpeg')
    const ambiguousMovie = file('IMG_3002.MOV', 'video/quicktime')
    const duplicateImage = file('IMG_3002.JPG', 'image/jpeg')
    expect(pairLivePhotos([
      goodImage, goodMovie, ambiguousImage, duplicateImage, ambiguousMovie,
    ])).toEqual([{ image: goodImage, movie: goodMovie }])
  })

  it('从 MOV 标准和静帧文本里读出同一个 Apple 实况标识', () => {
    const movie = text(`moov/meta/keys/com.apple.quicktime.content.identifier/data/${IMAGE_ID}`)
    const image = text(`Exif/Apple/MakerNote/${IMAGE_ID}`)
    expect(movieContentIdentifier(movie)).toBe(IMAGE_ID)
    expect(imageContentIdentifier(image)).toBe(IMAGE_ID)
    expect(inspectLivePhotoBytes(image, movie)).toMatchObject({
      status: 'verified',
      movieId: IMAGE_ID,
      imageId: IMAGE_ID,
    })
  })

  it('静帧只有 16 字节 Apple 标识时，仍能与 MOV 对账', () => {
    const movie = text(`com.apple.quicktime.content.identifier ${IMAGE_ID}`)
    const raw = new Uint8Array([
      0x31, 0x37,
      0x12, 0x34, 0x56, 0x78, 0x12, 0x34,
      0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
      0x12, 0x34, 0x56, 0x78,
    ])
    expect(inspectLivePhotoBytes(raw, movie)).toMatchObject({
      status: 'verified',
      movieId: IMAGE_ID,
    })
  })

  it('同名但照片和 MOV 的标识不同会明确标成 mismatch', () => {
    const movie = text(`com.apple.quicktime.content.identifier ${IMAGE_ID}`)
    const image = text(`Apple MakerNote ${OTHER_ID}`)
    expect(inspectLivePhotoBytes(image, movie)).toMatchObject({
      status: 'mismatch',
      movieId: IMAGE_ID,
      imageId: OTHER_ID,
    })
  })

  it('普通 MOV 没有标准 key 时不冒充已验证', () => {
    const result = inspectLivePhotoBytes(text(`image ${IMAGE_ID}`), text(`movie ${IMAGE_ID}`))
    expect(result.status).toBe('unverified')
    expect(result.movieId).toBeNull()
  })
})
