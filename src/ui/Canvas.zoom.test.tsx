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
import type { CropScene } from './Canvas'

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
    const style = (this as HTMLElement).style.transform
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(style)
    if (m) {
      const s = Number(m[3])
      const w = FIT.width * s
      const h = FIT.height * s
      const cx = FIT.left + FIT.width / 2
      const cy = FIT.top + FIT.height / 2
      return rect({ left: cx + Number(m[1]) - w / 2, top: cy + Number(m[2]) - h / 2, width: w, height: h })
    }
    // ★ 2026-10-06（裁剪）：**转过之后量到的就是转完那个包围盒** ——
    //   浏览器里 `getBoundingClientRect()` 算的正是变换后的可见盒子，
    //   而这一整套东西（框、外面那圈留白）全靠它。照真浏览器算一遍。
    const r = /rotate\((-?[\d.]+)deg\) scale\(([\d.]+)\)/.exec(style)
    if (r) {
      const a = (Number(r[1]) * Math.PI) / 180
      const k = Number(r[2])
      const w = (FIT.width * Math.abs(Math.cos(a)) + FIT.height * Math.abs(Math.sin(a))) * k
      const h = (FIT.width * Math.abs(Math.sin(a)) + FIT.height * Math.abs(Math.cos(a))) * k
      const cx = FIT.left + FIT.width / 2
      const cy = FIT.top + FIT.height / 2
      return rect({ left: cx - w / 2, top: cy - h / 2, width: w, height: h })
    }
    return rect(FIT)
  }
}

type Opts = {
  image?: DecodedImage
  originalPreview?: string | null
  picking?: boolean
  marker?: { x: number; y: number } | null
  resetKey?: unknown
  /** ★ 2026-10-06（工具行）：工具开着 = 手势停用（滚轮 / 拖动 / 双击、按钮不画）。 */
  viewLocked?: boolean
  /** ★ 2026-10-06（裁剪）：裁剪的现场（null / 不给 = 没在裁）。 */
  crop?: CropScene | null
  onPickPoint?: (x: number, y: number) => void
  /** ★ 2026-10-06（对比）：开关 + 备好的原图（`comparing` 为真且 `compareWith`
   *  有值时，照片上才叠那一层）。 */
  comparing?: boolean
  compareWith?: string | null
  onCompare?: () => void
}

/** 裁剪现场（框 / 内接区这些**算式**不归这一层管，这里只关心角度怎么落成 CSS）。 */
const scene = (angle: number, over: Partial<CropScene> = {}): CropScene => ({
  rect: { x: 0, y: 0, w: 1, h: 1 },
  onRect: () => {},
  aspect: null,
  inner: { x: 0, y: 0, w: 1, h: 1 },
  angle,
  ...over,
})

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
        resetKey={next.resetKey} viewLocked={next.viewLocked} crop={next.crop} onFail={noFail}
        comparing={next.comparing} compareWith={next.compareWith} onCompare={next.onCompare}
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

/**
 * ★ 2026-10-06（工具行）：工具开着时**手势停用** —— 滚轮 / 拖动 / 双击全不响应，
 * 右下角那排缩放按钮也不画。理由：裁剪时一边拉框一边缩放会让框和手指打架
 * （spec §3.1）。判据是 App 传下来的 `viewLocked`（`tool !== null`）。
 */
describe('工具开着时（viewLocked）：手势停用', () => {
  it('滚轮一格都不动 —— 而且**也不拦默认行为**（监听压根没挂）', async () => {
    const c = await mount({ viewLocked: true })
    const e = await wheel(c.wrap(), AREA.width / 2, AREA.height / 2, -360)
    expect(c.view()).toEqual({ x: 0, y: 0, scale: 1 })
    // `preventDefault` 是"我接了这一滚、页面别跟着滚"才做的事 —— 没接就不该拦。
    // 这一条顺带把"监听到底挂没挂"量出来：只断言 scale 不变的话，
    // "挂了监听但里面判了 viewLocked"也照样绿。
    expect(e.defaultPrevented).toBe(false)
  })

  it('右下角那排缩放按钮不画（放大 / 缩小 / 适应窗口 三颗都不在）', async () => {
    const c = await mount({ viewLocked: true })
    expect(c.bar()).toBeNull()
  })

  it('★ 先开着再锁上：滚轮那条监听要真的摘掉（钉住依赖数组）', async () => {
    // ⚠️ 这条是**唯一**能抓住"依赖数组里漏了 viewLocked"的：漏了的话 effect
    //    不重跑、旧监听还挂在 wrap 上，而它的闭包里是上一轮的 viewLocked（假）——
    //    用户开着工具滚一下，**画面照样缩放、全程不报错**。
    const c = await mount()
    await wheel(c.wrap(), AREA.width / 2, AREA.height / 2, -360)
    const zoomed = c.view().scale
    expect(zoomed).toBeGreaterThan(1)              // 没锁时确实放大了

    await c.rerender({ viewLocked: true })
    await wheel(c.wrap(), AREA.width / 2, AREA.height / 2, -360)
    expect(c.view().scale, '锁上之后滚轮必须一步都不动').toBe(zoomed)
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

/**
 * ★ 2026-10-06（裁剪）：**预览那一帧** —— 照片转多少度、缩多少倍。
 *
 * ⚠️ 这两个数各有一次"看着对、其实错"的机会，而两边都**不会报错**：
 *   · **方向**：约定是"θ > 0 ⇒ 照片在输出里逆时针转"（`image/crop.ts` 的 JSDoc），
 *     而 CSS 的正角度是**顺时针** → 这里必须 `rotate(-θ)`。写成正的，预览和
 *     成片会朝相反方向转，而外框尺寸、输出尺寸两边**一模一样** ——
 *     计划里那些测试和探针全都看不出来。
 *   · **倍数 k**：转完外框比照片大，不缩回去就会溢到预设栏 / 上面的带子 /
 *     右边对话栏上。k = min(1, imgW/外框w, imgH/外框h)，只吃底图自己的尺寸
 *     （去量盒子来算 k 是循环依赖，量到的是被自己改过的盒子）。
 */
describe('裁剪：预览那一帧（转 + 缩）', () => {
  /** 从画布的内联样式里读"裁剪那一帧"。没在裁 / 没样式 = null。 */
  const readCrop = (c: HTMLElement) => {
    const m = /rotate\((-?[\d.]+)deg\) scale\(([\d.]+)\)/.exec(
      (c.querySelector('.canvas') as HTMLElement).style.transform)
    return m ? { deg: Number(m[1]), k: Number(m[2]) } : null
  }

  it('★ 转 15° → CSS 写的是 rotate(-15deg)（和成片同向），并按外框缩回 0.7755', async () => {
    const c = await mount({ crop: scene(15) })
    const got = readCrop(c.container)!
    expect(got.deg).toBe(-15)
    // 1000×800 转 15° → 外框 1172.98×1031.56 → k = min(1, 1000/1172.98, 800/1031.56)
    expect(got.k).toBeCloseTo(0.7755, 4)
    expect(got.k).toBeLessThanOrEqual(1)          // 只缩不放大
  })

  it('不转就不缩（k = 1）；转 90° 长宽对调 → k = 0.8', async () => {
    const zero = await mount({ crop: scene(0) })
    expect(readCrop(zero.container)).toEqual({ deg: 0, k: 1 })
    const turn = await mount({ crop: scene(-90) })
    expect(readCrop(turn.container)!.deg).toBe(90)   // -(-90)
    expect(readCrop(turn.container)!.k).toBeCloseTo(0.8, 6)
  })

  it('★ 没在裁的时候，画布上一个内联样式都不留（和"适应窗口"那一帧同一条规矩）', async () => {
    const c = await mount()
    expect((c.container.querySelector('.canvas') as HTMLElement).style.transform).toBe('')
    await c.rerender({ crop: scene(15) })
    expect(readCrop(c.container)).not.toBeNull()
    await c.rerender({ crop: null })
    expect((c.container.querySelector('.canvas') as HTMLElement).style.transform).toBe('')
  })

  it('★ 转起来之后外框会漏出去 —— wrap 要挂 cropping（剪裁层照 .zoomed 那条生效）', async () => {
    const c = await mount({ crop: scene(15) })
    expect(c.wrap().className).toContain('cropping')
    await c.rerender({ crop: null })
    expect(c.wrap().className).not.toContain('cropping')
  })

  it('★ 框画在**剪裁层外面**（把手挂在照片边上，剪在里头会被切掉半个）', async () => {
    const c = await mount({ crop: scene(0) })
    const box = c.container.querySelector('.crop')
    expect(box).toBeTruthy()
    expect(c.container.querySelector('.canvas-clip .crop'), '框不能住在剪裁层里').toBeNull()
    expect([...c.wrap().children].some(el => el.classList.contains('crop'))).toBe(true)
  })

  it('裁着的时候不画红圈（它和外框不是一个坐标系）', async () => {
    const c = await mount({ crop: scene(0), marker: { x: 0.5, y: 0.5 } })
    expect(c.container.querySelector('.canvas-marker')).toBeNull()
  })

  it('★ 转过之后，框量的是**转完那个包围盒**（量尺子必须跟着角度重跑）', async () => {
    // 照片 1000×800 适应窗口 = 500×400（FIT，中心在 300,200）。
    // 转 90° → 外框 400×500，k = 0.8 → 量出来该是 320×400、居中。
    // ⚠️ `ResizeObserver` 看不见 transform（布局尺寸没变），所以这条量的是
    //    "角度变了之后**重量了一次**"：谁把 measurement effect 里 `crop?.angle`
    //    那个依赖删掉，框就会停在转之前的位置上，而画面上一切"看起来正常"。
    const c = await mount({ crop: scene(90) })
    const frame = () => c.container.querySelector('.crop-frame') as HTMLElement
    /** 内联样式是 px 字符串；比数字（90° 的 `cos` 是 6.1e-17，硬比字符串会差最后一位）。 */
    const at = (v: string) => Number.parseFloat(v)
    expect(at(frame().style.left)).toBeCloseTo(140, 6)     // 300 - 320/2
    expect(at(frame().style.top)).toBeCloseTo(0, 6)        // 200 - 400/2
    expect(at(frame().style.width)).toBeCloseTo(320, 6)
    expect(at(frame().style.height)).toBeCloseTo(400, 6)

    // 转回 0°：又是一开始那块（500×400 的照片盒子）
    await c.rerender({ crop: scene(0) })
    expect(at(frame().style.left)).toBeCloseTo(50, 6)
    expect(at(frame().style.width)).toBeCloseTo(500, 6)
    expect(at(frame().style.height)).toBeCloseTo(400, 6)
  })
})

/**
 * ★ 2026-10-06（对比）：**分屏那一层**怎么落进照片区（spec §3.3）。
 *
 * 算式和拖动在 `ui/CompareSplit`（那一条量在 `CompareSplit.test.tsx`），
 * 这一节只钉**接线**：层住在哪儿、吃哪个变换、那颗按钮在不在、退出干不干净。
 */
describe('对比：分屏那一层', () => {
  const SRC = 'data:image/jpeg;base64,ORIGINAL'

  it('★ 原图层在剪裁层里、把手在剪裁层外；两张图贴**同一个**变换', async () => {
    const c = await mount({ comparing: true, compareWith: SRC })
    const img = c.container.querySelector('.compare-img') as HTMLImageElement
    expect(img).toBeTruthy()
    // ① 原图那份**住在剪裁层里**（放大之后它也要被剪，不然会糊到旁边去）
    expect(
      c.container.querySelector('.canvas-clip .compare-img'),
      '原图层要在剪裁层里面',
    ).toBeTruthy()
    // ② 把手**不在**剪裁层里（它不随图片缩放，也不该被那层的 overflow 剪）
    expect(c.container.querySelector('.canvas-clip .compare-handle'), '把手不能在剪裁层里').toBeNull()
    expect([...c.wrap().children].some(el => el.classList.contains('compare'))).toBe(true)

    // ③ ★ "两张图一起缩放"：放大之后画布和原图那个串**一模一样**
    await press(c.byLabel('放大'))
    const canvas = c.container.querySelector('.canvas') as HTMLElement
    expect(canvas.style.transform).toContain('scale(1.4)')
    expect(img.style.transform, '两张图必须贴同一个变换').toBe(canvas.style.transform)
  })

  it('★ 对比态里缩放照常能用（它不是"工具开着"那种锁）', async () => {
    // spec §3.3：用户多半正放大着才去按对比 —— 把他拽回"适应窗口"正好毁掉这个用法。
    // 判据是 `viewLocked`（App 那边只认裁剪）；这一层钉的是"没有这个 prop 时，
    // 滚轮 / 拖动 / 双击那套照旧"。
    const c = await mount({ comparing: true, compareWith: SRC })
    await wheel(c.wrap(), AREA.width / 2, AREA.height / 2, -360)
    expect(c.view().scale).toBeGreaterThan(1)
    expect(c.fit(), '放大之后「适应窗口」那颗该在').toBeTruthy()
  })

  it('★ 右下角那排里那颗「对比」：在不在、亮不亮、点它喊回去', async () => {
    const calls: number[] = []
    const c = await mount({
      comparing: true, compareWith: SRC, onCompare: () => calls.push(1),
    })
    const btn = c.container.querySelector('.zoom-compare') as HTMLButtonElement
    expect(btn, '右下角那排里该有一颗「对比」').toBeTruthy()
    expect(btn.getAttribute('aria-pressed')).toBe('true')     // 亮着 = 在对比态
    await press(btn)
    expect(calls).toHaveLength(1)

    // 没在对比时它是暗的，而且**照旧在**（那是入口，不是状态标记）
    await c.rerender({ comparing: false, compareWith: SRC, onCompare: () => calls.push(1) })
    expect(c.container.querySelector('.zoom-compare')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('★ 原图还没备好（懒做那半路上）：按钮照样能点，只是一层还没出来', async () => {
    const c = await mount({ comparing: true, compareWith: null, onCompare: () => {} })
    expect(c.container.querySelector('.compare')).toBeNull()
    expect(c.container.querySelector('.zoom-compare'), '等在备原图时那颗按钮照旧在').toBeTruthy()
  })

  it('★ 退出之后不留痕：那一层整个撤掉（`--split` 跟着它一起没）', async () => {
    const c = await mount({ comparing: true, compareWith: SRC })
    expect(c.container.querySelector('.compare')).toBeTruthy()
    expect(c.container.querySelector('[style*="--split"]'), '分屏的位置挂在那一层身上').toBeTruthy()

    await c.rerender({ comparing: false, compareWith: SRC })
    expect(c.container.querySelector('.compare')).toBeNull()
    expect(c.container.querySelector('.compare-img')).toBeNull()
    expect(c.container.querySelector('[style*="--split"]'), '退出后 `--split` 不许留痕').toBeNull()
  })
})
