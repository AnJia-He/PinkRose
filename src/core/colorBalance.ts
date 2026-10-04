import type { Adjustments } from '../../shared/adjustments.ts'

/**
 * 色轮 ↔ 色彩平衡三轴。
 *
 * ## 色轮不是第四个参数
 *
 * 它就是那三根轴（青—红 / 洋红—绿 / 黄—蓝）的**二维视图**：拖色轮 = 零和地
 * 同时写三根轴（纯色偏、不动明暗），拖某一根轴 = 色轮上的点跟着走到新的色偏
 * 方向。两边是同一组值的两种表达，消息里不多存一个数。
 *
 * ## 零和是"构造"出来的，不是钳出来的
 *
 * 三根轴在 shader 里各是**一个通道的一笔**（`c.r += uCbCyanRed * 0.1` …）。
 * 三笔一样大 = 只是整体明暗，不是色偏 —— 而色轮表达的是纯色偏。所以这里只走
 * 两个方向向量：
 *
 *     RED_DIR  = [ 2/3, -1/3, -1/3]   // 红 ←→ 青：红 +2、绿蓝各 -1
 *     BLUE_DIR = [-1/3, -1/3,  2/3]   // 蓝 ←→ 黄：蓝 +2、红绿各 -1
 *
 * 两个方向的三个分量**各自加起来都是 0**，所以 `x·RED_DIR + y·BLUE_DIR` 天然
 * 零和（再经 `Math.round` 之后允许 ±1 的偏差）—— 不用事后去"配平"。
 *
 * ## 两个方向不正交 —— 反解要用对偶方向，不能直接点乘
 *
 * `RED_DIR · BLUE_DIR = -1/3 ≠ 0`（它俩是色相六边形上隔 120° 的两条半径）。
 * 在非正交基上**直接拿两个方向点乘会算错**：`{60, -30, -30}` 转上去再转回来，
 * 直接点乘给回的是 `{50, -10, -40}` —— 差 10~20，正是测试钉子（≤2）要抓的。
 * 正确的反解是"对偶方向"（与 RED_DIR 点乘为 1、与 BLUE_DIR 点乘为 0 的那对，
 * 算出正好是 `[1,-1,0]` / `[0,-1,1]`），展开后就是下面那两行差：
 *
 *     x = (cbCyanRed − cbMagentaGreen) / 100
 *     y = (cbYellowBlue − cbMagentaGreen) / 100
 *
 * 为什么是"差"而不是某根轴本身：色轮画的是**色偏**，只有轴与轴之间的差才是
 * 颜色；三轴共有的那部分（共模）等于明暗，色轮不管它 —— 所以三根全 +100
 * 会落在圆心（画面只是亮了，没偏色），这是对的，不是 bug。
 *
 * 往返：圆内的零和输入是**精确的**（取整最多差 1）；落在圆外的输入会被钳到
 * 边上 —— 那本来就不是色轮能表达的点（`wheelToAxes` 只表示圆内的点）。
 * 测试钉的上限是 ≤2。
 */

/** 红 ←→ 青 的通道方向（三个分量和 = 0 —— 只推颜色、不动明暗）。 */
const RED_DIR = [2 / 3, -1 / 3, -1 / 3] as const

/** 蓝 ←→ 黄 的通道方向（三个分量和 = 0）。 */
const BLUE_DIR = [-1 / 3, -1 / 3, 2 / 3] as const

/** 参与色轮的三根轴。 */
export type ColorBalanceAxes = Pick<Adjustments, 'cbCyanRed' | 'cbMagentaGreen' | 'cbYellowBlue'>

/**
 * 三轴 → 色轮坐标（x 向右 = 偏红，y 向上 = 偏蓝；都在 -1~1）。
 *
 * 超出单位圆的**按比例缩到圆边**（三轴可以超出色轮的表达能力，比如三根一样
 * 大 —— 那是明暗；色轮只画圆内）。
 */
export function axesToWheel(a: ColorBalanceAxes): { x: number; y: number } {
  let x = (a.cbCyanRed - a.cbMagentaGreen) / 100
  let y = (a.cbYellowBlue - a.cbMagentaGreen) / 100
  const r = Math.hypot(x, y)
  if (r > 1) {
    x /= r
    y /= r
  }
  return { x, y }
}

/**
 * 色轮坐标 → 三轴（半径先钳到 1 —— 拖到角上不许爆表；三轴零和、各自 -100~100）。
 *
 * 严格是 `axesToWheel` 的逆：圆内的零和输入往返误差只来自取整（≤1）。
 */
export function wheelToAxes(x: number, y: number): ColorBalanceAxes {
  const r = Math.hypot(x, y)
  if (r > 1) {
    x /= r
    y /= r
  }
  /** 第 i 根轴 = 两个方向在该分量上的合成 × 100，取整并钳到量程（半径钳过之后
   *  其实到不了 ±100，钳是形式上的安全带）。 */
  const cl = (i: 0 | 1 | 2) =>
    Math.round(Math.min(100, Math.max(-100, (x * RED_DIR[i] + y * BLUE_DIR[i]) * 100)))
  return { cbCyanRed: cl(0), cbMagentaGreen: cl(1), cbYellowBlue: cl(2) }
}
