import { afterEach, describe, it, expect, vi } from 'vitest'
import { buildFilename, canShareImage, shareImage } from './save'

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

/**
 * 2026-09-23 加。起因：用户真机上跑完那条 30 秒的线，回来说
 * **「下载后用户第一时间是不知道在哪里的」** —— 时间够了，但那一段让人心里没底。
 *
 * 所以给一个「分享」按钮，点一下弹系统面板、一步选微信，跳过"翻文件管理器"。
 * 这里测的是**分享这件事本身**；按钮长什么样在 App.test.tsx 里测。
 */
describe('canShareImage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('这台设备没有分享能力 → false', () => {
    vi.stubGlobal('navigator', {})
    expect(canShareImage()).toBe(false)
  })

  it('⚠️「有 share 但不认图片」也算没有能力', () => {
    // 桌面 Chrome 就是这样：navigator.share 在，但它只能分享文字和链接。
    // **判据写成"share 在不在"的实现，这条会红** —— 而红得有道理：
    // 那样用户会点出一个分享不了图片的面板，比没有按钮还糟。
    vi.stubGlobal('navigator', { share: () => {}, canShare: () => false })
    expect(canShareImage()).toBe(false)
  })

  it('能分享时 true，而且是**拿一个图片文件**去问的', () => {
    // 不带 files 的 canShare 只回答"能不能分享文字"，问了等于没问。
    // 形参写出来（而不是 vi.fn(() => true)）是为了让类型检查真的去对签名 ——
    // 空参数表的 mock 会把 calls[0][0] 推成 undefined，断言就断了。
    const canShare = vi.fn((_data: { files?: File[] }) => true)
    vi.stubGlobal('navigator', { share: () => {}, canShare })
    expect(canShareImage()).toBe(true)
    const arg = canShare.mock.calls[0][0]
    expect(arg.files).toHaveLength(1)
    expect(arg.files?.[0].type).toBe('image/jpeg')
  })

  it('canShare 抛错时当"不能分享"处理，不往上炸', () => {
    // 探测能力失败不该让整个页面挂掉 —— 大不了退回下载
    vi.stubGlobal('navigator', { canShare: () => { throw new Error('boom') } })
    expect(canShareImage()).toBe(false)
  })
})

describe('shareImage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('把图交给系统面板，文件名要带过去', async () => {
    const share = vi.fn(async (_data: { files?: File[] }) => {})
    vi.stubGlobal('navigator', { share, canShare: () => true })
    await shareImage(new Blob(['x'], { type: 'image/jpeg' }), 'a_ruixing.jpg')
    const arg = share.mock.calls[0][0]
    expect(arg.files?.[0].name).toBe('a_ruixing.jpg')
    expect(arg.files?.[0].type).toBe('image/jpeg')
  })

  it('⚠️ 用户自己关掉面板 → 当作没发生，不抛错', async () => {
    // 这条是「取消不是失败」的唯一防线。当成失败处理的话，用户每次取消
    // 都会被弹一句错误、而且还会**白下载一份** —— 恰好是他不想要的东西。
    const abort = new DOMException('cancelled', 'AbortError')
    vi.stubGlobal('navigator', { share: async () => { throw abort } })
    await expect(shareImage(new Blob(), 'a.jpg')).resolves.toBeUndefined()
  })

  it('分享真的失败 → 往外抛，让调用方退回下载', async () => {
    vi.stubGlobal('navigator', { share: async () => { throw new Error('NotAllowedError') } })
    await expect(shareImage(new Blob(), 'a.jpg')).rejects.toThrow('NotAllowedError')
  })
})
