import { useCallback, useEffect, useRef, useState } from 'react'

/** 一步的样子 —— App 从 `history` 里挑出这三样交给它（位图和参数这里用不上）。 */
export type StripStep = {
  id: number
  thumb: string
  isOriginal: boolean
}

type Props = {
  /** 原图 + 每一步（顺序和 `history` 一样，原图永远在最前）。 */
  steps: readonly StripStep[]
  /** 现在站在哪一步。`null` = 没有会话（谁都不标）。 */
  currentId: number | null
  /** 正在**生成**（不是「正在思考」那 1.5 秒）—— 为真时摆那颗占位格子。 */
  generating: boolean
  onJump: (id: number) => void
}

/**
 * 转盘的格距（度）。**一共六格、每格 60°** —— 和 `MAX_SNAPSHOTS`（6）对齐：
 * 一步一格，格子不够时剩下的位置空着，六格满了就没有空位了（见占位块那段）。
 * ⚠️ 别改成"按步数均分 360°"：两步时第二格会跑到**正后方**（背朝镜头、
 * 看不见也点不到），用户只会觉得"我的第二步去哪了"。固定 60° 时它永远在侧面。
 */
const STEP = 60
/**
 * 圆环的半径和相机距离（px）。这两个数是在画板上调出来的（用户在那里挑的
 * "竖轴转盘"），别随手改：半径小了整圈缩在中间、四周空一片；透视太强
 * （数小）时两侧的格子会被压成一条缝 —— 那一版他一眼就看出来了。
 */
const RADIUS = 200
const PERSPECTIVE = 1400

function norm(a: number) {
  return ((a % 360) + 540) % 360 - 180
}
function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}
/**
 * 窄屏（≤640）走的是**另一套**：`styles.css` 里那条媒体查询把 3D 整个中和掉、
 * 变回"平铺可滑的一条"。所以这一档**不接管拖动** —— 拖 = 滚动那条，
 * 转盘的角度在这里只是个不生效的数字。
 * （为什么窄屏不上转盘：130px 的圈会把照片挤到"还看得见"那条线以下，
 * 量过；何况 web 这版本来就是给电脑用的。）
 */
function isNarrow() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 640px)').matches
}

/**
 * ★ 2026-10-06（晚）：**照片区上方那圈历史转盘**（`ui/StepStrip`）。
 *
 * 来路：用户先画了草图（"上方历史、下方当前图片"，像 git），我做成了一条平铺
 * 可滑的时间轴；他看完说「我画的是一种圆盘转动的感觉吧」—— 于是开了画板，
 * 三种转盘（竖轴转盘 / 斜看整块圆盘 / 横排弧）真尺寸摆出来让他玩，
 * 他挑了 **A · 竖轴转盘**（画板会话：`.superpowers/brainstorm/398-1791272118`）。
 *
 * 玩法（和画板里那版一字不差）：
 *   · 一步一格摆在一个圆的边上，**站的那一格在正面**（最大最亮），两边的
 *     转身、后退、变暗，绕过去的那几格背朝镜头（`backface-visibility`）；
 *   · **按住左右拖 = 转**，松手自动吸附到最近一格；**点某一格 = 把它转到正面**
 *     （也就是回到那一步，下面大图跟着换）；
 *   · 从外面把"站的位置"挪了（对话里点「回到这一步」、恢复会话）→ 整圈自己转过去；
 *   · 生成中，一颗会扫光的空格子摆在**队尾的后一格**（新的一版会落在那儿）。
 *
 * ⚠️ 转盘的角度**不是新的一份真相**：它只是 `currentId` 的另一种画法。
 *   拖动时先把圈转过去、再喊 `onJump`（下面大图跟着换，和画板里一样）；
 *   从外面跳步时反过来 —— `currentId` 变了就把圈转向它（那条 effect）。
 *   两条路都通向"正面那格 = 当前这步"，别让它们各说各话。
 */
export default function StepStrip({ steps, currentId, generating, onJump }: Props) {
  const stripRef = useRef<HTMLDivElement | null>(null)

  /** 转盘现在的角度（度）。`0` = 第一格在正面；越负越往前（更晚的步骤）。 */
  const [rot, setRot] = useState(
    () => -Math.max(0, steps.findIndex(s => s.id === currentId)) * STEP)
  /**
   * 角度的**影子 ref** —— 拖动处理器里要读"当下的"角度。
   * 和 App 的 `cursorIdRef` 是同一条规矩：**state 和 ref 必须一起写**，
   * 读 state 会读到上一次渲染的旧值（拖起来会一顿一顿、吸附也吸附错）。
   */
  const rotRef = useRef(rot)
  function turn(next: number) {
    rotRef.current = next
    setRot(next)
  }

  /** 正在拖。拖的时候关掉 CSS 过渡（否则每一帧都在追动画）。 */
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ lastX: number; moved: number; at: number } | null>(null)
  /** 上一次手势一共挪了多少像素 —— 拖动结束后那一发 click 不该再触发跳步。 */
  const lastMovedRef = useRef(0)

  /** 转盘能转到哪儿：0（第一格在正面）到 -(最后一格) —— 两端到头即止，不绕圈。 */
  const lo = -(steps.length - 1) * STEP
  /** 角度 → 离正面最近的那一格。 */
  const nearest = useCallback(
    (r: number) => clamp(Math.round(-r / STEP), 0, steps.length - 1), [steps.length])

  /**
   * 外面把"站的位置"挪了 → 整圈自己转过去把那一格送到正面。
   * ⚠️ 拖动的过程中**不抢方向盘**（`dragging` 那一格）：拖动那条路是
   * "先转圈、再 onJump"，这时候 currentId 正跟着手指走，再被这里按一下
   * 圈会一顿一顿的。松手之后会吸附到整格，两边自然对齐。
   */
  useEffect(() => {
    if (dragging) return
    const i = steps.findIndex(s => s.id === currentId)
    if (i < 0) return
    const target = -i * STEP
    // 已经在它附近（±半格以内）就不动 —— 每渲染一次都重设角度会把吸附动画打断
    if (Math.abs(norm(target - rotRef.current)) > 30) turn(target)
  }, [currentId, steps, dragging])

  /** 起手。⚠️ 窄屏不接管（那一档拖 = 滚动平铺的那条）。 */
  function onPointerDown(e: React.PointerEvent) {
    lastMovedRef.current = 0
    if (isNarrow()) return
    dragRef.current = { lastX: e.clientX, moved: 0, at: nearest(rotRef.current) }
    setDragging(true)
  }

  /**
   * 拖动：监听挂 window 上、**不用 `setPointerCapture`** —— 一捕获，
   * pointerup 的目标就变成容器了，跟着派发的 click 也落在容器上，
   * "点一格转到正面"会整个失灵（写画板那版时踩过）。
   */
  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = e.clientX - d.lastX
      d.lastX = e.clientX
      d.moved += Math.abs(dx)
      const next = clamp(rotRef.current + dx * 0.42, lo, 0)
      turn(next)
      const i = nearest(next)
      if (i !== d.at) {
        // 一边转一边把大图换过去（画板里就是这样，别等到松手才换）
        d.at = i
        const id = steps[i]?.id
        if (id !== undefined) onJump(id)
      }
    }
    const up = () => {
      const d = dragRef.current
      dragRef.current = null
      setDragging(false)
      if (d) lastMovedRef.current = d.moved
      const snapped = clamp(Math.round(rotRef.current / STEP) * STEP, lo, 0)
      turn(snapped)
      const i = nearest(snapped)
      if (d && i !== d.at) {
        const id = steps[i]?.id
        if (id !== undefined) onJump(id)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [dragging, steps, nearest, onJump, lo])

  /**
   * 窄屏那条平铺的会自己滚 —— 把"站的那一格"带到视野里。
   * 桌面（转盘）上这函数是空转：容器不可滚，而且量出来都是 0。
   */
  const recenter = useCallback(() => {
    if (!isNarrow()) return
    const el = stripRef.current
    if (!el) return
    const target = el.querySelector<HTMLElement>('.strip-node.current')
    if (!target) return
    el.scrollLeft = Math.max(0, target.offsetLeft - (el.clientWidth - target.offsetWidth) / 2)
  }, [])
  useEffect(() => { recenter() }, [recenter, currentId, steps.length])

  /**
   * 占位格子落在**队尾的后一格**（六格满了就没地方了 → 不摆）。
   * 站在最新一步重掷时，它正好是"新的一版会出现的位置"。
   */
  const pendingSlot = generating && steps.length < 6 ? steps.length : null

  const itemStyle = (slot: number): React.CSSProperties => {
    const a = norm(slot * STEP + rot)
    return {
      transform: `rotateY(${slot * STEP}deg) translateZ(${RADIUS}px)`,
      // 正面的最亮，转到侧后方的变暗（和背面的 hidden 一起构成"转过去"的感觉）
      opacity: Math.max(0.12, 0.22 + 0.78 * Math.cos((a * Math.PI) / 180)),
    }
  }

  return (
    <div className="strip" ref={stripRef} role="group" aria-label="历史记录"
      onPointerDown={onPointerDown}>
      <div className="strip-ring"
        style={{
          transform: `perspective(${PERSPECTIVE}px) rotateY(${rot}deg)`,
          transition: dragging ? 'none' : 'transform .45s cubic-bezier(.16,1,.3,1)',
        }}>
        {steps.map((s, i) => {
          const current = s.id === currentId
          // 名字只给读屏和悬停提示看（格子上是图，没有字）。
          // 编号跟着**清单里的位置**走：原图是第 0 格，第一次生成是"第 1 步"。
          const name = s.isOriginal ? '原图' : `第 ${i} 步`
          // 空串 = 还没画出来。**不画空 `<img>`** —— 那会是一个破图图标。
          const thumb = s.thumb
            ? <img className="strip-thumb" src={s.thumb} alt="" draggable={false}
                onLoad={recenter} />
            : null
          return current ? (
            // 站的那一格**不是按钮**（点不动）—— 和对话里那颗「你在这里」同一条规矩。
            <span key={s.id} className="strip-node current" aria-current="step"
              title={name} style={itemStyle(i)}>{thumb}</span>
          ) : (
            <button key={s.id} className="strip-node" title={name} style={itemStyle(i)}
              aria-label={`回到这一步：${name}`}
              onClick={() => { if (lastMovedRef.current <= 8) onJump(s.id) }}>
              {thumb}
            </button>
          )
        })}
        {pendingSlot !== null && (
          <span className="strip-pending" aria-hidden="true" style={itemStyle(pendingSlot)} />
        )}
      </div>
    </div>
  )
}
