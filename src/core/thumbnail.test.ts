// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Sizable } from '../image/prepare'
import { MAX_DIMENSION } from '../../shared/size.ts'
import { bitmapToDataUrl } from './thumbnail'

const src = (width: number, height: number) => ({ width, height }) as unknown as Sizable

/**
 * `bitmapToDataUrl` = 建会话时送出去的**原图**字节（Task 4）。
 *
 * 它身上只有一件事值得钉：**先压到 `MAX_DIMENSION`，再按 JPEG 0.92 编码**。
 * jsdom 给不出 2D 画布（`getContext('2d')` 回 null、真 `toDataURL` 回 `'data:,'`
 * 还往控制台刷 "Not implemented"），所以把这两个方法换成**记录用的假货** ——
 * 这一条本来要看的也不是像素，是"画了多大、按什么格式编的"。
 */
function stubCanvas(transparent = false) {
  const drawn: Array<[number, number]> = []
  const coded: Array<{ type?: string; quality?: number }> = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    // `drawImage(source, dx, dy, dw, dh)` —— 只看目标宽高（第 3、4 个参数）
    drawImage: (...args: unknown[]) => { drawn.push([args[3] as number, args[4] as number]) },
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, transparent ? 0 : 255]) }),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
    (type?: string, quality?: number) => {
      coded.push({ type, quality })
      return `data:${type};base64,xxx`
    })
  return { drawn, coded }
}

afterEach(() => { vi.restoreAllMocks() })

describe('bitmapToDataUrl：送服务端的原图', () => {
  it('★ 6000px 的照片**不许整张上桌** —— 压到长边 2048，再按 JPEG 0.92 编', () => {
    // 为什么这一条要紧（2026-10-01 评审）：画布只按**设备 WebGL 上限**缩过，
    // 桌面上那就是 16384 —— 不压的话这一条路会把整张 ≥24 MP 的照片送出去，
    // 撞服务端 8 MB 那条线（`MAX_IMAGE_BYTES`）→ **413** → 建会话失败，
    // 而用户看到的是「存不下来」（指错了地方）。
    const { drawn, coded } = stubCanvas()

    expect(bitmapToDataUrl(src(6000, 4000))).toBe('data:image/jpeg;base64,xxx')

    // 长边压到 2048，另一边按比例（4000 × 2048/6000 = 1365.33 → 1365）
    expect(drawn).toEqual([[MAX_DIMENSION, 1365]])
    // 0.92 是"存下来接着改"的画质，不是缩略图的 0.7 —— 变异成 0.7 → 这一句红
    expect(coded).toEqual([{ type: 'image/jpeg', quality: 0.92 }])
  })

  it('落盘那趟（画质传 0.9）：帽子是**同一顶** —— 4096² 的底图也压到 2048', () => {
    // 落盘送的底图走同一个函数、只是画质传 0.9（见 `App.tsx` 落盘副作用）。
    // 4096² 在这儿代表生成那条偏差分支的产物（"提供方回的图比声明的更大"）——
    // 不压的话 JPEG 0.9 能顶到服务端 8MB 那条线。
    const { drawn, coded } = stubCanvas()

    bitmapToDataUrl(src(4096, 4096), 0.9)

    expect(drawn).toEqual([[MAX_DIMENSION, MAX_DIMENSION]])
    expect(coded).toEqual([{ type: 'image/jpeg', quality: 0.9 }])
  })

  it('压的是**长边** —— 竖图 4000×6000 出来是 1365×2048', () => {
    const { drawn } = stubCanvas()
    bitmapToDataUrl(src(4000, 6000))
    expect(drawn).toEqual([[1365, MAX_DIMENSION]])
  })

  it('只缩不放 —— 1400×900 原样过（放大是白费字节）', () => {
    const { drawn } = stubCanvas()
    bitmapToDataUrl(src(1400, 900))
    expect(drawn).toEqual([[1400, 900]])
  })

  it('★ 底图有透明像素 → 改存 PNG；普通照片仍走 JPEG', () => {
    const clear = stubCanvas(true)
    expect(bitmapToDataUrl(src(1200, 800))).toBe('data:image/png;base64,xxx')
    expect(clear.coded).toEqual([{ type: 'image/png', quality: undefined }])
  })
})
