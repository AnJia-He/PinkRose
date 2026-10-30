import { describe, expect, it } from 'vitest'
import { buildLivePhotoBundle } from './livePhotoBundle'

describe('Apple 实况照片兼容包', () => {
  it('把 JPG 成片和原 MOV 按同一 stem 放进 ZIP，不转码动作', async () => {
    const image = new Blob(['edited-jpeg'], { type: 'image/jpeg' })
    const movie = new File(['movie-bytes'], 'IMG_1001.MOV', { type: 'video/quicktime' })
    const result = await buildLivePhotoBundle(image, 'IMG_1001_pinkrose.jpg', movie)

    expect(result.name).toBe('IMG_1001_pinkrose_实况照片兼容包.zip')
    expect(result.imageName).toBe('IMG_1001_pinkrose.jpg')
    expect(result.movieName).toBe('IMG_1001_pinkrose.MOV')
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    expect(text).toContain('IMG_1001_pinkrose.jpg')
    expect(text).toContain('IMG_1001_pinkrose.MOV')
    expect(text).toContain('edited-jpeg')
    expect(text).toContain('movie-bytes')
  })

  it('静帧不是 JPG 时直接拒绝，不拿错误格式冒充兼容包', async () => {
    await expect(buildLivePhotoBundle(
      new Blob(['png'], { type: 'image/png' }),
      'IMG_1002.png',
      new File(['mov'], 'IMG_1002.MOV', { type: 'video/quicktime' }),
    )).rejects.toThrow(/需要 JPG/)
  })
})
