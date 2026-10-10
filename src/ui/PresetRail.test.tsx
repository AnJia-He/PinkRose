// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import PresetRail, { PresetGrid } from './PresetRail.tsx'
import { PRESETS, ORIGINAL_ID, type Preset } from '../core/presets'
import { ZERO } from '../../shared/adjustments.ts'
import type { DecodedImage } from '../image/decode'

/**
 * 接线那条用例要真挂上 `usePresetThumbs`，它底下要建真预览器（要 WebGL2）——
 * 所以这里**只假掉建预览器那一层**：缩略图假成一串 dataURL，别的都是真的。
 * ⚠️ 走 `vi.hoisted`：`vi.mock` 的工厂被提到所有 import 之前跑。
 */
const fake = vi.hoisted(() => ({ n: 0 }))
vi.mock('../render/lutPreview.ts', () => ({
  createLutPreview: () => ({
    setImage: async () => {},
    render: () => `data:,${++fake.n}`,
    dispose: () => {},
  }),
}))

// ⚠️ 挂载方式照 `LutPicker.test.tsx`（act 从 'react' 进，不引 @testing-library —— 零新增依赖）
async function mount(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { createRoot(container).render(node) })
  await act(async () => {})
  return container
}

const noop = () => {}
const base = { thumbs: {}, originalThumb: null, activeId: null, mine: [] as readonly Preset[], onPick: noop, onClear: noop }
/** ★ 2026-10-10（「我的预设」）：两套"带色"的（全零的预设永远点不亮 —— 那一格是「原图」的）。 */
const MINE: readonly Preset[] = [
  { id: '501', label: '黄昏旅拍', adjustments: { ...ZERO, exposure: 33, temperature: 20 } },
  { id: '502', label: '清透日系', adjustments: { ...ZERO, exposure: -12, shadows: 18 } },
]

describe('预设栏', () => {
  it('一格一个按钮：「原图」在最前，后面跟着十二个预设', async () => {
    const c = await mount(<PresetGrid {...base} />)
    const tiles = [...c.querySelectorAll('.rail-tile')]
    expect(tiles.map(t => t.textContent)).toEqual(['原图', ...PRESETS.map(p => p.label)])
  })

  it('点某一格 → 把那一整个预设交出去（App 那边整组赋值）', async () => {
    let picked: { id: string } | undefined
    const c = await mount(<PresetGrid {...base} onPick={p => { picked = p }} />)
    await act(async () => { (c.querySelectorAll('.rail-tile')[1] as HTMLButtonElement).click() })
    expect(picked?.id).toBe(PRESETS[0]!.id)
  })

  it('点「原图」→ 走 onClear（归零参数 + 摘滤镜），不是 onPick', async () => {
    let cleared = 0
    let picked = 0
    const c = await mount(<PresetGrid {...base} onClear={() => { cleared++ }} onPick={() => { picked++ }} />)
    await act(async () => { (c.querySelectorAll('.rail-tile')[0] as HTMLButtonElement).click() })
    expect(cleared).toBe(1)
    expect(picked).toBe(0)
  })

  it('套着哪个就点亮哪个（aria-pressed 只亮一格）；用户自己调过 = 全不亮', async () => {
    const on = await mount(<PresetGrid {...base} activeId={PRESETS[3]!.id} />)
    expect([...on.querySelectorAll('.rail-tile')]
      .map(t => t.getAttribute('aria-pressed')))
      .toEqual(['false', ...PRESETS.map(p => String(p.id === PRESETS[3]!.id))])

    const tweaked = await mount(<PresetGrid {...base} activeId={null} />)
    expect([...tweaked.querySelectorAll('.rail-tile')]
      .every(t => t.getAttribute('aria-pressed') === 'false')).toBe(true)
  })

  it('「原图」也参与点亮（activeId === ORIGINAL_ID）', async () => {
    const c = await mount(<PresetGrid {...base} activeId={ORIGINAL_ID} />)
    expect(c.querySelectorAll('.rail-tile')[0]!.getAttribute('aria-pressed')).toBe('true')
  })

  /**
   * 缩略图是**异步**来的（要拿当前照片现画）。没到手时那一格只剩名字 ——
   * 画一个空 `<img>` 的话那一格会是一个破图图标，看着像"加载失败"。
   */
  it('有缩略图才画 img；没有就留占位（不画空 img）', async () => {
    const c = await mount(<PresetGrid
      {...base}
      thumbs={{ [PRESETS[0]!.id]: 'data:,x' }}
      originalThumb="data:,o" />)
    const imgs = [...c.querySelectorAll('.rail-tile img')]
    expect(imgs).toHaveLength(2)
    expect((imgs[0] as HTMLImageElement).src).toContain('data:,o')
    expect((imgs[1] as HTMLImageElement).src).toContain('data:,x')
  })

  /**
   * ★ 接线：外面交的是**照片和滤镜**，缩略图是这一栏自己去画的
   * （`usePresetThumbs`，只在挂上这一栏时才画 —— 不在调色屏时不白画十三张）。
   */
  it('★ 交照片进来：十三格（原图 + 十二）自己长出缩略图', async () => {
    const img = { bitmap: {}, width: 8, height: 8 } as unknown as DecodedImage
    const c = await mount(
      <PresetRail image={img} cube={null} mine={[]} activeId={null} onPick={noop} onClear={noop} />)
    expect(c.querySelectorAll('.rail-tile')).toHaveLength(PRESETS.length + 1)
    expect(c.querySelectorAll('.rail-tile img')).toHaveLength(PRESETS.length + 1)
  })

  /**
   * ★ 2026-10-10（「我的预设」）：自己存的那套也走**同一条画法** ——
   * 循环从 `PRESETS` 扩成 `[...PRESETS, ...mine]`，我的那格一样有像素。
   */
  it('★ 交照片 + 我的预设进来：我的那格也自己长出缩略图', async () => {
    const img = { bitmap: {}, width: 8, height: 8 } as unknown as DecodedImage
    const c = await mount(
      <PresetRail image={img} cube={null} mine={MINE} activeId={null} onPick={noop} onClear={noop} />)
    expect(c.querySelectorAll('.rail-tile')).toHaveLength(PRESETS.length + 1 + MINE.length)
    expect(c.querySelectorAll('.rail-tile img')).toHaveLength(PRESETS.length + 1 + MINE.length)
  })
})

/**
 * ★ 2026-10-10（「我的预设」· 用，设计 §5.2）：预设栏里多了「我的预设」分区 ——
 * 存过的那套用**当前这张照片**现画同款小图，点一下整套参数赋上去。
 * 判据（点亮）和内置**共用一份**：`activePresetId` 的全等匹配扩到了"内置 + 我的"，
 * 所以这里量的是"同一套判据、同一款格子"，不是又长出来一条路。
 */
describe('★ 预设栏 · 我的预设（2026-10-10）', () => {
  const tileNamed = (c: HTMLElement, name: string) =>
    [...c.querySelectorAll('.rail-tile')].find(t => t.textContent === name) as HTMLButtonElement

  it('栏里多了「我的预设」分区：存过的那套出现在里面（格子 + 名字）', async () => {
    const c = await mount(<PresetGrid {...base} mine={MINE} />)
    expect([...c.querySelectorAll('.rail-head')].map(h => h.textContent))
      .toEqual(['预设', '我的预设'])
    expect([...c.querySelectorAll('.rail-tile')].map(t => t.textContent))
      .toEqual(['原图', ...PRESETS.map(p => p.label), '黄昏旅拍', '清透日系'])
  })

  it('一套都没有时整个分区不画（现有版面零变化）', async () => {
    const c = await mount(<PresetGrid {...base} />)
    expect([...c.querySelectorAll('.rail-head')].map(h => h.textContent)).toEqual(['预设'])
    expect(c.querySelectorAll('.rail-tile')).toHaveLength(PRESETS.length + 1)
    expect(c.textContent).not.toContain('我的预设')
  })

  it('点我的那格 = 那一整套交出去（和内置同一条路，App 那边整组赋值）', async () => {
    let picked: Preset | undefined
    const c = await mount(<PresetGrid {...base} mine={MINE} onPick={p => { picked = p }} />)
    await act(async () => { tileNamed(c, '黄昏旅拍').click() })
    expect(picked?.id).toBe('501')
    // 交出去的是**那一整套参数**（App 原样 `setParams({...p.adjustments})`）
    expect(picked?.adjustments).toEqual(MINE[0]!.adjustments)
  })

  it('点完之后那一格是亮的（跨内置/我的同一套判据：activeId 全等就是它的 id）', async () => {
    const c = await mount(<PresetGrid {...base} mine={MINE} activeId="502" />)
    const lit = [...c.querySelectorAll('.rail-tile')].filter(t => t.getAttribute('aria-pressed') === 'true')
    expect(lit).toHaveLength(1)
    expect(lit[0]!.textContent).toBe('清透日系')
  })

  it('删掉一套之后栏里那格跟着消失（删光了整个分区也收掉）', async () => {
    const box = document.createElement('div')
    document.body.appendChild(box)
    const root = createRoot(box)
    const show = (mine: readonly Preset[]) =>
      act(async () => { root.render(<PresetGrid {...base} mine={mine} />) })

    await show(MINE)
    expect(tileNamed(box, '清透日系')).toBeTruthy()

    // 删掉一套（清单短了）→ 那一格跟着走，另一段（内置）一个字没动
    await show([MINE[0]!])
    expect(tileNamed(box, '清透日系')).toBeUndefined()
    expect([...box.querySelectorAll('.rail-tile')].map(t => t.textContent))
      .toEqual(['原图', ...PRESETS.map(p => p.label), '黄昏旅拍'])

    // 全删光 → 整个分区收掉（回到"一套都没有"那版版面）
    await show([])
    expect([...box.querySelectorAll('.rail-head')].map(h => h.textContent)).toEqual(['预设'])

    await act(async () => { root.unmount() })
  })
})
