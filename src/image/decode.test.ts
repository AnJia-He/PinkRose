import { describe, it, expect } from 'vitest'
import {
  align32, fitWithin, imageDecodeFailureText, isHeicFile, isRawFile, isTiffFile,
  MAX_DIMENSION, PHOTO_FILE_ACCEPT,
} from './decode'

describe('fitWithin', () => {
  it('长边超过上限时等比缩小', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 })
  })

  it('已经在范围内就不放大', () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 })
  })

  it('竖图按高度缩', () => {
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 })
  })

  it('正方形', () => {
    expect(fitWithin(4096, 4096, 2048)).toEqual({ width: 2048, height: 2048 })
  })
})

describe('align32', () => {
  it('已经是 32 的倍数就不动', () => {
    expect(align32(1024)).toBe(1024)
  })

  it('不是 32 的倍数就取最近的', () => {
    expect(align32(1200)).toBe(1216)   // 1200/32=37.5 -> 38*32
    expect(align32(1000)).toBe(992)    // 1000/32=31.25 -> 31*32
  })

  it('低于 512 时抬到 512', () => {
    expect(align32(300)).toBe(512)
  })

  it('高于 4096 时压到 4096', () => {
    expect(align32(9000)).toBe(4096)
  })

  it('结果一定是 32 的倍数', () => {
    for (const n of [1, 300, 511, 513, 1000, 1200, 2047, 4095, 9999]) {
      expect(align32(n) % 32).toBe(0)
    }
  })
})

describe('MAX_DIMENSION', () => {
  it('是 2048（spec §4.4）', () => {
    expect(MAX_DIMENSION).toBe(2048)
  })
})

describe('相机原始文件识别', () => {
  it('按扩展名识别 RAW / TIFF / HEIC，MIME 为空也能认出来', () => {
    expect(isRawFile({ name: 'IMG_0001.CR3', type: '' })).toBe(true)
    expect(isRawFile({ name: 'shot.dng', type: 'image/x-adobe-dng' })).toBe(true)
    expect(isRawFile({ name: 'portrait.jpg', type: 'image/jpeg' })).toBe(false)
    expect(isTiffFile({ name: 'scan.TIFF', type: '' })).toBe(true)
    expect(isHeicFile({ name: 'IMG_0002.HEIC', type: '' })).toBe(true)
  })

  it('HEIC / RAW / TIFF 的失败提示分别给出能照做的下一步', () => {
    expect(imageDecodeFailureText({ name: 'a.heic', type: '' })).toContain('Safari')
    expect(imageDecodeFailureText({ name: 'a.cr3', type: '' })).toContain('相机厂商软件')
    expect(imageDecodeFailureText({ name: 'a.dng', type: '' })).toContain('JPG / TIFF')
    expect(imageDecodeFailureText({ name: 'a.dng', type: '' })).toContain('没找到可用的相机预览')
    expect(imageDecodeFailureText({ name: 'a.tif', type: '' })).toContain('JPG / PNG')
    expect(imageDecodeFailureText({ name: 'a.jpg', type: 'image/jpeg' })).toBe('这张图打不开，换一张试试')
  })

  it('文件选择器把 RAW 扩展名也放进来', () => {
    expect(PHOTO_FILE_ACCEPT).toContain('.cr3')
    expect(PHOTO_FILE_ACCEPT).toContain('.dng')
    expect(PHOTO_FILE_ACCEPT).toContain('.tiff')
  })

  it('常见厂商 RAW 后缀都能进入上传链路', () => {
    expect(isRawFile({ name: 'IMG_1001.PEF', type: '' })).toBe(true)
    expect(isRawFile({ name: 'SDIM1002.X3F', type: '' })).toBe(true)
    expect(isRawFile({ name: 'GOPR1003.GPR', type: '' })).toBe(true)
    expect(PHOTO_FILE_ACCEPT).toContain('.pef')
    expect(PHOTO_FILE_ACCEPT).toContain('.x3f')
    expect(PHOTO_FILE_ACCEPT).toContain('.gpr')
  })
})
