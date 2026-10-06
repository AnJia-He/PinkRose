// @vitest-environment jsdom
/**
 * 对比分屏（★ 2026-10-06，spec §3.3）—— 组件这一层的接线。
 *
 * 这一层的三件事都要钉住，因为它们错了**一句都不报**：
 *   · 原图那一层和画布**贴同一个变换**（两张图是同一张位置上的两张图，
 *     差一点就对不齐 —— 放大之后尤其明显）；
 *   · 把手拖动改的是 **CSS 变量 `--split`**，而剪裁层和把手的左沿**读的是同一个
 *     变量**（分开写两个数，拖起来就各走各的）；
 *   · 夹在 5%~95%（拖到照片区外面那一截不该把分屏甩出去）。
 *
 * ⚠️ jsdom 里**所有盒子都是 0×0**，而拖动要靠"照片区多宽"来换算 ——
 *    所以下面把 `getBoundingClientRect` 整个换掉（`Canvas.zoom.test.tsx`
 *    里那条是同一套做法）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CSSProperties } from 'react'
import CompareSplit from './CompareSplit'

const SRC = 'data:image/jpeg;base64,ORIGINAL'
/** 照片区 600×400（和 `Canvas.zoom.test.tsx` 里那条同一个数）。 */
const AREA = { left: 0, top: 0, width: 600, height: 400 }

const rect = (r: { left: number; top: number; width: number; height: number }) => ({
  ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top,
  toJSON: () => ({}),
}) as DOMRect

const roots: { root: Root; container: HTMLElement }[] = []
let capture: ReturnType<typeof vi.fn>

/** 挂一个。`transform` 传的就是 `Canvas` 那份 `stageStyle`（同一个对象）。 */
async function mount(o: { src?: string; transform?: CSSProperties } = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<CompareSplit src={o.src ?? SRC} transform={o.transform} />)
  })
  roots.push({ root, container })
  return {
    container,
    root,
    /** 分屏那一层（它身上挂着 `--split`）。 */
    area: () => container.querySelector('.compare') as HTMLElement,
    layer: () => container.querySelector('.compare-layer') as HTMLElement,
    img: () => container.querySelector('.compare-img') as HTMLImageElement,
    handle: () => container.querySelector('.compare-handle') as HTMLElement,
    /** 此刻分屏在哪：组件唯一的真相就是那个 CSS 变量。 */
    split: () =>
      (container.querySelector('.compare') as HTMLElement).style.getPropertyValue('--split'),
  }
}

const down = (el: HTMLElement, clientX: number, clientY = 200) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX, clientY }))
  })
/** 拖动那条线索必须挂在 **window** 上（手拖到照片区外面是常态）。 */
const move = (clientX: number) =>
  act(async () => { window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY: 200 })) })
const up = () => act(async () => { window.dispatchEvent(new MouseEvent('pointerup')) })

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => rect(AREA)
  // 真浏览器里有这个 API，但这个仓库踩过它 —— 留下记号，好断言"一次都没调"
  capture = vi.fn()
  ;(Element.prototype as unknown as { setPointerCapture: unknown }).setPointerCapture = capture
})
afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
})

describe('长相：左边原图、右边现在', () => {
  it('★ 挂上就是一半一半，而且两边读的是同一个变量', async () => {
    const c = await mount()

    expect(c.split(), '一开始分在正中间').toBe('50%')
    // 原图那一层：只露左边那一半 —— 剪的是**那个不动的盒子**，不是会跟着缩放的 `<img>`
    expect(c.layer().style.clipPath).toBe('inset(0 calc(100% - var(--split)) 0 0)')
    // 把手的位置：同一个变量（两处各写各的话，拖起来就各走各的）
    expect(c.handle().style.left).toBe('var(--split)')
    expect(c.img().getAttribute('src')).toBe(SRC)
  })

  it('★ 原图吃的是和画布**同一个**变换（两张图差一点就对不齐）', async () => {
    // 这一条传的就是 `Canvas` 那份 `stageStyle`（放大 / 平移之后那个串）
    const style: CSSProperties = { transform: 'translate(12px, -8px) scale(2.5)' }
    const c = await mount({ transform: style })
    expect(c.img().style.transform).toBe('translate(12px, -8px) scale(2.5)')

    // 适应窗口那一帧：一个内联样式都不留（和画布那条规矩一样）
    const fit = await mount()
    expect(fit.img().style.transform).toBe('')
  })

  it('★ 左半边必须**不透明**（比例不同时，底下的"现在"不许透出来）', async () => {
    // 来路（评审 2026-10-06 真机量到的）：原图 900×1200、"现在" 1200×800 时，
    // 原图 contain 进照片区只占中间一条（左沿还差 72px）—— 那条缝里如果透明，
    // 露出来的就是**底下那张画布（"现在"）**：左半读起来是"两张图叠着"，
    // 而 spec §3.3 要的是"左原图、右现在"。裁过一刀、转过 90° 就会撞上。
    //
    // ⚠️ jsdom 里没有排版引擎、也不加载 styles.css，这条**量不到像素** ——
    //    只能读源码把那份契约钉住（和 `AdjustmentPanel.test.ts` / `kit.test.tsx`
    //    里那几条同款）。真机那两个读数在
    //    `.superpowers/scratch/audit/_compare_aspect_audit.mjs`。
    //    ⚠️ 路径走 `process.cwd()`：jsdom 环境里 `import.meta.url` 拼出来不是
    //    `file://`，`fileURLToPath` 当场就报（`kit.test.tsx` 那边踩过）。
    const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8')
    const rule = /\.compare-layer\s*\{([^}]*)\}/.exec(css)?.[1]
    expect(rule, 'styles.css 里该有 `.compare-layer` 那条规则').toBeTruthy()
    const bg = /background:\s*([^;]+);/.exec(rule!)?.[1] ?? ''

    expect(bg, '`.compare-layer` 要有一条 background').toBeTruthy()
    expect(bg, '底下那层要**不透明**的（不然"现在"会从缝里透出来）').toContain('var(--bg)')
    // 和照片区的底**同一套语言**：那份顶光的令牌由 `.stage` 定、两边共用
    //（各写各的就会漂 —— 而且 `.stage` 上那层光会把 `--panel` 吃掉，
    //  拿它当底会长出一条色差）。
    expect(bg, '要用照片区那套光（`--stage-light`），别各写各的').toContain('var(--stage-light')
  })
})

describe('拖把手', () => {
  it('★ 跟着手指走；松手之后停在原地（不回弹）', async () => {
    const c = await mount()
    await down(c.handle(), 300)          // 按在正中间
    await move(210)                      // 往左拖 90px → 600 的 15%
    expect(c.split()).toBe('35%')

    await move(420)                      // 往右拖
    expect(c.split()).toBe('70%')

    await up()
    expect(c.split(), '松手之后不回弹').toBe('70%')
    await move(100)                      // 松手之后再动不算数
    expect(c.split()).toBe('70%')
  })

  it('★ 夹在 5%~95%：拖出照片区也只是把分屏顶到边上', async () => {
    const c = await mount()
    await down(c.handle(), 300)
    await move(-500)
    expect(c.split()).toBe('5%')
    await move(9999)
    expect(c.split()).toBe('95%')
    await up()
  })

  it('★ 监听挂在 window 上，而且**没用** `setPointerCapture`', async () => {
    // 一捕获，紧接着那一下 `click` 会落到容器上（`StepStrip` 真踩过）——
    // 上面两条能过就说明 move/up 是 window 上收的；这儿只钉"没走捕获那条路"。
    const c = await mount()
    await down(c.handle(), 300)
    await move(360)
    expect(capture).not.toHaveBeenCalled()
    await up()
  })

  it('★ 按在把手上那一下**不冒泡**（别同时变成照片上的平移 / 按住看原图）', async () => {
    // 把手是画在照片区里的一根线：这一下如果冒到 `.canvas-wrap` 上，
    // 会开始一段"按下"（0.15 秒之后照片闪成原图），拖起来还会顺手平移。
    const outer = document.createElement('div')
    document.body.appendChild(outer)
    const c = await mount()
    outer.appendChild(c.container)
    let seen = 0
    outer.addEventListener('pointerdown', () => seen++)

    await down(c.img(), 300)             // 反面对照：按在图上照旧冒上去
    expect(seen).toBe(1)
    await down(c.handle(), 300)
    expect(seen, '按在把手上那一下不许冒出去').toBe(1)
    await up()
    outer.remove()
  })
})
