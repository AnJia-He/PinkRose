import { Fragment, useCallback, useEffect, useRef } from 'react'

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
  /** 正在**生成**（不是「正在思考」那 1.5 秒）—— 为真时摆那颗占位块。 */
  generating: boolean
  /** 这张照片的宽 / 高，占位块按它定宽（换真图时不跳）。不传退回 CSS 那条兜底。 */
  aspectRatio?: number
  onJump: (id: number) => void
}

/**
 * ★ 2026-10-06：**照片区上方那条历史时间轴**（用户画了草图提的：
 * 「对话区不留下照片了…下方是当前图片，上方是可左右滚动的历史记录照片
 * 类似于 git 吧也就是回到那一步，下方对应记录的图片」）。
 *
 * 三件事：
 *   · 一步一格，格子之间有线连着（像 git 的提交链）—— **原图也占一格**；
 *   · 点某一格 = 回到那一步（`onJump`，和对话里那颗「回到这一步」**同一个函数**，
 *     「跳转不删任何东西」那套契约一个字都不动）；
 *   · 站的那一格是**位置标记不是按钮**（`<span aria-current="step">`），
 *     和对话里那颗「你在这里」同一条规矩 —— "我在哪"在这条轴上随时有答案。
 *
 * ⚠️ 格子里的图**直接用 `history` 里现成的小图**（客户端早就为每一步画好了，
 *    对话区原来挂的就是它）—— 这里一格都不新画。
 * ⚠️ 生成中在**站的那一格后面**挂一颗占位块，不是整条尾巴：从旧步骤重掷时，
 *    新的一版落地就顶掉后面那几步，占位块得指在东西真正会出现的地方。
 *    （对话里原来那块 `.shot-skeleton` 就是搬到这儿来的。）
 * ⚠️ 可左右滚动（用户点名要的）：步数多了这条轴自己滚，并把站的那一格
 *    带到视野里 —— 滚动只动这条轴自己的 `scrollLeft`，别去碰整页。
 */
export default function StepStrip({ steps, currentId, generating, aspectRatio, onJump }: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null)

  /**
   * 把"站的那一格"（生成中则是那颗占位块）滑到视野中间。
   *
   * ⚠️ 不用 `scrollIntoView`：jsdom 里没有它（测试一调用就抛），而且它会
   *   顺带滚整页。算 `scrollLeft` 的话两样都不会发生（jsdom 里量到的都是 0，
   *   等于无害的空转）。
   * ⚠️ 小图是**后来才长出来的**（data URL 挂上那一刻宽度才有）—— 所以每张图
   *   `onLoad` 再对一次位置，不然"滑到中间"滑的是还没有宽度的格子。
   */
  const recenter = useCallback(() => {
    const el = trackRef.current
    if (!el) return
    const target = el.querySelector<HTMLElement>(
      generating ? '.strip-pending' : '.strip-node.current')
    if (!target) return
    el.scrollLeft = Math.max(0, target.offsetLeft - (el.clientWidth - target.offsetWidth) / 2)
  }, [generating])

  useEffect(() => { recenter() }, [recenter, currentId, steps.length])

  const thumbOf = (s: StripStep) =>
    // 空串 = 还没画出来。**不画空 `<img>`** —— 那会是一个破图图标，看着像加载失败
    //（和预设栏、滤镜格子同一条规矩）。
    s.thumb
      ? <img className="strip-thumb" src={s.thumb} alt="" draggable={false} onLoad={recenter} />
      : null

  const pending = (
    <span className="strip-pending" aria-hidden="true"
      style={aspectRatio ? { aspectRatio } : undefined} />
  )
  // 站的那一格在清单里吗（不在 = 没有会话之类的边角，占位块退回挂到尾巴上）。
  const pendingAfterCurrent = generating && steps.some(s => s.id === currentId)

  return (
    <div className="strip" ref={trackRef} role="group" aria-label="历史记录">
      {steps.map((s, i) => {
        const current = s.id === currentId
        // 名字只给读屏和悬停提示看（格子上是图，没有字）。
        // 编号跟着**清单里的位置**走：原图是第 0 格，第一次生成是"第 1 步"
        // ——和项目里其它地方「第 N 步」的口径一致。
        const name = s.isOriginal ? '原图' : `第 ${i} 步`
        return (
          <Fragment key={s.id}>
            {/* 格子和格子之间的连线（第一格前面没有）。 */}
            {i > 0 && <span className="strip-link" aria-hidden="true" />}
            {current ? (
              <span className="strip-node current" aria-current="step" title={name}>
                {thumbOf(s)}
              </span>
            ) : (
              <button className="strip-node" title={name}
                aria-label={`回到这一步：${name}`} onClick={() => onJump(s.id)}>
                {thumbOf(s)}
              </button>
            )}
            {pendingAfterCurrent && current && pending}
          </Fragment>
        )
      })}
      {/* 兜底：站的那一格不在清单里（比如还没有会话）时，占位块挂尾巴上。 */}
      {generating && !pendingAfterCurrent && (
        <Fragment>
          <span className="strip-link" aria-hidden="true" />
          {pending}
        </Fragment>
      )}
    </div>
  )
}
