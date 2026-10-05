// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import PresetRail, { PresetGrid } from './PresetRail.tsx'
import { PRESETS, ORIGINAL_ID } from '../core/presets'
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
const base = { thumbs: {}, originalThumb: null, activeId: null, onPick: noop, onClear: noop }

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
      <PresetRail image={img} cube={null} activeId={null} onPick={noop} onClear={noop} />)
    expect(c.querySelectorAll('.rail-tile')).toHaveLength(PRESETS.length + 1)
    expect(c.querySelectorAll('.rail-tile img')).toHaveLength(PRESETS.length + 1)
  })
})
