// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eraseToBitmap } from './erase'
import { createMask, stampBrush } from '../core/retouch'

/**
 * 点修「擦掉这里」的**像素落点**：把掩码交给修补笔（`image/heal`），
 * 产出一张新底图。
 * 画布这一层在 jsdom 里是假的（和 `image/crop.test.ts` 一个套路：
 * 记下 getImageData / putImageData 的调用和内容，行为靠真照片探针再验一遍）。
 */

/** 造一张 w×h 的假 ImageData：横向渐变，全不透明。 */
function fakeImage(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      data[i] = x * 4
      data[i + 1] = 100
      data[i + 2] = 200
      data[i + 3] = 255
    }
  }
  return { data, width: w, height: h } as unknown as ImageData
}

/** 装一台假的 2D 上下文：drawImage 记数、getImageData 给图、putImageData 存结果。 */
function fakeCtx(img: ImageData, calls: string[]) {
  let put: ImageData | null = null
  const ctx = {
    imageSmoothingQuality: '',
    drawImage: (...a: unknown[]) => { calls.push(`drawImage:${(a[0] as ImageBitmap).width}`) },
    getImageData: () => { calls.push('getImageData'); return img },
    putImageData: (d: ImageData) => { calls.push('putImageData'); put = d },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, got: () => put }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('eraseToBitmap', () => {
  it('拿不到 2D 上下文时说人话，不静默返回一张空图', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const mask = createMask(20, 20)
    await expect(eraseToBitmap({ width: 20, height: 20 } as ImageBitmap, mask))
      .rejects.toThrow(/擦/)
  })

  it('小斑块：走修补笔，掩码外逐字节不动、掩码内被改写', async () => {
    // ⚠️ 图不能太小：选路看的是"外接框 ÷ 画面面积"，60×40 上半径 6 的笔刷
    //    外扩后就过了 8% 线（等于真实照片上涂了半径 400px 的一大坨）。
    const w = 300, h = 200
    const img = fakeImage(w, h)
    const calls: string[] = []
    const { ctx, got } = fakeCtx(img, calls)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx)
    const out = { width: w, height: h, close: vi.fn() } as unknown as ImageBitmap
    vi.stubGlobal('createImageBitmap', vi.fn(async () => out))

    const mask = createMask(w, h)
    stampBrush(mask, w, h, 150, 100, 6, 'paint')

    const res = await eraseToBitmap({ width: w, height: h } as ImageBitmap, mask)

    expect(res.bitmap).toBe(out)
    expect(calls).toEqual([`drawImage:${w}`, 'getImageData', 'putImageData'])
    const outData = got()!.data
    // 掩码外逐字节不动 —— ⚠️ 外扩会把圈放大几像素，检查点要离得够远
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - 150, y - 100) <= 12) continue
        const i = (y * w + x) * 4
        if (outData[i] !== img.data[i] || outData[i + 1] !== img.data[i + 1]) {
          throw new Error(`离掩码很远的地方被改了：(${x},${y})`)
        }
      }
    }
    // 掩码中心：断言"函数真的把引擎结果写了回去"（渐变上的修补和原值可能很接近，
    // 逐像素质量的账在真照片探针那边），这里看覆盖数和 alpha 还在。
    expect(res.coverage).toBeGreaterThan(0)
    expect(outData[(100 * w + 150) * 4 + 3]).toBe(255)
  })

  it('空掩码：一个引擎都不跑、不回写画布（安全网，UI 那边按钮本来就禁用）', async () => {
    const w = 20, h = 20
    const img = fakeImage(w, h)
    const calls: string[] = []
    const { ctx } = fakeCtx(img, calls)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
    const out = { width: w, height: h, close: vi.fn() } as unknown as ImageBitmap
    vi.stubGlobal('createImageBitmap', vi.fn(async () => out))

    const res = await eraseToBitmap({ width: w, height: h } as ImageBitmap, createMask(w, h))

    expect(res.coverage).toBe(0)
    // 没有 putImageData：画布上还是 drawImage 画进去的原样
    expect(calls).toEqual([`drawImage:${w}`, 'getImageData'])
  })

  it('掩码尺寸和底图对不上：明说（这是编程错误，别把像素搞乱）', async () => {
    const img = fakeImage(20, 20)
    const calls: string[] = []
    const { ctx } = fakeCtx(img, calls)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({} as ImageBitmap)))

    await expect(eraseToBitmap({ width: 20, height: 20 } as ImageBitmap, createMask(10, 10)))
      .rejects.toThrow(/掩码/)
  })
})
