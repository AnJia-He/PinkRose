// @vitest-environment jsdom
/**
 * `Canvas` 那条**渲染 effect 的依赖守卫**（★ 2026-10-05 滤镜 T8 审查 Critical-1）。
 *
 * 守的是这一个形状：`pipeline.setLut` **只上传纹理**、记下"装没装"，
 * **它自己一帧都不画**（`drawArrays` 只在 `render` 里）。而 cube 是**异步**到手的
 * （取文件 → 解析），那一刻变的只有 `lutCube`、强度一点没动 —— 渲染那条 effect
 * 要是没把 `lutCube` 放进依赖，它就**一次都不跑**：用户眼前"选了滤镜没反应"，
 * 得去拖任何一根滑块画面才突然出现，**全程不报错**。
 *
 * ⚠️ 为什么另开一个文件、而且**只假掉 `../render/pipeline`**：`App.test.tsx`
 * 把整个 `Canvas` 假掉了（真 Canvas 要 WebGL2，jsdom 给不出来），所以那条路
 * 根本走不到这个效果。这里假掉的是**构造那一层**（真管线要 GL 上下文），
 * Canvas 组件本身是真的、两个 effect 都是真的。
 *
 * 反方向那一条也在这儿钉着：**拖强度不许重传纹理** —— 它是同一个坑的另一半
 * （谁把 `lutAmount` 塞进 `setLut` 那条的依赖，真机上就是每帧重传 1MB 的 3D 纹理）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import type { Cube } from '../../shared/lut.ts'
import type { DecodedImage } from '../image/decode'

/** 假管线记下来的东西 —— 断言只认这三样。 */
type Recorded = {
  images: unknown[]
  lutCalls: (Cube | null)[]
  renders: [unknown, number][]
}

/** ⚠️ 走 `vi.hoisted`：`vi.mock` 的工厂被提到所有 import 之前跑（同 `App.test.tsx` 的 `canvasProps`）。 */
const made = vi.hoisted(() => [] as Recorded[])
/**
 * 管线被调用的**顺序**（只记这两样）。用来钉"**同一次提交里先传纹理、再画**"——
 * 光数次数钉不住它：谁把两条 effect 对调，cube 到位那一次会**先按旧纹理画一帧**，
 * 而依赖里已经有 `lutCube`、之后不会再重画 —— 症状和 Critical-1 一模一样
 * （停在"没滤镜"那一帧），而只数次数的四条用例**全绿**（2026-10-05 复审指出的缺口）。
 */
const order = vi.hoisted(() => [] as string[])

vi.mock('../render/pipeline', () => ({
  TonePipeline: class {
    rec: Recorded
    constructor() {
      this.rec = { images: [], lutCalls: [], renders: [] }
      made.push(this.rec)
    }
    setImage(img: unknown) { this.rec.images.push(img) }
    resizeToImage() {}
    setLut(c: Cube | null) { this.rec.lutCalls.push(c); order.push('setLut') }
    render(params: unknown, amount = 0) { this.rec.renders.push([params, amount]); order.push('render') }
    dispose() {}
  },
}))

import Canvas from './Canvas'

/** 参数必须是**同一个对象**（放在模块级）：现造一个 `{...ZERO}` 的话，
 *  每次画都换身份，那条渲染 effect 会因为 `params` 变了而重跑 ——
 *  下面"只动强度"那几条就分不清是哪个依赖在起作用了。 */
const P = { ...ZERO }
const IMG = { bitmap: {} as ImageBitmap, width: 1200, height: 800 } as DecodedImage
const CUBE: Cube = {
  size: 2, rgba: new Uint8Array(32), domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: null,
}
const CUBE2: Cube = { ...CUBE }          // 另一个身份 = 换了一个滤镜
/** `onFail` 也要稳定：它进了 `report`，而 `report` 一变管线会**整个重建**。 */
const noFail = () => {}

let container: HTMLDivElement
let root: Root
const canvasRef: { current: HTMLCanvasElement | null } = { current: null }

/** 画一帧（和真 App 一样，一次渲染 = 一组 props）。 */
const draw = (lutCube: Cube | null, lutAmount: number) => act(async () => {
  root.render(
    <Canvas image={IMG} params={P} lutCube={lutCube} lutAmount={lutAmount}
      originalPreview={null} canvasRef={canvasRef} onFail={noFail} />,
  )
})
/** 这一趟用的那条假管线。 */
const pipe = () => made[0]!

beforeEach(() => {
  made.length = 0
  order.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Canvas 与滤镜（依赖守卫）', () => {
  it('★ cube 到手之后画面要**自己重画** —— 只换纹理不算数', async () => {
    await draw(null, 0)
    expect(made).toHaveLength(1)                 // 管线只建了一条（`report` 稳定）
    expect(pipe().renders).toHaveLength(1)       // 挂载时那一帧
    expect(pipe().lutCalls.at(-1)).toBeNull()    // 没滤镜 = 占位纹理

    // 这就是"异步到手"的形状：**强度一点没动、只有 cube 变了**
    await draw(CUBE, 0)
    expect(pipe().lutCalls.at(-1)).toBe(CUBE)    // 纹理确实换了
    // ⚠️ 这一句是这条用例的全部意义：变异（渲染那条依赖里去掉 `lutCube`）→ 它停在 1，
    //    而台上什么都没坏、只是一直画着"没滤镜"那一帧，等用户去拖根滑块才出现。
    expect(pipe().renders).toHaveLength(2)
    expect(pipe().renders.at(-1)![0]).toBe(P)
  })

  it('★ 换一个滤镜（强度不变）也要重画', async () => {
    await draw(CUBE, 100)
    expect(pipe().renders).toHaveLength(1)
    await draw(CUBE2, 100)
    expect(pipe().lutCalls.at(-1)).toBe(CUBE2)
    expect(pipe().renders).toHaveLength(2)
  })

  it('★ 拖强度：重画，但**不许**再传一次纹理（那是每帧 1MB）', async () => {
    await draw(CUBE, 100)
    const lutCalls = pipe().lutCalls.length
    const renders = pipe().renders.length

    await draw(CUBE, 55)                         // 同一个 cube、只有强度变了
    expect(pipe().renders.length).toBe(renders + 1)     // 画面跟着走
    // ⚠️ 变异（`setLut` 那条的依赖里塞进 `lutAmount`）→ 这一句红。
    //    真机上的后果是拖一次滑块重传一遍 1MB 的 3D 纹理，而画面**看起来正常**。
    expect(pipe().lutCalls.length).toBe(lutCalls)
    // 强度真的送到了 `render`（不是传了个寂寞）
    expect(pipe().renders.at(-1)).toEqual([P, 55])
  })

  it('★ 同一次提交里：**先传纹理、再画**（顺序反了那一帧就是旧纹理）', async () => {
    // ⚠️ 这条守的不是次数、是**顺序**：`setLut` 和渲染是两条 effect，挂载时按
    //    **声明顺序**跑。谁把它们对调，cube 到位那一次就会先 `render`（按旧纹理
    //    画一帧）、再 `setLut`，而渲染那条的依赖里已经有 `lutCube` —— **不会重画**，
    //    屏幕永远停在那一帧。症状和 Critical-1 一模一样，而上面那几条只数次数、
    //    照样全绿（2026-10-05 复审点出的缺口）。
    await draw(null, 0)
    expect(order).toEqual(['setLut', 'render'])      // 挂载那一次也先传后画

    order.length = 0
    await draw(CUBE, 0)                              // cube 到位：只有这两下该发生
    expect(order).toEqual(['setLut', 'render'])
  })

  it('换照片：纹理、画布尺寸、画面都跟着走（既有行为一寸没动）', async () => {
    await draw(CUBE, 100)
    expect(pipe().images).toHaveLength(1)
    expect(pipe().renders).toHaveLength(1)

    const IMG2 = { bitmap: {} as ImageBitmap, width: 800, height: 600 } as DecodedImage
    await act(async () => {
      root.render(
        <Canvas image={IMG2} params={P} lutCube={CUBE} lutAmount={100}
          originalPreview={null} canvasRef={canvasRef} onFail={noFail} />,
      )
    })
    expect(pipe().images).toHaveLength(2)
    expect(pipe().renders).toHaveLength(2)
  })
})
