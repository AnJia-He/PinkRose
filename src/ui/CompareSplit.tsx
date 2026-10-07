import { useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react'
import { ChevronsLeftRight } from 'lucide-react'

/**
 * 对比分屏（★ 2026-10-06，spec §3.3）：**左「原图」、右「现在」，中间一条能拖的把手**。
 *
 * 三条硬规矩（错一条都**不报错**，只是画面悄悄不对）：
 *
 *   ① **原图那一层住在剪裁层里、和画布贴同一个变换。** 两份是"同一张位置上的
 *      两张图"，差一点就对不齐 —— 放大之后尤其明显（边会错开一截）。
 *      `transform` 这个 prop 就是 `Canvas` 递给画布的那一份（`stageStyle`）。
 *
 *   ② **剪的是那一层不动的盒子，不是 `<img>`。** `<img>` 自己吃的是图片那个
 *      变换（放大 / 平移时它跟着动），剪在它身上那条分界线会**跟着照片跑**，
 *      和把手对不上；剪在这层（和照片区一样大、不吃变换）上，分界线才是
 *      "屏幕上的那一条"。
 *
 *   ③ **把手不随图片缩放**：它挂在照片区里、和剪裁层平级（不在它里面 ——
 *      剪裁层在放大时有 `overflow: clip`，而且它读的是同一个 `--split`）。
 *      拖动那条线索挂在 **window** 上（手拖到照片区外面是常态），
 *      ⚠️ **别改用 `setPointerCapture`** —— 一捕获，紧接着那一下 `click`
 *      会落到容器上（`StepStrip` 真踩过）。
 *
 * 比的是**原图**（和「按住看原图」同一个"原图"）—— 不是上一步（spec §3.3：
 * "刚才那条指令生效了吗"是另一个问题，真要做是第二颗按钮的事）。
 */
export const SPLIT_MIN = 5
export const SPLIT_MAX = 95
/** 挂上来分在正中间（一半一半）—— 一半原图一半现在的对比才是这个工具的意义。 */
const SPLIT_START = 50

/** 夹进 5%~95%：拖到照片区外面那一截不该把分屏整条甩出去（甩出去就再也抓不回来）。 */
function clampSplit(pct: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct))
}

/** 这一次按下量到的照片区。⚠️ 量**一次**（按下那一刻）—— 拖的过程中它不会变，
 *  而在 pointermove 里现量就是每帧读一次布局。 */
type Drag = { left: number; width: number }

export default function CompareSplit(props: {
  /** 原图的 data URL（App 备好的那一份，长边 ≤ 2048；**不是** 480 的缩略图）。 */
  src: string
  /** 和画布**同一个**变换（`Canvas` 的 `stageStyle`，适应窗口时是 undefined）。 */
  transform?: CSSProperties
}) {
  /** 分屏在哪（0~100 的百分比）。**它同时喂 `--split`** —— 剪裁层和把手都读那个变量。 */
  const [split, setSplit] = useState(SPLIT_START)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)

  useEffect(() => {
    if (!drag) return
    const onMove = (e: PointerEvent) => {
      setSplit(clampSplit(((e.clientX - drag.left) / drag.width) * 100))
    }
    // 三种"松手"共用它：抬手、系统把指针抢走（来电、通知、滚动接管）——
    // 少接一个，用户按一下就会被永久留在拖动状态里。
    const end = () => setDrag(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [drag])

  /**
   * 按在把手上。
   * ⚠️ `stopPropagation` 不是可选的：这一下会冒到 `.canvas-wrap` 上，
   *    那边等着的是"按住看原图"（0.15 秒之后照片闪一下）和拖动平移 ——
   *    拖把手的同一趟里照片会跟着平移。
   */
  const gripDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    const box = rootRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return
    setDrag({ left: box.left, width: box.width })
  }
  /** 点一下 / 双击把手不该被照片接走（双击在那边是"怼到 100%"）。 */
  const swallow = (e: SyntheticEvent) => e.stopPropagation()

  return (
    <div
      ref={rootRef}
      className="compare"
      // `--split` 挂在这一层：下面的剪裁层和把手**都读它**（一个真相、两处用）。
      // 组件卸载时它跟着这一层一起没 —— 退出对比不留痕（App/`Canvas` 不用清）。
      style={{ '--split': `${split}%` } as CSSProperties}
    >
      {/* 剪裁层：和 `.canvas-clip` 是同一套盒子 / 同一套剪裁规矩（它在放大时
          要把伸出照片区的那截剪掉）—— 原图这份不剪的话放大后会糊到上面那条
          带子和右边对话栏上。 */}
      <div className="canvas-clip">
        <div
          className="compare-layer"
          // 只露左边那一半：`calc(100% - 50%)` = 右边收进去一半。
          // ⚠️ 写在**这一层**上（理由见文件头 ②）。
          style={{ clipPath: 'inset(0 calc(100% - var(--split)) 0 0)' }}
        >
          {/* 和画布同一个 transform —— 两张图是同一张位置上的两张图 */}
          <img
            className="compare-img" src={props.src} alt="原图"
            draggable={false} style={props.transform}
          />
        </div>
      </div>
      {/* 把手：**不在剪裁层里**、也不吃图片那个变换 —— 它不随图片缩放。 */}
      <div
        className="compare-handle" style={{ left: 'var(--split)' }}
        onPointerDown={gripDown} onClick={swallow} onDoubleClick={swallow}
      >
        <span className="compare-knob" aria-hidden="true"><ChevronsLeftRight size={15} strokeWidth={1.5} /></span>
      </div>
    </div>
  )
}
