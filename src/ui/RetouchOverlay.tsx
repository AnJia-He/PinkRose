import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { stampBrush, stampStroke, type BrushMode } from '../core/retouch'

/**
 * 照片上的**涂抹层**（★ 2026-10-07，点修）—— 用户在这一层上涂，涂出来的东西
 * 是**掩码**（`Uint8Array`，图片像素尺寸；越大擦得越实）。
 *
 * 分工：这一层只干两件事 ——
 *   ① **换算**：指针（屏幕像素）→ 图片像素。口径只有一条：
 *      `图片 = (指针 − 层的屏幕原点 − 盒子偏移) ÷ 盒子尺寸 × 图片尺寸`。
 *      盒子是 `Canvas` 量出来的照片可见矩形（缩放/平移它都会跟着变），
 *      所以放大着涂也落得准。
 *   ② **盖章 + 画预览**：盖章进掩码（`core/retouch` 的纯函数），
 *      预览只重画**这一笔扫过的脏矩形**（红色 = 擦的强度）——
 *      整张重画在 1200 万像素的照片上每帧要几千万次读写，拖起来就断。
 *
 * ⚠️ **预览画的是掩码本身**（不是"笔画历史"）：橡皮擦掉的地方预览也跟着没
 *    —— 两条路共用一个事实来源，不会各说各话。
 * ⚠️ 拖动这条线索挂在 **window** 上（和 `CropOverlay` / `Canvas` 的平移同一条
 *    规矩）：手拖出照片区是常态；**也别用 `setPointerCapture`**（`StepStrip`
 *    踩过：一捕获，紧随的那一下 click 会被吃掉）。
 * ⚠️ 它**盖住整个照片区并把指针事件关在门里**（和 `.crop` 同一套）：
 *    点修开着时，"按住看原图 / 拖动平移 / 图上点选"都不该被误触发。
 *    滚轮**不拦**：放大着修细节正是这个工具的用法（`Canvas` 的滚轮挂在
 *    wrap 上，事件从这儿冒泡上去照样收得到）。
 * ⚠️ 按下必须落在**照片里面**（左右留白上按一下不该起笔）；但拖出去不断笔 ——
 *    章会被图片边界裁掉，拖回来接着画。
 */
export type RetouchBox = { left: number; top: number; width: number; height: number }

export default function RetouchOverlay(props: {
  box: RetouchBox
  imageWidth: number
  imageHeight: number
  /** 画笔半径（**图片像素**）。 */
  radius: number
  mode: BrushMode
  /** 掩码（图片像素尺寸）。组件**原地**往里盖章 —— 它是一块大缓冲区，不做不可变。 */
  mask: Uint8Array
  /** 掩码有实际改动时喊一声（App 拿它让「擦掉这里」亮起来）。 */
  onMaskChange: () => void
}) {
  const { box, imageWidth: W, imageHeight: H, radius, mode, mask, onMaskChange } = props
  const layerRef = useRef<HTMLDivElement | null>(null)
  const previewRef = useRef<HTMLCanvasElement | null>(null)
  /** 这一笔的落脚点（图片坐标）+ 按下那一刻量的层原点。null = 没在画。 */
  const strokeRef = useRef<{ lastX: number; lastY: number; ox: number; oy: number } | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  const toImage = (clientX: number, clientY: number, ox: number, oy: number) => ({
    x: ((clientX - ox - box.left) / box.width) * W,
    y: ((clientY - oy - box.top) / box.height) * H,
  })

  /** 预览：把 [from, to] 扫过的脏矩形从**掩码**重画一遍（红 = 擦的强度）。 */
  const paintPreview = (fx: number, fy: number, tx: number, ty: number) => {
    const canvas = previewRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const margin = radius + 2
    const x0 = Math.max(0, Math.floor(Math.min(fx, tx) - margin))
    const y0 = Math.max(0, Math.floor(Math.min(fy, ty) - margin))
    const x1 = Math.min(W, Math.ceil(Math.max(fx, tx) + margin))
    const y1 = Math.min(H, Math.ceil(Math.max(fy, ty) + margin))
    if (x1 <= x0 || y1 <= y0) return
    const img = ctx.createImageData(x1 - x0, y1 - y0)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = mask[y * W + x]!
        const i = ((y - y0) * (x1 - x0) + (x - x0)) * 4
        img.data[i] = 255
        img.data[i + 1] = 64
        img.data[i + 2] = 64
        img.data[i + 3] = Math.round((v / 255) * 140)
      }
    }
    ctx.putImageData(img, x0, y0)
  }

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const el = layerRef.current
    if (!el) return
    // 鼠标只认左键（右键留给系统菜单 / 将来的右键擦除，别顺手起笔）
    if (e.pointerType === 'mouse' && e.button !== 0) return
    stopRef.current?.()
    const r = el.getBoundingClientRect()
    const p = toImage(e.clientX, e.clientY, r.left, r.top)
    // 起笔必须在照片里面（留白上按一下不算）
    if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) return
    strokeRef.current = { lastX: p.x, lastY: p.y, ox: r.left, oy: r.top }
    if (stampBrush(mask, W, H, p.x, p.y, radius, mode)) onMaskChange()
    paintPreview(p.x, p.y, p.x, p.y)

    const onMove = (ev: PointerEvent) => {
      const s = strokeRef.current
      if (!s) return
      const q = toImage(ev.clientX, ev.clientY, s.ox, s.oy)
      if (stampStroke(mask, W, H, s.lastX, s.lastY, q.x, q.y, radius, mode)) onMaskChange()
      paintPreview(s.lastX, s.lastY, q.x, q.y)
      s.lastX = q.x
      s.lastY = q.y
    }
    /** 三种"松手"共用它：抬手、系统把指针抢走（来电、通知、滚动接管）。 */
    const end = () => {
      strokeRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (stopRef.current === end) stopRef.current = null
    }
    stopRef.current = end
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  /** 悬停时那圈光标（只在层内跟；出去了就收）。 */
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const r = layerRef.current?.getBoundingClientRect()
    if (!r) return
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })
  }

  /** 组件真走掉时，把还挂在 window 上的那套收干净（和 `Canvas` 同一条）。 */
  useEffect(() => () => stopRef.current?.(), [])

  // 光标圈的屏幕直径 = 图片半径 × 显示比例 × 2（下限 6px：小笔刷也得看得见）
  const scale = box.width / W
  const cursorSize = Math.max(6, radius * scale * 2)

  return (
    <div
      ref={layerRef}
      className="retouch"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setCursor(null)}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <canvas
        ref={previewRef}
        className="retouch-mask"
        width={W}
        height={H}
        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      />
      {cursor && (
        <span
          className="retouch-cursor"
          style={{
            left: cursor.x, top: cursor.y,
            width: cursorSize, height: cursorSize,
            marginLeft: -cursorSize / 2, marginTop: -cursorSize / 2,
          }}
        />
      )}
    </div>
  )
}
