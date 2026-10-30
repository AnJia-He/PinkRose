// @vitest-environment jsdom
/**
 * 照片上那个**裁剪框**（★ 2026-10-06）—— 拖动这一层的算法。
 *
 * 这一层只认三件事：**照片盒子在屏幕上的位置**（`box`）、**归一化矩形**、
 * **当前比例档**；外加一根硬规矩 —— 框**不许拖出内接区**（`inner`，见 `core/crop.ts`
 * 文件头那根接力棒：旋转留下的四个空角在它外面）。
 *
 * ⚠️ 驱动方式和 `Canvas.zoom.test.tsx` / `StepStrip.test.tsx` 同款：
 *    `createRoot` + `act`，指针事件用 `MouseEvent('pointerdown' …)` 派
 *    （jsdom 里没有真的 PointerEvent；仓库里那两条手势都是这么测的），
 *    拖动时的监听挂在 window 上 —— 所以 move/up 都往 window 上派。
 * ⚠️ 挂着**带状态**的父级（真 App 里 `onRect` 会回头把 `rect` 改掉）——
 *    只传死 prop 的话，第二次拖动会从"上一次渲染前"的框算起，
 *    而那不是真环境里的行为。
 */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import CropOverlay, { type CropBox } from './CropOverlay'
import { MIN_SIDE, type CropGuide, type CropRect } from '../core/crop'

const BOX: CropBox = { left: 0, top: 0, width: 800, height: 600 }
const FULL: CropRect = { x: 0, y: 0, w: 1, h: 1 }

const roots: { root: Root; container: HTMLElement }[] = []
afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
})

/** 真 App 的样子：`onRect` 回头把框改掉，组件拿到的永远是"现在这个框"。 */
function Harness(props: {
  initial: CropRect
  aspect?: number | null
  inner?: CropRect
  guide?: CropGuide
  seen: CropRect[]
  onOuter?: () => void
}) {
  const [rect, setRect] = useState(props.initial)
  return (
    <div className="outer" onClick={props.onOuter} onPointerDown={props.onOuter}>
      <CropOverlay
        box={BOX} rect={rect}
        aspect={props.aspect ?? null}
        inner={props.inner ?? FULL}
        guide={props.guide}
        onRect={r => { props.seen.push(r); setRect(r) }}
      />
    </div>
  )
}

async function mount(props: {
  initial: CropRect
  aspect?: number | null
  inner?: CropRect
  guide?: CropGuide
  onOuter?: () => void
}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const seen: CropRect[] = []
  await act(async () => { root.render(<Harness {...props} seen={seen} />) })
  roots.push({ root, container })
  const frame = () => container.querySelector('.crop-frame') as HTMLElement
  const handle = (h: string) => container.querySelector(`[data-h="${h}"]`) as HTMLElement
  return { container, seen, frame, handle }
}

/** 按下 → 拖 → 松手。坐标是**屏幕像素**（盒子 800×600）。 */
const down = (el: Element, clientX: number, clientY: number) =>
  act(async () => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX, clientY })) })
const move = (clientX: number, clientY: number) =>
  act(async () => { window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY })) })
const up = () => act(async () => { window.dispatchEvent(new MouseEvent('pointerup')) })
const key = (el: Element, value: string, shiftKey = false) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: value, shiftKey, bubbles: true, cancelable: true,
    }))
  })

/** 拖一个把手：从它的位置拖走 (dx, dy) 像素。 */
async function drag(el: Element, from: [number, number], by: [number, number]) {
  await down(el, from[0], from[1])
  await move(from[0] + by[0], from[1] + by[1])
  await up()
}

/** 归一化的容差：一个像素 = 0.00125（宽）/ 0.001667（高）。 */
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6)

describe('拖角 / 拖边：改框（锚点不动）', () => {
  it('★ 拖右下角 40px：w 多 40/800、h 多 40/600，左上角一步都不动', async () => {
    const c = await mount({ initial: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } })
    await drag(c.handle('se'), [600, 450], [40, 40])
    const r = c.seen.at(-1)!
    near(r.w, 0.55)                 // 0.5 + 40/800
    near(r.h, 0.5 + 40 / 600)       // 0.5 + 0.0667
    near(r.x, 0.25); near(r.y, 0.25)  // 抓的是右下角，左上角是锚
  })

  it('★ 拖出盒子：停在 1（框不许跑到照片外面）', async () => {
    const c = await mount({ initial: { x: 0, y: 0, w: 0.5, h: 0.5 } })
    await drag(c.handle('se'), [400, 300], [4000, 4000])
    expect(c.seen.at(-1)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('★ 拖左上角往外：x/y 停在 0，框长到 1', async () => {
    const c = await mount({ initial: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } })
    await drag(c.handle('nw'), [200, 150], [-400, -300])
    const r = c.seen.at(-1)!
    near(r.x, 0); near(r.y, 0); near(r.w, 0.75); near(r.h, 0.75)
  })

  it('拖边只动那一根轴（拖右边，高不变）', async () => {
    const c = await mount({ initial: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } })
    await drag(c.handle('e'), [600, 300], [80, 90])
    const r = c.seen.at(-1)!
    near(r.w, 0.6); near(r.h, 0.5); near(r.x, 0.25); near(r.y, 0.25)
  })

  it('缩到头就停在最小边（缩不成一条线）', async () => {
    const c = await mount({ initial: { x: 0, y: 0, w: 0.5, h: 0.5 } })
    await drag(c.handle('e'), [400, 300], [-1000, 0])
    near(c.seen.at(-1)!.w, MIN_SIDE)
  })
})

describe('框里按下 = 整体平移', () => {
  it('拖框内：x/y 跟着走，w/h 一点不动', async () => {
    const c = await mount({ initial: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } })
    await drag(c.frame(), [400, 300], [100, 60])
    const r = c.seen.at(-1)!
    near(r.x, 0.375); near(r.y, 0.35)
    near(r.w, 0.5); near(r.h, 0.5)
  })

  it('★ 平移也夹着：拖出盒子就贴边停住（右边不许越过 1）', async () => {
    const c = await mount({ initial: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } })
    await drag(c.frame(), [400, 300], [4000, -4000])
    const r = c.seen.at(-1)!
    near(r.x, 0.5); near(r.y, 0)          // 右边贴 1、上边贴 0
    near(r.w, 0.5); near(r.h, 0.5)
  })
})

describe('键盘精确构图', () => {
  it('焦点在裁剪框上：方向键移动 1px，Shift 加速到 10px', async () => {
    const c = await mount({ initial: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } })
    await key(c.frame(), 'ArrowRight')
    near(c.seen.at(-1)!.x, 0.25 + 1 / 800)
    await key(c.frame(), 'ArrowDown', true)
    near(c.seen.at(-1)!.y, 0.25 + 10 / 600)
    expect(c.seen.at(-1)!.w).toBeCloseTo(0.5, 6)
    expect(c.seen.at(-1)!.h).toBeCloseTo(0.5, 6)
  })

  it('焦点在把手上：方向键只改对应轴，并继续受内接区约束', async () => {
    const c = await mount({
      initial: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      inner: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 },
    })
    await key(c.handle('se'), 'ArrowRight')
    near(c.seen.at(-1)!.w, 0.5 + 1 / 800)
    expect(c.seen.at(-1)!.h).toBeCloseTo(0.5, 6)
    await key(c.handle('se'), 'ArrowDown', true)
    near(c.seen.at(-1)!.h, 0.5 + 10 / 600)
  })

  it('锁比例时键盘缩放仍保持宽高比', async () => {
    const c = await mount({
      initial: { x: 0.2, y: 0.3, w: 0.4, h: 0.25 }, aspect: 1.6,
    })
    await key(c.handle('e'), 'ArrowRight', true)
    const r = c.seen.at(-1)!
    near(r.w, 0.4 + 10 / 800)
    near(r.h, r.w / 1.6)
  })

  it('裁剪框和八个把手都在键盘顺序里', async () => {
    const c = await mount({ initial: FULL })
    expect(c.frame().tabIndex).toBe(0)
    expect(c.frame().getAttribute('aria-label')).toContain('方向键移动')
    const handles = [...c.container.querySelectorAll('.crop-h')] as HTMLElement[]
    expect(handles.every(el => el.tabIndex === 0)).toBe(true)
    expect(handles.map(el => el.getAttribute('aria-label'))).toEqual([
      '裁剪框左上角把手；方向键调整大小',
      '裁剪框上边把手；方向键调整大小',
      '裁剪框右上角把手；方向键调整大小',
      '裁剪框右边把手；方向键调整大小',
      '裁剪框右下角把手；方向键调整大小',
      '裁剪框下边把手；方向键调整大小',
      '裁剪框左下角把手；方向键调整大小',
      '裁剪框左边把手；方向键调整大小',
    ])
  })
})

describe('★ 框不许出内接区（旋转留下的空角在它外面）', () => {
  // 内接区收窄到中间一块：x .2~.8 / y .1~.9
  const INNER: CropRect = { x: 0.2, y: 0.1, w: 0.6, h: 0.8 }
  const INSIDE: CropRect = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }

  it('拖角往外 → 停在**内接区的边**上（不是 0 / 1）', async () => {
    const c = await mount({ initial: INSIDE, inner: INNER })
    await drag(c.handle('se'), [600, 450], [4000, 4000])
    const r = c.seen.at(-1)!
    near(r.x, 0.3); near(r.y, 0.3)          // 锚点还在
    near(r.w, 0.5); near(r.h, 0.6)          // 右贴 .8、下贴 .9
  })

  it('拖左上角往外 → 同样停在内接区上', async () => {
    const c = await mount({ initial: INSIDE, inner: INNER })
    await drag(c.handle('nw'), [200, 150], [-4000, -4000])
    const r = c.seen.at(-1)!
    near(r.x, 0.2); near(r.y, 0.1)
  })

  it('平移也进不去空角 —— 往左上拖到头就贴住内接区', async () => {
    const c = await mount({ initial: INSIDE, inner: INNER })
    await drag(c.frame(), [400, 300], [-4000, -4000])
    const r = c.seen.at(-1)!
    near(r.x, 0.2); near(r.y, 0.1)
  })
})

describe('★ 锁了比例：拖的时候宽高比不变', () => {
  it('拖角：另一边跟着长（比例 1:1）', async () => {
    const c = await mount({ initial: { x: 0.25, y: 0.25, w: 0.4, h: 0.4 }, aspect: 1 })
    await drag(c.handle('se'), [520, 390], [80, 0])
    const r = c.seen.at(-1)!
    near(r.w, 0.5); near(r.h, 0.5)        // 只拖了横的，竖的按比例跟上
    near(r.x, 0.25); near(r.y, 0.25)
  })

  it('拖边：另一根轴**以中线为锚**跟着变（比例 1.6）', async () => {
    const c = await mount({ initial: { x: 0.2, y: 0.3, w: 0.4, h: 0.25 }, aspect: 1.6 })
    await drag(c.handle('e'), [480, 300], [80, 0])
    const r = c.seen.at(-1)!
    near(r.w, 0.5); near(r.h, 0.3125)     // 0.5 / 1.6
    near(r.x, 0.2)                         // 左边是锚
    near(r.y, 0.425 - 0.15625)             // 竖着以中线为锚（中线 .425）
  })

  it('锁着比例也不会出内接区', async () => {
    const c = await mount({
      initial: { x: 0.2, y: 0.1, w: 0.4, h: 0.4 }, aspect: 1,
      inner: { x: 0.2, y: 0.1, w: 0.6, h: 0.3 },
    })
    await drag(c.handle('se'), [560, 300], [4000, 4000])
    const r = c.seen.at(-1)!
    near(r.h, 0.3)              // 内接区只有 .3 高 → 正方形边长 .3
    near(r.w, 0.3)
    expect(r.x + r.w).toBeLessThanOrEqual(0.8 + 1e-9)
    expect(r.y + r.h).toBeLessThanOrEqual(0.4 + 1e-9)
  })
})

describe('手势的边界', () => {
  it('松手之后指针再动，框一步都不动', async () => {
    const c = await mount({ initial: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } })
    await drag(c.handle('se'), [600, 450], [40, 40])
    const n = c.seen.length
    await move(700, 500)
    expect(c.seen).toHaveLength(n)
  })

  it('★ 框上的指针事件不冒泡到外面（不然点一下照片就插一个红圈）', async () => {
    let outer = 0
    const c = await mount({ initial: FULL, onOuter: () => { outer++ } })
    await act(async () => {
      c.frame().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 400, clientY: 300 }))
      c.frame().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 300 }))
    })
    expect(outer).toBe(0)
  })

  it('八个把手都在（四角 + 四边），名字对得上', async () => {
    const c = await mount({ initial: FULL })
    expect([...c.container.querySelectorAll('.crop-h')].map(e => e.getAttribute('data-h')))
      .toEqual(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'])
  })
})

describe('构图参考线', () => {
  it('三分 / 黄金分割 / 对角线画在裁剪框里，关闭时一条不画', async () => {
    const thirds = await mount({ initial: FULL, guide: 'thirds' })
    expect(thirds.container.querySelectorAll('.crop-guides line')).toHaveLength(4)
    const golden = await mount({ initial: FULL, guide: 'golden' })
    expect(golden.container.querySelectorAll('.crop-guides line')).toHaveLength(4)
    const diagonal = await mount({ initial: FULL, guide: 'diagonal' })
    expect(diagonal.container.querySelectorAll('.crop-guides line')).toHaveLength(2)
    const off = await mount({ initial: FULL, guide: 'off' })
    expect(off.container.querySelector('.crop-guides')).toBeNull()
  })
})
