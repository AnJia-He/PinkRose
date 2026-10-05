// @vitest-environment jsdom
/**
 * 预设栏那一排小图（★ 2026-10-05）：**用当前这张照片、每个预设画一张**。
 *
 * 它和滤镜格子那套（`useLuts.ensureThumbs`）是**两个**东西，别合并：
 *   · 滤镜格子画的是"**当前参数** + 每个滤镜"（打开那一栏那一刻的所见）；
 *   · 预设栏画的是"**每个预设自己的参数** + 当前滤镜" —— 点下去会发生什么，
 *     画的就是什么。
 * 所以这边的依赖里**没有 `params`**：用户拖滑块不该让这一排重画。
 *
 * ⚠️ 假掉 `../render/lutPreview`（真预览器要 WebGL2，jsdom 给不出来），
 *    `usePresetThumbs` 和它底下的 `useLutPreview` 都是真的。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePresetThumbs } from './usePresetThumbs.ts'
import { PRESETS } from '../core/presets.ts'
import { ZERO, type Adjustments } from '../../shared/adjustments.ts'
import type { Cube } from '../../shared/lut.ts'
import type { DecodedImage } from '../image/decode'

const rec = vi.hoisted(() => ({
  /** 每次 render 收下什么（顺序 = 画的顺序） */
  renders: [] as { params: Adjustments; cube: Cube | null }[],
  setImageCalls: 0,
  /** 第一趟的 setImage 卡在这儿（测"作废"用） */
  holdFirst: false,
  release: null as null | (() => void),
}))

vi.mock('../render/lutPreview.ts', () => ({
  createLutPreview: () => ({
    setImage: async () => {
      rec.setImageCalls++
      if (rec.holdFirst && rec.setImageCalls === 1) {
        await new Promise<void>((r) => { rec.release = r })
      }
    },
    render: (params: Adjustments, cube: Cube | null) => {
      rec.renders.push({ params, cube })
      return `data:,${rec.renders.length}`
    },
    dispose: () => {},
  }),
}))

const IMG_A = { bitmap: {}, width: 10, height: 10 } as unknown as DecodedImage
const IMG_B = { bitmap: {}, width: 20, height: 20 } as unknown as DecodedImage
const CUBE_1 = { size: 2, rgba: new Uint8Array(8) } as unknown as Cube
const CUBE_2 = { size: 3, rgba: new Uint8Array(27) } as unknown as Cube

let out: ReturnType<typeof usePresetThumbs> | null = null
function Probe(props: { image: DecodedImage | null; cube: Cube | null }) {
  out = usePresetThumbs(props)
  return null
}

/** 挂载 + 把异步那几拍彻底跑完（那边是一串 await，一次 act 不一定推得干净）。 */
const show = async (root: Root, props: { image: DecodedImage | null; cube: Cube | null }) => {
  await act(async () => { root.render(<Probe {...props} />) })
  await act(async () => {})
  await act(async () => {})
}

const mount = async (props: { image: DecodedImage | null; cube: Cube | null }) => {
  const root = createRoot(document.createElement('div'))
  await show(root, props)
  return root
}

describe('usePresetThumbs', () => {
  beforeEach(() => {
    rec.renders = []
    rec.setImageCalls = 0
    rec.holdFirst = false
    rec.release = null
    out = null
  })

  it('没照片：一张都不画（空手等图）', async () => {
    const root = await mount({ image: null, cube: null })
    expect(rec.renders).toHaveLength(0)
    expect(out!.thumbs).toEqual({ original: null, byId: {} })
    await act(async () => { root.unmount() })
  })

  it('有照片：先画「原图」（全零、不挂滤镜），再每个预设各一张 —— 十二个一张不少', async () => {
    const root = await mount({ image: IMG_A, cube: null })
    expect(rec.renders[0]!.params).toEqual(ZERO)
    expect(rec.renders[0]!.cube).toBeNull()
    expect(rec.renders).toHaveLength(PRESETS.length + 1)
    // 每一张画的都是**那一个预设自己的参数**（不是当前参数 + 预设）
    for (const [i, p] of PRESETS.entries()) {
      expect(rec.renders[i + 1]!.params, `${p.id} 那一张画错了参数`).toEqual(p.adjustments)
    }
    // 结果按预设 id 落在状态里
    expect(Object.keys(out!.thumbs.byId).sort()).toEqual(PRESETS.map(p => p.id).sort())
    await act(async () => { root.unmount() })
  })

  it('★ 挂着滤镜时，十二张风格图**每一张都带上那个滤镜**（点下去就是这个结果）', async () => {
    const root = await mount({ image: IMG_A, cube: CUBE_1 })
    // 第一张是「原图」——它是唯一一张**故意不带滤镜**的：点它就是回到什么都没有
    expect(rec.renders[0]!.cube).toBeNull()
    for (const r of rec.renders.slice(1)) expect(r.cube).toBe(CUBE_1)
    await act(async () => { root.unmount() })
  })

  it('换了滤镜：整排重画一遍，且这一趟带的是新的 cube', async () => {
    const root = await mount({ image: IMG_A, cube: CUBE_1 })
    const before = rec.renders.length
    await show(root, { image: IMG_A, cube: CUBE_2 })
    const fresh = rec.renders.slice(before)
    expect(fresh).toHaveLength(PRESETS.length + 1)
    expect(fresh[0]!.cube).toBeNull()
    for (const r of fresh.slice(1)) expect(r.cube).toBe(CUBE_2)
    await act(async () => { root.unmount() })
  })

  it('换了照片：重新取图 + 整排重画', async () => {
    const root = await mount({ image: IMG_A, cube: null })
    const before = rec.renders.length
    await show(root, { image: IMG_B, cube: null })
    expect(rec.setImageCalls).toBe(2)
    expect(rec.renders.length).toBe(before * 2)
    await act(async () => { root.unmount() })
  })

  /**
   * ★ 作废：上一趟还没画完，用户已经换了一张照片 —— 那一趟的**结果**
   * 一个字都不许写进状态（写进去的话，新照片下面挂着一半是旧照片画的小图，
   * 而屏幕上看着一切正常）。同 `useLuts.ensureThumbs` 里那条 `seq` 守卫。
   */
  it('★ 上一趟跑到一半被换掉：它画出来的东西不许写进状态', async () => {
    rec.holdFirst = true
    const root = createRoot(document.createElement('div'))
    await act(async () => { root.render(<Probe image={IMG_A} cube={null} />) })
    // 第一趟卡在 setImage 上，什么都还没画
    expect(rec.renders).toHaveLength(0)

    // 换照片：第二趟跑完
    await show(root, { image: IMG_B, cube: null })
    const good = out!.thumbs
    expect(Object.keys(good.byId)).toHaveLength(PRESETS.length)

    // 现在放第一趟继续 —— 它必须自己停住
    await act(async () => { rec.release?.() })
    await act(async () => {})
    expect(rec.renders).toHaveLength(PRESETS.length + 1)   // 只有第二趟画的那 13 张
    expect(out!.thumbs).toEqual(good)                      // 状态一个字没变
    await act(async () => { root.unmount() })
  })
})
