import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** 真的 `TonePipeline` 一构造就要 WebGL2 上下文，node 环境里没有。
 *  这里只关心「做了几次活」，所以整个假掉 —— 真管线长什么样由 pipeline.test 管。 */
vi.mock('./pipeline', () => ({
  TonePipeline: class {
    setImage() {}
    resizeToImage() {}
    setLut() {}
    render() {}
    dispose() {}
  },
}))

import { coverCrop, createLutPreview } from './lutPreview.ts'

describe('coverCrop', () => {
  it('横图：裁左右', () => {
    expect(coverCrop(400, 200, 100, 100)).toEqual({ sx: 100, sy: 0, sw: 200, sh: 200 })
  })
  it('竖图：裁上下', () => {
    expect(coverCrop(200, 400, 100, 100)).toEqual({ sx: 0, sy: 100, sw: 200, sh: 200 })
  })
  it('正好方形：一个像素都不裁', () => {
    expect(coverCrop(300, 300, 100, 100)).toEqual({ sx: 0, sy: 0, sw: 300, sh: 300 })
  })
})

/**
 * 缩略图渲染器里唯一能在 node 环境里验的部分：**「同一张照片不重做」这条承诺**。
 *
 * 它测的是**做了几次活**，所以把两件真正的重活假掉：
 *   · `document.createElement('canvas')` —— node 里没有 DOM；
 *   · `createImageBitmap` —— 派生出那张 256px 小图。
 * 数它们的调用次数就等于数"重缩 + 重建位图"发生了几次。
 *
 * 为什么不靠真画布：要真 canvas/WebGL 才能跑，那属于 Task 13 的真机探针；
 * 这里要钉的只是一条短路逻辑。
 */
type FakeCanvas = {
  width: number
  height: number
  getContext: (id: string) => { drawImage: () => void }
  toDataURL: () => string
}

const makeFakeCanvas = (): FakeCanvas => ({
  width: 0,
  height: 0,
  getContext: () => ({ drawImage: () => {} }),
  toDataURL: () => 'data:image/jpeg;base64,AA==',
})

/** 造一张"照片"：`bitmap` 的身份就是判重的依据（对象身份，不是内容）。 */
const makeImage = (bitmap: unknown) => ({
  bitmap: bitmap as unknown as ImageBitmap,
  width: 800,
  height: 600,
})

let createImageBitmapSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  createImageBitmapSpy = vi.fn(async () => ({ close: vi.fn() }))
  vi.stubGlobal('createImageBitmap', createImageBitmapSpy)
  vi.stubGlobal('document', { createElement: () => makeFakeCanvas() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LutPreview.setImage —— 同一张不重做', () => {
  it('同一张照片连调两次 setImage：只重缩一次、只建一次位图', async () => {
    const preview = createLutPreview()
    const img = makeImage({ tag: 'photo-A' })

    await preview.setImage(img)
    await preview.setImage(img)

    expect(createImageBitmapSpy).toHaveBeenCalledTimes(1)
    preview.dispose()
  })

  it('换了另一张照片：必须重做（否则画面还停在上一张）', async () => {
    const preview = createLutPreview()

    await preview.setImage(makeImage({ tag: 'photo-A' }))
    await preview.setImage(makeImage({ tag: 'photo-B' }))

    expect(createImageBitmapSpy).toHaveBeenCalledTimes(2)
    preview.dispose()
  })

  it('dispose 之后再喂同一张：要重新做（不然管线空着、照画还是老画面）', async () => {
    const preview = createLutPreview()
    const img = makeImage({ tag: 'photo-A' })

    await preview.setImage(img)
    preview.dispose()
    await preview.setImage(img)

    expect(createImageBitmapSpy).toHaveBeenCalledTimes(2)
    preview.dispose()
  })
})
