import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  buildFilename, canCopyImage, canShareFile, canShareImage, copyImage, cropRectForAspect,
  exportSize, shareFile, shareImage,
} from './save'

describe('buildFilename', () => {
  it('在原文件名后加 _pinkrose 后缀', () => {
    expect(buildFilename('IMG_1234.JPG', 'image/jpeg')).toBe('IMG_1234_pinkrose.jpg')
  })

  it('PNG 用 .png 后缀', () => {
    expect(buildFilename('photo.png', 'image/png')).toBe('photo_pinkrose.png')
  })

  it('没有扩展名也能处理', () => {
    expect(buildFilename('weird', 'image/jpeg')).toBe('weird_pinkrose.jpg')
  })

  it('多个点只替换最后一段扩展名', () => {
    expect(buildFilename('a.b.c.jpeg', 'image/jpeg')).toBe('a.b.c_pinkrose.jpg')
  })

  it('WebP 用 .webp 后缀', () => {
    expect(buildFilename('photo.jpeg', 'image/webp')).toBe('photo_pinkrose.webp')
  })

  it('AVIF 用 .avif 后缀', () => {
    expect(buildFilename('photo.jpeg', 'image/avif')).toBe('photo_pinkrose.avif')
  })

  it('HEIC 用 .heic 后缀', () => {
    expect(buildFilename('photo.jpeg', 'image/heic')).toBe('photo_pinkrose.heic')
  })

  it('TIFF 用 .tif 后缀', () => {
    expect(buildFilename('photo.jpeg', 'image/tiff')).toBe('photo_pinkrose.tif')
  })

  it('自定义文件名替换默认后缀，扩展名跟格式走', () => {
    expect(buildFilename('photo.jpeg', 'image/webp', '  海边的日落.webp  '))
      .toBe('海边的日落.webp')
    expect(buildFilename('photo.jpeg', 'image/png', '海边的日落.jpg'))
      .toBe('海边的日落.png')
  })

  it('自定义文件名去掉路径 / 非法字符，空值回原规则', () => {
    expect(buildFilename('photo.jpg', 'image/jpeg', '../a:b*c?.jpg'))
      .toBe('-a-b-c-.jpg')
    expect(buildFilename('photo.jpg', 'image/jpeg', '   '))
      .toBe('photo_pinkrose.jpg')
  })
})

describe('exportSize', () => {
  it('长边缩到上限，短边按比例', () => {
    expect(exportSize(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 })
    expect(exportSize(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 })
  })

  it('原尺寸就比上限小 —— 不放大', () => {
    expect(exportSize(1200, 800, 2048)).toEqual({ width: 1200, height: 800 })
  })

  it('社交比例允许按目标长边放大', () => {
    expect(exportSize(800, 800, 1080, true)).toEqual({ width: 1080, height: 1080 })
  })

  it('null = 原尺寸', () => {
    expect(exportSize(1200, 800, null)).toEqual({ width: 1200, height: 800 })
  })

  it('极端比例至少留 1px，非法上限回原尺寸', () => {
    expect(exportSize(10000, 10, 100)).toEqual({ width: 100, height: 1 })
    expect(exportSize(1200, 800, Number.NaN)).toEqual({ width: 1200, height: 800 })
    expect(exportSize(1200, 800, 0)).toEqual({ width: 1200, height: 800 })
  })
})

describe('cropRectForAspect', () => {
  it('横图裁 1:1 / 4:5 居中，宽高比正确', () => {
    const square = cropRectForAspect(1200, 800, '1:1')
    expect(square).toEqual({ x: 200, y: 0, w: 800, h: 800 })
    const portrait = cropRectForAspect(1200, 800, '4:5')
    expect(portrait.w / portrait.h).toBeCloseTo(0.8, 2)
    expect(portrait.y).toBe(0)
    expect(portrait.x).toBeGreaterThan(0)
    const landscape = cropRectForAspect(1200, 800, '4:3')
    expect(landscape).toEqual({ x: 66, y: 0, w: 1067, h: 800 })
  })

  it('竖图裁 16:9 居中，原图比例原样返回', () => {
    const wide = cropRectForAspect(800, 1200, '16:9')
    expect(wide.w).toBe(800)
    expect(wide.h).toBe(450)
    expect(wide.y).toBe(375)
    expect(cropRectForAspect(800, 1200, 'original')).toEqual({ x: 0, y: 0, w: 800, h: 1200 })
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

describe('canShareFile', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('用真实 ZIP MIME 和文件名询问文件分享能力', () => {
    const canShare = vi.fn((_data: { files?: File[] }) => true)
    vi.stubGlobal('navigator', { share: () => {}, canShare })
    expect(canShareFile(new Blob(['zip'], { type: 'application/zip' }), '成片.zip')).toBe(true)
    const file = canShare.mock.calls[0][0].files?.[0]
    expect(file?.type).toBe('application/zip')
    expect(file?.name).toBe('成片.zip')
  })
})

describe('shareImage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('把图交给系统面板，文件名要带过去', async () => {
    const share = vi.fn(async (_data: { files?: File[] }) => {})
    vi.stubGlobal('navigator', { share, canShare: () => true })
    await shareImage(new Blob(['x'], { type: 'image/jpeg' }), 'a_pinkrose.jpg')
    const arg = share.mock.calls[0][0]
    expect(arg.files?.[0].name).toBe('a_pinkrose.jpg')
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

describe('shareFile', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('把 ZIP 原样交给系统分享面板', async () => {
    const share = vi.fn(async (_data: { files?: File[] }) => {})
    vi.stubGlobal('navigator', { share })
    await expect(
      shareFile(new Blob(['zip'], { type: 'application/zip' }), '成片.zip'),
    ).resolves.toBe('shared')
    expect(share.mock.calls[0][0].files?.[0]).toMatchObject({
      name: '成片.zip',
      type: 'application/zip',
    })
  })

  it('取消分享仍按正常结束处理', async () => {
    vi.stubGlobal('navigator', {
      share: async () => { throw new DOMException('cancelled', 'AbortError') },
    })
    await expect(shareFile(
      new Blob(['zip'], { type: 'application/zip' }), '成片.zip',
    )).resolves.toBe('cancelled')
  })
})

describe('copyImage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('没有 ClipboardItem 时明确报不支持', () => {
    vi.stubGlobal('navigator', { clipboard: { write: () => {} } })
    expect(canCopyImage()).toBe(false)
  })

  it('PNG 直接放进剪贴板，保留文件内容', async () => {
    class Item {
      constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
    }
    const write = vi.fn(async (_items: Item[]) => {})
    vi.stubGlobal('ClipboardItem', Item)
    vi.stubGlobal('navigator', { clipboard: { write } })
    const blob = new Blob(['png'], { type: 'image/png' })

    expect(canCopyImage()).toBe(true)
    await copyImage(blob)

    expect(write).toHaveBeenCalledTimes(1)
    const item = write.mock.calls[0]![0][0]!
    expect(item.items['image/png']).toBe(blob)
  })
})
