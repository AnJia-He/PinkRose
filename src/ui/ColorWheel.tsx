import type { PointerEvent } from 'react'
import { axesToWheel, wheelToAxes, type ColorBalanceAxes } from '../core/colorBalance.ts'

/**
 * 色轮 —— 「色彩平衡」三根轴的二维视图（88px 色相环 + 一个可拖的点）。
 *
 * ★ 它不是参数：拖色轮 = **零和地**同时写那三根轴（纯色偏、不动明暗），
 *   拖某根轴 = 这里的点跟着走到新的色偏方向。数学在 `src/core/colorBalance.ts`。
 *
 * ⚠️ `aria-hidden` 是**故意的，不是漏了无障碍**：键盘 / 读屏的**等价通路是旁边
 * 那三根轴**（三根普通滑块，能到色轮能到的每一个位置，且各自有名字和
 * `aria-valuenow`）。所以这里不挂 tabIndex、不给读屏名字 —— 它只是鼠标/触摸
 * 用户的快捷方式。**别顺手把它变可达**：那样读屏会多听到一个没有名字、
 * 报不出值的控件。
 *
 * ★ `data-x` / `data-y` = 圆点当前坐标的字符串形式 —— Task 5 的"套预设后色轮
 *   归中心"那条测试按它认。两个都要写、拖完要跟着变（受控组件，天然跟着）。
 */
export function ColorWheel(props: {
  axes: ColorBalanceAxes
  onChange: (next: ColorBalanceAxes) => void
}) {
  const { x, y } = axesToWheel(props.axes)

  /** 指针位置 → 色轮坐标（相对圆心、除以半径、**y 取反** —— 屏幕 y 朝下）。 */
  function toWheelXY(e: PointerEvent<HTMLDivElement>): { x: number; y: number } {
    const r = e.currentTarget.getBoundingClientRect()
    return {
      x: (e.clientX - (r.left + r.width / 2)) / (r.width / 2),
      y: -(e.clientY - (r.top + r.height / 2)) / (r.height / 2),
    }
  }

  return (
    <div
      className="color-wheel"
      data-x={String(x)}
      data-y={String(y)}
      aria-hidden="true"
      onPointerDown={(e) => {
        // 按下就跳到这个点（不用先拖一下才动），并捕获指针 ——
        // 捕获之后指针移出圆盘也继续跟；到角上仍然只到圆边（wheelToAxes 会钳半径）。
        e.currentTarget.setPointerCapture(e.pointerId)
        const p = toWheelXY(e)
        props.onChange(wheelToAxes(p.x, p.y))
      }}
      onPointerMove={(e) => {
        // 只有按着（还捕获着）才算拖动 —— 悬停扫过不发光也不改值。
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const p = toWheelXY(e)
        props.onChange(wheelToAxes(p.x, p.y))
      }}
      // 双击回中（= 三轴归零）。⚠️ 前面两次 pointerdown 各自落过一个点，
      // dblclick 最后跑 —— 顺序天然是对的。
      onDoubleClick={() => props.onChange({ cbCyanRed: 0, cbMagentaGreen: 0, cbYellowBlue: 0 })}
    >
      <span
        className="color-wheel-dot"
        // 圆心 + 半径比例；y 朝上为正，屏幕上是反的。
        style={{ left: `${50 + x * 50}%`, top: `${50 - y * 50}%` }}
      />
    </div>
  )
}
