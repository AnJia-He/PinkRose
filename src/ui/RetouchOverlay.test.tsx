// @vitest-environment jsdom
/**
 * 照片上的**涂抹层**（★ 2026-10-07，点修）—— 把指针换算成图片像素、往掩码里盖章。
 *
 * 驱动方式和 `CropOverlay.test.tsx` / `Canvas.zoom.test.tsx` 同款：
 * `createRoot` + `act`，指针事件用 `MouseEvent('pointerdown' …)` 派
 * （jsdom 里没有真的 PointerEvent）；拖动中的监听挂在 window 上 —— move/up 往 window 派。
 *
 * ⚠️ 屏幕 → 图片的换算是这一层**唯一**容易静默错的地方（落章位置错了屏幕上
 * 只看得出"涂到了别处"，看不出"算错了"）——所以规格全用**手算的整数**：
 * 盒子 800×600、图片 1600×1200（正好 2 倍），屏幕 (400,300) ⇒ 图片 (800,600)。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RetouchOverlay from './RetouchOverlay'
import { stampBrush } from '../core/retouch'

const BOX = { left: 0, top: 0, width: 800, height: 600 }
const IMG_W = 1600
const IMG_H = 1200

/** jsdom 没有排版：所有元素统一量成"原点在 0,0"（换算只吃 left/top）。
 *  canvas 的 2D 上下文**故意给 null**（jsdom 不带 canvas 包，直接调它会往
 *  控制台喷 "Not implemented"）——组件对 null 上下文有守卫，掩码照画不误。 */
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => { vi.restoreAllMocks() })

const roots: { root: Root; container: HTMLElement }[] = []
afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
})

async function mount(opts: {
  radius?: number
  mode?: 'paint' | 'erase'
  mask?: Uint8Array
} = {}) {
  const mask = opts.mask ?? new Uint8Array(IMG_W * IMG_H)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const changed = vi.fn()
  await act(async () => {
    root.render(
      <RetouchOverlay
        box={BOX} imageWidth={IMG_W} imageHeight={IMG_H}
        radius={opts.radius ?? 20} mode={opts.mode ?? 'paint'}
        mask={mask} onMaskChange={changed}
      />,
    )
  })
  roots.push({ root, container })
  const layer = () => container.querySelector('.retouch') as HTMLElement
  return { container, mask, changed, layer }
}

const down = (el: Element, clientX: number, clientY: number) =>
  act(async () => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX, clientY })) })
const move = (clientX: number, clientY: number) =>
  act(async () => { window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX, clientY })) })
const up = () =>
  act(async () => { window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })) })

/** 掩码里非零像素个数。 */
const ink = (m: Uint8Array) => m.reduce((n, v) => n + (v ? 1 : 0), 0)
const at = (m: Uint8Array, x: number, y: number) => m[y * IMG_W + x]!

describe('RetouchOverlay', () => {
  it('★ 换算口径：屏幕 (400,300) 落章 = 图片 (800,600) 的正中间', async () => {
    const c = await mount({ radius: 20 })
    await down(c.layer(), 400, 300)
    expect(at(c.mask, 800, 600)).toBeGreaterThan(0)
    // 差得远的地方一个字节都没有
    expect(at(c.mask, 100, 100)).toBe(0)
    expect(ink(c.mask)).toBeGreaterThan(0)
  })

  it('★ 快速拖动连成一笔：两个相隔很远的点之间一路都盖上章', async () => {
    const c = await mount({ radius: 12 })
    await down(c.layer(), 200, 150)     // → 图片 (400,300)
    await move(600, 450)                // → 图片 (1200,900)
    await up()
    // 对角线上的四等分点都得有墨
    for (const [x, y] of [[400, 300], [600, 450], [800, 600], [1000, 750], [1200, 900]] as const) {
      if (!at(c.mask, x, y)) throw new Error(`笔画在图片 (${x},${y}) 处断了`)
    }
  })

  it('按下发生在照片外面（左侧留白）→ 一笔都不落，之后的移动也不画', async () => {
    const c = await mount()
    await down(c.layer(), -50, 300)
    await move(400, 300)
    await up()
    expect(ink(c.mask)).toBe(0)
    expect(c.changed).not.toHaveBeenCalled()
  })

  it('橡皮模式：擦过的地方真的下去', async () => {
    const mask = new Uint8Array(IMG_W * IMG_H)
    stampBrush(mask, IMG_W, IMG_H, 800, 600, 80, 'paint')
    const c = await mount({ mask, mode: 'erase', radius: 40 })
    expect(at(c.mask, 800, 600)).toBeGreaterThan(0)
    await down(c.layer(), 400, 300)
    expect(at(c.mask, 800, 600)).toBe(0)
  })

  it('松手之后再动鼠标不落章（笔只画在按着的这段时间里）', async () => {
    const c = await mount({ radius: 12 })
    await down(c.layer(), 400, 300)
    await up()
    const before = ink(c.mask)
    await move(600, 450)
    expect(ink(c.mask)).toBe(before)
  })

  it('掩码有改动时喊 onMaskChange（App 拿它让「擦掉这里」亮起来）', async () => {
    const c = await mount()
    await down(c.layer(), 400, 300)
    expect(c.changed).toHaveBeenCalled()
  })

  it('画笔光标圈跟着半径走（屏幕尺寸 = 图片半径 × 显示比例 × 2）', async () => {
    const c = await mount({ radius: 40 })
    await act(async () => {
      c.layer().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 400, clientY: 300 }))
    })
    const cur = c.container.querySelector('.retouch-cursor') as HTMLElement
    expect(cur).not.toBeNull()
    // 图片 1600 宽显示在 800px 里 → 比例 0.5；半径 40 → 屏幕直径 40px
    expect(cur.style.width).toBe('40px')
    expect(cur.style.height).toBe('40px')
    expect(cur.style.left).toBe('400px')
    expect(cur.style.top).toBe('300px')
  })
})
