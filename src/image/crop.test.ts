// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cropToBitmap } from './crop'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('cropToBitmap', () => {
  it('拿不到 2D 上下文时说人话，不静默返回空图', async () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(cropToBitmap({} as ImageBitmap, { rect: { x: 0, y: 0, w: 1, h: 1 }, angle: 0 }, 0))
      .rejects.toThrow(/裁剪/)
    spy.mockRestore()
  })

  it('★「反过来画」的四步：调用序列和参数逐个钉住（这层错了不报错）', async () => {
    // 为什么值得一条专门的守卫：**预览与成片同向**是这层唯一的隐形契约 ——
    // `rotate` 写成 `+θ` 时外框尺寸、输出尺寸、四角排布**两边一模一样**，
    // 单测 / typecheck / build / check:layout 全都看不出来（只有真机四色卡探针
    // 才撞得到，见 `image/crop.ts` 文件头那段方向约定）。本仓的账：
    // **一个从来没红过的守卫不算守卫** —— 所以这条用假的 2D 上下文记下
    // 调用序列 + 参数，写反了、基准点挪了、drawImage 忘了居中都当场红。
    //
    // ⚠️ **不许**在这里用 `rotatedBounds` / `effectiveAngle` 把期望值重算一遍
    //   （那是把实现抄进断言 —— 实现对，断言必对；实现错，两边一起错）。
    //   下面那些数**是手算的**：底图 1200×800、矫正角 10°，
    //   外框 = (1200·cos10° + 800·sin10°, 1200·sin10° + 800·cos10°)
    //        = (1320.68785…, 996.22402…)，框 = 外框的 (0.25, 0.5) 起 0.5×0.25。
    const calls: (readonly unknown[])[] = []
    const ctx = {
      imageSmoothingQuality: '',
      translate: (...a: number[]) => { calls.push(['translate', ...a]) },
      rotate: (...a: number[]) => { calls.push(['rotate', ...a]) },
      drawImage: (...a: unknown[]) => { calls.push(['drawImage', ...a]) },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    const out = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap
    vi.stubGlobal('createImageBitmap', vi.fn(async () => out))

    const source = { width: 1200, height: 800 } as ImageBitmap
    await cropToBitmap(
      source, { rect: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, angle: 10 }, 0)

    // ① 序列：两步 translate → 一步 rotate → 一步 drawImage，中间不许插别的
    expect(calls.map(c => c[0])).toEqual(['translate', 'translate', 'rotate', 'drawImage'])
    // ② 第一步把"框左上角在外框里的像素"挪回原点：-(0.25×1320.6878…, 0.5×996.2240…)
    expect(calls[0]![1]).toBeCloseTo(-330.1719614, 6)
    expect(calls[0]![2]).toBeCloseTo(-498.1120078, 6)
    // ③ 第二步挪到外框中心：外框的一半
    expect(calls[1]![1]).toBeCloseTo(660.3439229, 6)
    expect(calls[1]![2]).toBeCloseTo(498.1120078, 6)
    // ④ 第三步 **`-θ`**（θ=10° ⇒ -0.1745329252 rad）：
    //    canvas 的 y 朝下，"转坐标系 -θ"画出来才是照片逆时针转 θ ——
    //    和 `ui/Canvas` 预览那条 CSS `rotate(-θ)` 同一个方向。**符号反了这条红。**
    expect(calls[2]![1]).toBeCloseTo(-0.1745329252, 9)
    // ⑤ 第四步画的是**同一张底图**、而且以它自己的中心对齐（-imgW/2, -imgH/2）
    expect(calls[3]![1]).toBe(source)
    expect(calls[3]![2]).toBe(-600)
    expect(calls[3]![3]).toBe(-400)
  })
})
