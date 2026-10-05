// @vitest-environment jsdom
/**
 * 离屏预览器的生命周期（★ 2026-10-05）。
 *
 * 抽这个 hook 是为了让**两块缩略图**（滤镜格子 / 预设栏）各拿一个实例、
 * 共用同一套"懒建 + 卸载时 dispose"的写法 —— 各写一份的话，两边迟早有一边
 * 忘掉下面这条：
 *
 * ⚠️⚠️ **StrictMode 会把"挂载 → 卸载 → 再挂载"整个重放一遍**。在 effect 里建、
 *    在 cleanup 里 dispose 的那种写法，第二次挂载拿到的是一个**已经 dispose
 *    过的实例** —— 而它看起来完全正常（对象在、方法在），要到真渲染时才炸。
 *    所以这里判的是：卸载之后再挂载，**必须是新对象**。
 *
 * ⚠️ 假掉的是 `../render/lutPreview`（建它要真 WebGL2，jsdom 给不出来），
 *    这个 hook 本身是真的。第一模块级变量照 `Canvas.test.tsx` 的 `vi.hoisted`。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLutPreview } from './useLutPreview.ts'
import type { LutPreview } from '../render/lutPreview.ts'

const made = vi.hoisted(() => ({ created: 0, disposed: 0, last: null as unknown }))

vi.mock('../render/lutPreview.ts', () => ({
  createLutPreview: () => {
    made.created++
    const self = {
      setImage: async () => {},
      render: () => null,
      dispose: () => { made.disposed++ },
    }
    made.last = self
    return self
  },
}))

/** 渲染时把这个 hook 交出来的取值函数记在模块级 —— 测试外面拿得到。 */
let get: (() => LutPreview) | null = null
function Probe() {
  get = useLutPreview()
  return null
}

const mount = async () => {
  const root = createRoot(document.createElement('div'))
  await act(async () => { root.render(<Probe />) })
  return root
}

describe('useLutPreview', () => {
  beforeEach(() => { made.created = 0; made.disposed = 0; get = null })

  it('同一趟里连调两次，拿到的是**同一个**实例（每次新建 = 多占一个 WebGL 上下文）', async () => {
    const root = await mount()
    expect(get!()).toBe(get!())
    expect(made.created).toBe(1)
    await act(async () => { root.unmount() })
  })

  it('卸载时把**建出来的那个** dispose 掉', async () => {
    const root = await mount()
    get!()                       // 得先要过 —— 懒建：没人要过就没有东西可 dispose
    await act(async () => { root.unmount() })
    expect(made.disposed).toBe(1)
  })

  it('★ 卸载之后再挂载：拿到的是**新**实例，不是已经 dispose 过的那个', async () => {
    const first = await mount()
    const before = get!()
    await act(async () => { first.unmount() })

    const second = await mount()
    expect(get!()).not.toBe(before)
    expect(made.created).toBe(2)
    await act(async () => { second.unmount() })
  })
})
