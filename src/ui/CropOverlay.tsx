import { useEffect, useState } from 'react'
import { MIN_SIDE, type CropRect } from '../core/crop'
import { bindWindowDrag } from './kit/windowDrag.ts'

/**
 * 照片上那个裁剪框（★ 2026-10-06）。
 * 它只认三件事：**照片盒子在屏幕上的位置**（`box`，由 `Canvas` 量好传进来）、
 * **归一化矩形**、**当前比例档**；外加一根硬规矩 —— 框只能在**内接区**（`inner`）里。
 * 拖拽全换算成那个 0~1 的矩形再喊出去 —— 所以在任何屏幕尺寸上落点都对得上。
 *
 * ⚠️ 它画在**剪裁层外面**（和红圈同一个待遇）：框的把手正好挂在照片边上，
 *    剪在里头会被切掉半个。
 *
 * ⚠️ **框不许拖进旋转留下的空角**（`inner` 就是"不碰空角的居中最大矩形"，
 *    见 `core/crop.ts` 文件头那根接力棒）。所以拖动 / 缩放**每一步都要夹**：
 *    只靠"角度变了重置一次"是不够的 —— 用户随后一拖就能把角拖进空白里，
 *    而"永远不裁出空白角"这句话正是在这儿才成立的。
 */

/** 照片（转完之后的**外框**）在屏幕上的位置，单位像素。`Canvas` 量的就是它。 */
export type CropBox = { left: number; top: number; width: number; height: number }

/** 八个把手：四角 + 四边。`data-h` 就是它们的名字，拖动算法按它分支。 */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type Handle = (typeof HANDLES)[number]

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * **自由比例**：被拖的那条边自己走、对面那条边是锚 —— 到了内接区的边或最小边就停。
 * （两条轴互不相干，所以横竖各夹各的。）
 */
function resizeFree(at: Handle, r0: CropRect, dx: number, dy: number, inner: CropRect): CropRect {
  let { x, y, w, h } = r0
  if (at.includes('w')) {
    // 左边在走：右边是锚 —— 最多走到"离锚还剩一个最小边"
    const nx = clamp(r0.x + dx, inner.x, r0.x + r0.w - MIN_SIDE)
    x = nx
    w = r0.x + r0.w - nx
  }
  if (at.includes('e')) w = clamp(r0.w + dx, MIN_SIDE, inner.x + inner.w - r0.x)
  if (at.includes('n')) {
    const ny = clamp(r0.y + dy, inner.y, r0.y + r0.h - MIN_SIDE)
    y = ny
    h = r0.y + r0.h - ny
  }
  if (at.includes('s')) h = clamp(r0.h + dy, MIN_SIDE, inner.y + inner.h - r0.y)
  return { x, y, w, h }
}

/**
 * **锁了比例**：不论抓的是角还是边，算出来的永远是"合法的宽"，高由比例带出来。
 *
 * 锚在哪（决定了"最多能有多大"）：
 *   · 拖左/右边 → 对边是锚，另一根轴**以中线为锚**（不然拖一下框会整体平移）；
 *   · 拖角 → 对角是锚。
 * 角上两根轴同时在动，以**动得多的那根**为准 —— 不然两边会互相打架，
 * 手感变成"拖了半天不动"。
 *
 * ⚠️ `aspect` 是**归一化**空间的 w/h（外框的宽高不等时它 ≠ 像素比），
 *    换算在 `App`：像素比 × bounds.h / bounds.w。
 */
function resizeFixed(
  at: Handle, r0: CropRect, dx: number, dy: number, aspect: number, inner: CropRect,
): CropRect {
  const right = r0.x + r0.w
  const bottom = r0.y + r0.h
  const cx = r0.x + r0.w / 2
  const cy = r0.y + r0.h / 2
  const onX = at.includes('w') || at.includes('e')
  const onY = at.includes('n') || at.includes('s')
  const byX = onX && (!onY || Math.abs(dx) >= Math.abs(dy))

  let w: number
  if (byX) {
    w = at.includes('w') ? right - (r0.x + dx) : (right + dx) - r0.x
  } else {
    const hWant = at.includes('n') ? bottom - (r0.y + dy) : (bottom + dy) - r0.y
    w = hWant * aspect
  }

  // 两条边都得够最小边（h = w / aspect 也要 ≥ MIN_SIDE）
  const wMin = Math.max(MIN_SIDE, MIN_SIDE * aspect)
  // 横着最多能多大（锚点 / 内接区）……
  const wMaxX = at.includes('w') ? right - inner.x
    : at.includes('e') ? inner.x + inner.w - r0.x
      : 2 * Math.min(cx - inner.x, inner.x + inner.w - cx)
  // ……竖着呢（乘回比例就是宽的说法）
  const wMaxY = (at.includes('n') ? bottom - inner.y
    : at.includes('s') ? inner.y + inner.h - r0.y
      : 2 * Math.min(cy - inner.y, inner.y + inner.h - cy)) * aspect
  w = clamp(w, wMin, Math.min(wMaxX, wMaxY))
  const h = w / aspect

  return {
    x: at.includes('w') ? right - w : at.includes('e') ? r0.x : cx - w / 2,
    y: at.includes('n') ? bottom - h : at.includes('s') ? r0.y : cy - h / 2,
    w, h,
  }
}

/** 整体平移：框的大小一点不动，位置夹在内接区里。 */
function moveRect(r0: CropRect, dx: number, dy: number, inner: CropRect): CropRect {
  return {
    x: clamp(r0.x + dx, inner.x, inner.x + inner.w - r0.w),
    y: clamp(r0.y + dy, inner.y, inner.y + inner.h - r0.h),
    w: r0.w, h: r0.h,
  }
}

/**
 * 这一次按下。`from` 是**按下那一刻**的框 —— 拖的过程里一直拿它算，
 * 别去读 `props.rect`（那是"上一次喊出去的结果"，读它会自己追自己）。
 *
 * ⚠️ 盒子 / 内接区 / 比例 / 回调也**一起拍了下来**：拖的过程中它们一个都不会变
 *    （用户不可能一边拖一边点第二行），而拍下来之后那条监听 effect 的依赖
 *    就只剩 `drag` 一个 —— 不必每帧重挂监听器。
 */
type Drag = {
  at: Handle | 'move'
  from: CropRect
  x0: number
  y0: number
  box: CropBox
  inner: CropRect
  aspect: number | null
  onRect: (r: CropRect) => void
}

export default function CropOverlay(props: {
  box: CropBox
  rect: CropRect
  /** 归一化的宽高比（w/h）。null = 自由。见 `resizeFixed` 上面那段 ⚠️ */
  aspect: number | null
  /** 框只能在它里面（旋转留下的四个空角在它外面）。 */
  inner: CropRect
  onRect: (r: CropRect) => void
}) {
  const [drag, setDrag] = useState<Drag | null>(null)

  const begin = (at: Handle | 'move') => (e: React.PointerEvent) => {
    // 把手住在框里、框住在这层里 —— 不让它冒泡的话，抓个角会变成"整体平移"
    e.stopPropagation()
    setDrag({
      at, from: props.rect, x0: e.clientX, y0: e.clientY,
      box: props.box, inner: props.inner, aspect: props.aspect, onRect: props.onRect,
    })
  }

  /**
   * 拖动那条线索挂在 **window** 上（和 `Canvas` 的平移、`StepStrip` 的转圈同一条
   * 规矩）：手拖出照片区是常态，挂在框上拖出去就断了。
   * ⚠️ **别用 `setPointerCapture`** —— 一捕获，紧随其后的那一下 `click` 会落到
   * 容器上（`StepStrip` 真踩过）。
   */
  useEffect(() => {
    if (!drag) return
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - drag.x0) / drag.box.width
      const dy = (e.clientY - drag.y0) / drag.box.height
      drag.onRect(drag.at === 'move'
        ? moveRect(drag.from, dx, dy, drag.inner)
        : drag.aspect === null
          ? resizeFree(drag.at, drag.from, dx, dy, drag.inner)
          : resizeFixed(drag.at, drag.from, dx, dy, drag.aspect, drag.inner))
    }
    // 三种"松手"（抬手 / 被抢走 / 取消）那条规矩在 `kit/windowDrag` 里；
    // cleanup 走 `detach`（只摘监听，不触发收场）。
    const d = bindWindowDrag(onMove, () => setDrag(null))
    return d.detach
  }, [drag])

  const { box, rect } = props
  const frame = {
    left: box.left + rect.x * box.width,
    top: box.top + rect.y * box.height,
    width: rect.w * box.width,
    height: rect.h * box.height,
  }

  return (
    /* 框外那圈用暗罩压住（"要留下的那块"亮着，spec §3.1）—— 暗罩是 `.crop-frame`
       那一条 `box-shadow` 铺出去的，不画四个矩形。
       ⚠️ 这一层（`.crop`）盖住**整块照片区**，并且把指针事件**关在门里**：
         · 裁着的时候点一下照片不该插红圈（点选那条路和裁剪是两个模式）；
         · `viewLocked` 只挡住了缩放那一套，`handlePick` 那条不归它管。
       暗罩只铺到照片区为止（`overflow: hidden` 收在这儿）—— 不受限制的话
       它会顺着 box-shadow 糊到左边的预设栏和上下的带子上去。 */
    <div
      className="crop"
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <div className="crop-frame" style={frame} onPointerDown={begin('move')}>
        {HANDLES.map(h => (
          <span key={h} className="crop-h" data-h={h} onPointerDown={begin(h)} />
        ))}
      </div>
    </div>
  )
}
