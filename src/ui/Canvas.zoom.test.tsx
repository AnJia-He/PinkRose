// @vitest-environment jsdom
/**
 * 照片的**缩放 / 平移**（★ 2026-10-06）—— 组件这一层的接线。
 *
 * 数学在 `viewport.test.ts`（那边是数字对数字）；这里只钉接线：
 * 手势挂上了没有、什么时候**不该**动、按钮在不在、什么时候归位。
 *
 * ⚠️ jsdom 里**所有盒子都是 0×0**，而这一整套东西全靠盒子说话 —— 所以下面把
 * `getBoundingClientRect` 整个换掉（见 `stubRects`）。其中画布那一个是**照着
 * 它自己的 `transform` 算的**，因为"放大之后红圈要跟着走"这条契约就靠它验：
 * 画布的布局尺寸在缩放时**一点没变**，`ResizeObserver` 看不见 —— 谁把
 * measurement effect 里那个 `view` 依赖删掉，最后一条用例就会红。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import type { DecodedImage } from '../image/decode'

vi.mock('../render/pipeline', () => ({
  TonePipeline: class {
    setImage() {}
    resizeToImage() {}
    setLut() {}
    render() {}
    dispose() {}
  },
}))

import Canvas from './Canvas'

const P = { ...ZERO }
const noFail = () => {}

/** 可视区 600×400、照片 1000×800 → 适应窗口 = **500×400**（被高度顶着），
 *  它居中之后左边空 50。100% 真实像素 = 2 倍。 */
const AREA = { left: 0, top: 0, width: 600, height: 400 }
const FIT = { left: 50, top: 0, width: 500, height: 400 }
const IMG = { bitmap: {} as ImageBitmap, width: 1000, height: 800 } as DecodedImage
const IMG2 = { bitmap: {} as ImageBitmap, width: 1000, height: 800 } as DecodedImage

const rect = (r: { left: number; top: number; width: number; height: number }) => ({
  ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top,
  toJSON: () => ({}),
}) as DOMRect

/** 画布那一个跟着自己的 `transform` 走 —— 它模拟的正是浏览器里发生的事。 */
const stubRects = () => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (!this.classList.contains('canvas')) return rect(AREA)
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
      (this as HTMLElement).style.transform,
    )
    if (!m) return rect(FIT)
    const s = Number(m[3])
    const w = FIT.width * s
    const h = FIT.height * s
    const cx = FIT.left + FIT.width / 2
    const cy = FIT.top + FIT.height / 2
    return rect({ left: cx + Number(m[1]) - w / 2, top: cy + Number(m[2]) - h / 2, width: w, height: h })
  }
}

type Opts = {
  image?: DecodedImage
  originalPreview?: string | null
  picking?: boolean
  marker?: { x: number; y: number } | null
  resetKey?: unknown
  onPickPoint?: (x: number, y: number) => void
}

const roots: { root: Root; container: HTMLElement }[] = []

/** 挂一个（之后还能 `rerender` —— "换会话 / 换步骤"那两条要靠它）。 */
async function mount(o: Opts = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const canvasRef: { current: HTMLCanvasElement | null } = { current: null }

  const draw = (next: Opts) => act(async () => {
    root.render(
      <Canvas
        image={next.image ?? IMG} params={P} lutCube={null} lutAmount={0}
        originalPreview={next.originalPreview ?? null} canvasRef={canvasRef}
        picking={next.picking} marker={next.marker} onPickPoint={next.onPickPoint}
        resetKey={next.resetKey} onFail={noFail}
      />,
    )
  })
  await draw(o)

  roots.push({ root, container })
  const parts = {
    container,
    wrap: () => container.querySelector('.canvas-wrap') as HTMLElement,
    bar: () => container.querySelector('.zoom-bar') as HTMLElement | null,
    fit: () => container.querySelector('.zoom-fit') as HTMLButtonElement | null,
    peek: () => container.querySelector('.canvas-peek'),
    byLabel: (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement,
    view: () => readView(container),
    rerender: (next: Opts) => draw(next),
  }
  return parts
}

/** 从画布的内联样式里读出"当前视图"。样式缺席 = 适应窗口（原样那一帧）。 */
function readView(c: HTMLElement) {
  const t = (c.querySelector('.canvas') as HTMLElement).style.transform
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(t)
  return m ? { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) } : { x: 0, y: 0, scale: 1 }
}

const down = (el: HTMLElement, clientX: number, clientY: number) =>
  act(async () => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX, clientY })) })
const move = (clientX: number, clientY: number) =>
  act(async () => { window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY })) })
const up = () => act(async () => { window.dispatchEvent(new MouseEvent('pointerup')) })
const clickAt = (el: HTMLElement, clientX: number, clientY: number) =>
  act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY })) })
const dblclickAt = (el: HTMLElement, clientX: number, clientY: number) =>
  act(async () => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX, clientY })) })
const press = (el: HTMLElement) => act(async () => { el.click() })
const wheel = async (el: HTMLElement, clientX: number, clientY: number, deltaY: number) => {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX, clientY, deltaY })
  await act(async () => { el.dispatchEvent(e) })
  return e
}

/** 照片上那一点此刻在屏幕上的横坐标 —— 用来验"锚点没跑"。 */
const screenX = (v: { x: number; scale: number }, u: number) => AREA.width / 2 + v.x + u * v.scale

beforeEach(() => {
  stubRects()
})
afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
  vi.useRealTimers()
})

describe('那排按钮', () => {
  it('「＋」放大、「−」缩小；适应窗口时「−」按不动（没得缩）', async () => {
    const c = await mount()
    expect(c.bar(), '照片上该有一排缩放按钮').toBeTruthy()
    expect(c.view().scale).toBe(1)
    expect(c.byLabel('缩小').disabled).toBe(true)

    await press(c.byLabel('放大'))
    expect(c.view().scale).toBeCloseTo(1.4)
    expect(c.byLabel('缩小').disabled).toBe(false)

    await press(c.byLabel('缩小'))
    expect(c.view().scale).toBeCloseTo(1)
  })

  it('★「适应窗口」只在放大之后出现，点它回到原样（连 transform 都没有）', async () => {
    const c = await mount()
    expect(c.fit()).toBeNull()
    await press(c.byLabel('放大'))
    expect(c.fit()).toBeTruthy()

    await press(c.fit()!)
    expect(c.view()).toEqual({ x: 0, y: 0, scale: 1 })
    // 「适应窗口」那一帧必须和加这个功能之前**一模一样**：内联样式一个字都不留
    expect((c.container.querySelector('.canvas') as HTMLElement).style.transform).toBe('')
  })

  it('放大到顶就停住（8 倍封顶）', async () => {
    const c = await mount()
    for (let i = 0; i < 20; i++) await press(c.byLabel('放大'))
    expect(c.view().scale).toBe(8)
  })
})

describe('滚轮', () => {
  it('★ 以指针指的地方为中心放大 —— 指针底下那块细节不跑', async () => {
    const c = await mount()
    // 指针在可视区中心右边 150px：那里压着照片上 u=150 的那一条。
    // ⚠️ 滚**三格**（1.72 倍）而不是一格：一格之后照片才 598px 宽，还比可视区
    //    （600px）窄，横向按"不许拉出空白"那条**只能待在正中间** —— 那时候
    //    锚点当然会动（任何看图工具都是这样，那是**对的**）。
    const e = await wheel(c.wrap(), AREA.width / 2 + 150, AREA.height / 2, -360)
    expect(e.defaultPrevented, '滚轮要拦下默认行为（不然页面会跟着滚）').toBe(true)

    const v = c.view()
    expect(v.scale).toBeGreaterThan(1.5)
    expect(screenX(v, 150)).toBeCloseTo(AREA.width / 2 + 150)
  })

  it('往下滚是缩小；缩到头就停在"适应窗口"，不会更小', async () => {
    const c = await mount()
    await wheel(c.wrap(), 300, 200, -240)
    expect(c.view().scale).toBeGreaterThan(1)
    await wheel(c.wrap(), 300, 200, 240)
    expect(c.view().scale).toBeCloseTo(1)
    await wheel(c.wrap(), 300, 200, 240)
    expect(c.view()).toEqual({ x: 0, y: 0, scale: 1 })
  })
})

describe('拖动 = 平移', () => {
  it('适应窗口时拖不动（照片本来就全在眼前）', async () => {
    const c = await mount()
    await down(c.wrap(), 100, 100)
    await move(200, 180)
    await up()
    expect(c.view()).toEqual({ x: 0, y: 0, scale: 1 })
  })

  it('放大之后拖到哪算哪，拖过头就停在"照片的边贴到画面正中间"', async () => {
    const c = await mount()
    await press(c.byLabel('放大'))            // 1.4 倍：照片 700×560，最多各挪半张（350 / 280）
    await down(c.wrap(), 100, 100)
    await move(140, 130)                      // +40 / +30
    await up()
    expect(c.view()).toEqual({ x: 40, y: 30, scale: 1.4 })

    await down(c.wrap(), 100, 100)
    await move(500, 100)                      // 想挪 400 → 只给到半张宽
    await up()
    expect(c.view().x).toBe(350)
  })

  it('★ 照片角上的细节能一路拖到画面正中间（用户 2026-10-06 晚要的）', async () => {
    // 他原话：「假如我想把右上角的细节点放大放到正中间来是没法实现的」——
    // 旧的夹法（照片必须盖满可视区）只允许把角拉到**屏幕的角**上，
    // 照片外圈那一带永远到不了中间。现在：任何一点都能拉到正中间。
    const c = await mount()
    await dblclickAt(c.wrap(), 300, 200)      // 100%：照片 1000×800，正居中
    await down(c.wrap(), 300, 200)
    await move(-200, 600)                     // 往左下拖半张 → 右上角走到中间
    await up()

    expect(c.view()).toEqual({ x: -500, y: 400, scale: 2 })
    // 右上角此刻落在画布盒子的右上角 —— 而那个点就是可视区的正中心
    const r = (c.container.querySelector('.canvas') as HTMLElement).getBoundingClientRect()
    expect(r.right).toBeCloseTo(AREA.width / 2)
    expect(r.top).toBeCloseTo(AREA.height / 2)
  })

  it('手抖那几像素不算拖动（阈值以内画面不动）', async () => {
    const c = await mount()
    await press(c.byLabel('放大'))
    await down(c.wrap(), 100, 100)
    await move(103, 102)
    await up()
    expect(c.view()).toEqual({ x: 0, y: 0, scale: 1.4 })
  })
})

describe('和"按住看原图"怎么共存', () => {
  it('按住不动 0.15 秒才出原图（一按就出的话，每次拖动都会先闪一下）', async () => {
    vi.useFakeTimers()
    const c = await mount({ originalPreview: 'data:image/png;base64,xxx' })
    await down(c.wrap(), 100, 100)
    expect(c.peek(), '刚按下还没有').toBeNull()

    await act(async () => { vi.advanceTimersByTime(150) })
    expect(c.peek()).toBeTruthy()

    await up()
    expect(c.peek()).toBeNull()
  })

  it('按下就拖：原图一次都不闪，而且真的在平移', async () => {
    vi.useFakeTimers()
    const c = await mount({ originalPreview: 'data:image/png;base64,xxx' })
    await press(c.byLabel('放大'))
    await down(c.wrap(), 100, 100)
    await act(async () => { vi.advanceTimersByTime(80) })   // 还没到 0.15 秒
    await move(150, 100)
    await act(async () => { vi.advanceTimersByTime(500) })  // 时间早就过了
    expect(c.peek()).toBeNull()
    expect(c.view().x).toBe(50)
    await up()
  })
})

describe('点选（点一下告诉 AI 改哪儿）', () => {
  it('★ 拖过的那一下不算"点这儿"（放大之后要能拖着找位置）', async () => {
    const picks: [number, number][] = []
    const c = await mount({ picking: true, onPickPoint: (x, y) => picks.push([x, y]) })
    await press(c.byLabel('放大'))

    await down(c.wrap(), 100, 100)
    await move(160, 100)
    await up()
    await clickAt(c.wrap(), 160, 100)         // 浏览器在 pointerup 之后派发的那一下
    expect(picks, '拖动不是点选').toEqual([])

    // 收回适应窗口之后再点：这一下照旧算"点这儿"（照片左边空 50、宽 500）
    await press(c.fit()!)
    await down(c.wrap(), 100, 100)
    await up()
    await clickAt(c.wrap(), 100, 100)
    expect(picks).toEqual([[0.1, 0.25]])
  })

  it('点选模式里双击不会缩放（那两下是在指位置）', async () => {
    const c = await mount({ picking: true, onPickPoint: () => {} })
    await dblclickAt(c.wrap(), 300, 200)
    expect(c.view()).toEqual({ x: 0, y: 0, scale: 1 })
  })
})

describe('双击 = 定位到细节', () => {
  it('★ 双击哪儿就以哪儿为中心怼到 100% 真实像素；再双击回适应窗口', async () => {
    const c = await mount()
    await dblclickAt(c.wrap(), 200, 200)
    const v = c.view()
    expect(v.scale).toBe(2)                                  // 1000 / 500
    expect(screenX(v, 200 - AREA.width / 2)).toBeCloseTo(200) // 双击那一点没跑

    await dblclickAt(c.wrap(), 200, 200)
    expect(c.view()).toEqual({ x: 0, y: 0, scale: 1 })
  })
})

describe('什么时候归位', () => {
  it('换会话 → 收回适应窗口；同一条会话里换一步（图变了）→ 保持在原地', async () => {
    const c = await mount({ resetKey: 1 })
    await press(c.byLabel('放大'))
    await press(c.byLabel('放大'))
    expect(c.view().scale).toBeGreaterThan(1)

    // 同一条会话：生成完 / 转盘跳一步只是**图换了**，用户正对着同一块地方看
    await c.rerender({ resetKey: 1, image: IMG2 })
    expect(c.view().scale).toBeCloseTo(1.96)

    // 换会话 / 换照片：那是另一回事了
    await c.rerender({ resetKey: 2, image: IMG2 })
    expect(c.view()).toEqual({ x: 0, y: 0, scale: 1 })
  })
})

describe('红圈（用户点的那一点）', () => {
  it('★ 放大之后跟着照片走 —— 量尺子必须跟着重新量', async () => {
    // 画布的**布局**尺寸在缩放时一点没变（变的是 transform），
    // ResizeObserver 看不见这一下：谁把 measurement effect 里那个 view 依赖删掉，
    // 红圈就会留在放大前的位置上，而屏幕上一切"看起来正常"。
    const c = await mount({ marker: { x: 0, y: 0 }, picking: true, onPickPoint: () => {} })
    const dot = c.container.querySelector('.canvas-marker') as HTMLElement
    expect(dot.style.left).toBe('50px')          // 照片左上角（适应窗口时左边空 50）
    const sizeAtFit = Number.parseFloat(dot.style.width)

    await press(c.byLabel('放大'))               // 以中心为锚点 → 照片向左上撑开
    const left = Number.parseFloat(dot.style.left)
    expect(left).toBeLessThan(50)                // 左上角跟着跑到负的
    // 圈是**照片上的记号**，放大之后它占的那块地方没变，所以它在屏幕上也该跟着变大
    expect(Number.parseFloat(dot.style.width)).toBeGreaterThan(sizeAtFit)
  })
})
