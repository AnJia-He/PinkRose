/**
 * 照片查看的**缩放/平移**数学（★ 2026-10-06）。
 *
 * 用户的原话：「在对话区设置一个功能帮助用户能够正常缩放照片和定位到具体的
 * 细节区域」—— 在这之前照片永远"适应窗口"，想看一颗痘痘改掉没有只能靠猜。
 *
 * 这一层只做数学，不碰 DOM。坐标系一共三套，先在这里说清楚，后面每一处注释
 * 都按这三个词说话：
 *
 *   · **可视区**（area）：照片能用的那块地方（`.canvas-wrap`）。下面所有像素
 *     坐标都以**它的左上角**为原点。
 *   · **照片盒子**（fit）：照片"适应窗口"之后的大小。它永远是等比缩放**且不
 *     放大**的（比可视区还小的照片原样显示）—— 和 CSS 里那两条 max-width/
 *     max-height 是同一条规矩。
 *   · **视图**（view）：`scale` 是**相对照片盒子的倍数**（1 = 适应窗口，也就是
 *     加这个功能之前的样子），`x/y` 是照片中心相对可视区中心的平移量。
 *
 * 为什么 `scale` 是"相对适应窗口"而不是"相对真实像素"：默认状态（1）必须是
 * 改造之前的那一帧，一个像素都不许动 —— 布局探针和一堆测试都钉着那张照片的
 * 盒子尺寸。
 */
export type Size = { width: number; height: number }
/** 可视区里的一个点（左上角为原点，像素）。 */
export type Point = { x: number; y: number }
export type View = { scale: number; x: number; y: number }

/** 适应窗口：倍数 1、没平移。 */
export const FIT: View = { scale: 1, x: 0, y: 0 }

const MIN_SCALE = 1
const MAX_SCALE = 8

/** 照片"适应窗口"之后的大小。`area` 还没量出来（0）时给 0 —— 别让调用方拿它做除数。 */
export function fitBox(img: Size, area: Size): Size {
  if (!img.width || !img.height || !area.width || !area.height) return { width: 0, height: 0 }
  const r = Math.min(area.width / img.width, area.height / img.height, 1)
  return { width: img.width * r, height: img.height * r }
}

/** 「100% 真实像素」相当于几倍的"适应窗口"（双击切换的另一头）。 */
export function oneToOne(img: Size, fit: Size): number {
  return fit.width ? img.width / fit.width : 1
}

/**
 * 最多能放大到几倍，两条线取小的那条：
 *
 *   · 8 倍适应窗口 —— 再往上看也没什么可看的了；
 *   · 真实像素的 4 倍 —— 小照片（比如 800px 宽、适应窗口时就已经接近 1:1）
 *     拉到 8 倍只是把 800px 撑成 6400px 的糊块，那是**假**的放大，用户以为
 *     自己在看细节、其实看到的是插值。
 */
export function maxScale(img: Size, fit: Size): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, oneToOne(img, fit) * 4))
}

/**
 * 把视图收进合法范围。规矩只有一条：**画面中心永远有照片。**
 *
 * 也就是说，照片的边**最多拉到画面正中间**为止；反过来说 —— **照片上任何一个
 * 点都能拉到正中间来**，包括最角上那一个。这一条是用户 2026-10-06 晚上亲自要的：
 * 「假如我想把右上角的细节点放大放到正中间来是没法实现的」。原来那条"照片永远
 * 盖满可视区"比他要的更严：它只允许把角拉到**屏幕的角**上，照片外圈那一带
 * （2 倍时差不多是四周各三成）根本到不了中间 —— 而那正是"看细节"最常去的地方。
 *
 * ⚠️ 代价是：照片的边进了画面之后，**旁边让出来的那块是空的**。这是"任何细节
 * 都能摆正"必然的样子，**别当成 bug 又收紧回"盖满可视区"**。
 * ⚠️ 适应窗口（1 倍）是唯一的例外：那一档只有一个位置（正中间）——
 * "整张都在眼前"的时候挪它没有任何意义，而且滚轮缩回 1 倍时必须能**回正**。
 *
 * 没动的时候**返回原来那个对象**：手势里每帧都过一遍这里，白换身份会让下游
 * 白白重渲染。
 */
export function clampView(v: View, fit: Size): View {
  const half = v.scale <= MIN_SCALE ? 0 : v.scale / 2
  const x = clampAxis(v.x, fit.width * half)
  const y = clampAxis(v.y, fit.height * half)
  return x === v.x && y === v.y ? v : { scale: v.scale, x, y }
}

/** 夹到 ±limit。`limit` 是 0 的那一支直接给 0：`Math.max(-0, -99)` 会算出 `-0`，
 *  它和 0 等价、但会原样写进 `transform`（`translate(-0px, …)`）和断言里，
 *  看着像出了什么事。 */
function clampAxis(value: number, limit: number): number {
  return limit === 0 ? 0 : Math.min(limit, Math.max(-limit, value))
}

/**
 * 缩放到 `scale`，让 `anchor` 那一点**在屏幕上原地不动** —— 滚轮缩放就是靠它：
 * 指针底下那块细节不会跑掉（地图、所有看图工具都是这条）。
 *
 * 算法：先把"不动的那个点"换算成照片自己的坐标（以照片中心为原点、按**适应
 * 窗口**的像素算 —— 这个量在缩放前后是同一个），再按新倍数摆回屏幕上。
 */
export function zoomTo(
  v: View, scale: number, anchor: Point, fit: Size, area: Size, max = MAX_SCALE,
): View {
  const s = Math.min(Math.max(scale, MIN_SCALE), Math.max(MIN_SCALE, max))
  const cx = area.width / 2
  const cy = area.height / 2
  const ux = (anchor.x - cx - v.x) / v.scale
  const uy = (anchor.y - cy - v.y) / v.scale
  return clampView({ scale: s, x: anchor.x - cx - ux * s, y: anchor.y - cy - uy * s }, fit)
}

/**
 * 拖着看：`dx/dy` 是**相对按下那一刻**的总位移，不是每一帧的增量 —— 一次按下
 * 拖到哪算哪，中途被边界挡住之后再拖回来不会"粘"在边上（增量式就会粘）。
 */
export function panBy(v: View, dx: number, dy: number, fit: Size): View {
  return clampView({ scale: v.scale, x: v.x + dx, y: v.y + dy }, fit)
}

export type PinchPoint = { mid: Point; distance: number }

/**
 * 双指手势：距离变化决定缩放，两指中点移动决定平移。
 *
 * 先把**开始时两指中点底下那块画面**按缩放锚住，再按中点位移整体平移 ——
 * 这样一边捏合一边挪动时，指间那块细节会跟着手指走，不会各算各的。
 * 缩放上下限和单指拖动共用 `zoomTo` / `panBy` 那一套，不在手势层另写阈值。
 */
export function pinchView(
  base: View,
  start: PinchPoint,
  current: PinchPoint,
  fit: Size,
  area: Size,
  max = MAX_SCALE,
): View {
  if (start.distance <= 0 || current.distance <= 0) return base
  const zoomed = zoomTo(
    base,
    base.scale * current.distance / start.distance,
    start.mid,
    fit,
    area,
    max,
  )
  return panBy(
    zoomed,
    current.mid.x - start.mid.x,
    current.mid.y - start.mid.y,
    fit,
  )
}
