import { describe, it, expect } from 'vitest'
import { buildFilename } from './save'

describe('buildFilename', () => {
  it('在原文件名后加 _ruixing 后缀', () => {
    expect(buildFilename('IMG_1234.JPG', 'image/jpeg')).toBe('IMG_1234_ruixing.jpg')
  })

  it('PNG 用 .png 后缀', () => {
    expect(buildFilename('photo.png', 'image/png')).toBe('photo_ruixing.png')
  })

  it('没有扩展名也能处理', () => {
    expect(buildFilename('weird', 'image/jpeg')).toBe('weird_ruixing.jpg')
  })

  it('多个点只替换最后一段扩展名', () => {
    expect(buildFilename('a.b.c.jpeg', 'image/jpeg')).toBe('a.b.c_ruixing.jpg')
  })
})
