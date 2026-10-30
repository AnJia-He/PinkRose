import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { Maximize2, Minimize2, Minus, Moon, Plus, Sun } from 'lucide-react'
import { TonePipeline } from '../render/pipeline'
import type { DecodedImage } from '../image/decode'
import type { NormPoint } from '../image/mark'
import { markerRadius } from '../image/mark'
import type { Adjustments } from '../../shared/adjustments.ts'
import type { Cube } from '../../shared/lut.ts'
import { rotatedBounds, type CropGuide, type CropRect } from '../core/crop'
import CropOverlay from './CropOverlay'
import CompareSplit from './CompareSplit'
import RetouchOverlay from './RetouchOverlay'
import GradientOverlay from './GradientOverlay'
import PerspectiveOverlay from './PerspectiveOverlay'
import TextOverlay from './TextOverlay'
import FrameOverlay from './FrameOverlay'
import CanvasFrameOverlay from './CanvasFrameOverlay'
import LiquifyOverlay, { type LiquifyDrag } from './LiquifyOverlay'
import StickerOverlay from './StickerOverlay'
import ShapeOverlay from './ShapeOverlay'
import DoodleOverlay from './DoodleOverlay'
import LightOverlay from './LightOverlay'
import DuotoneOverlay from './DuotoneOverlay'
import LensFocusOverlay from './LensFocusOverlay'
import FaceGuide from './FaceGuide'
import ManualFaceOverlay from './ManualFaceOverlay'
import CloneOverlay, { type ClonePoint } from './CloneOverlay'
import { bindWindowDrag } from './kit/windowDrag.ts'
import type { BrushMode } from '../core/retouch'
import type { GradientSpec } from '../core/gradientMask'
import type { PerspectiveQuad } from '../core/perspective'
import type { BlendMode } from '../image/doubleExposure'
import type { HistogramData } from '../render/histogram'
import type { CanvasFrameOptions } from '../image/canvasFrame'
import type { TextOptions } from '../image/text'
import type { EditLayer } from '../../shared/layers.ts'
import type { FrameOptions } from '../image/frame'
import type { LiquifyMode } from '../image/liquify'
import type { StickerOptions } from '../image/sticker'
import type { ShapeOptions } from '../image/shape'
import type { DoodleStroke } from '../image/doodle'
import type { LightOptions } from '../image/light'
import type { DuotoneOptions } from '../image/duotone'
import type { FaceBox } from '../core/faceDetect'
import {
  FIT, clampView, fitBox, maxScale, oneToOne, panBy, pinchView, zoomTo,
  type PinchPoint, type Size, type View,
} from './viewport'

/**
 * 裁剪的现场（★ 2026-10-06）—— `App` 算好交下来的一整块：
 * `Canvas` 只做两件事，**算式一个字都不在这儿**：
 *   · 把照片按 `angle` 转、按算出来的倍数缩（预览），
 *   · 把 `ui/CropOverlay` 摆到照片上（框和把手）。
 */
export type CropScene = {
  /** 归一化（相对**外框**）的裁剪框。 */
  rect: CropRect
  /** 用户拖了框 → 喊回 App。框是**受控**的，组件自己不留一份。 */
  onRect: (r: CropRect) => void
  /** 归一化空间的宽高比（w/h），null = 自由 —— 换算见 `ui/CropOverlay`。 */
  aspect: number | null
  /** 框不许越出的区域（归一化）：旋转留下的四个空角在它外面。 */
  inner: CropRect
  /**
   * 照片要转多少度（= `effectiveAngle(spec, turns)`）。
   * ⚠️ **正数 = 照片在输出里逆时针转**；所以这儿的 CSS 是 `rotate(-angle)`
   *    —— 和 `image/crop.ts` 里那串"反过来画"是同一个方向，别写反。
   */
  angle: number
  flipH?: boolean
  flipV?: boolean
  /** 只在预览里画的构图网格。 */
  grid?: boolean
  /** 构图参考线；不传时退回旧的 grid 三分线。 */
  guide?: CropGuide
}

/**
 * 点修 / 磨皮的现场（★ 2026-10-07 点修、★ 2026-10-17 磨皮共用）——
 * `App` 算好交下来的一整块：笔刷参数 + **掩码本体**（图片像素尺寸的缓冲区，
 * 组件往里面盖章）。`Canvas` 只负责把它摆到照片上（盒子 + 图层），算式和盖章
 * 都在 `ui/RetouchOverlay` / `core/retouch`。磨皮复用同一层：它的掩码协议
 * （0 = 不磨，越大磨得越实）和点修一字不差，只是提交时走的引擎不同。
 */
export type RetouchScene = {
  /** 画笔半径（图片像素）。 */
  radius: number
  mode: BrushMode
  mask: Uint8Array
  /** 掩码有实际改动时喊一声（App 拿它让「擦掉这里」亮起来）。 */
  onMaskChange: () => void
  /** 外部整张写掩码（自动选区 / 反选）时递增，涂抹层据此重画整张预览。 */
  revision?: number
  /** 只看不涂（色彩范围蒙版的预览）：事件穿过去，点画面 = 取色。 */
  readOnly?: boolean
}

/** 局部工具的线性 / 径向渐变蒙版现场。 */
export type GradientScene = {
  spec: GradientSpec
  onChange: (spec: GradientSpec) => void
}

/** 镜头虚化的可拖焦点（★ 2026-10-19）。 */
export type LensFocusScene = {
  x: number
  y: number
  shape?: 'radial' | 'tilt'
  angle?: number
  band?: number
  onChange: (x: number, y: number) => void
}

/** 四角自由透视现场。 */
export type PerspectiveScene = {
  quad: PerspectiveQuad
  onChange: (quad: PerspectiveQuad) => void
}

/** 双重曝光预览现场。 */
export type DoubleExposureScene = {
  preview: string
  mode: BlendMode
  opacity: number
}

/**
 * 文字的现场（★ 2026-10-17）—— 和裁剪框 / 涂抹层同一条坐标系：
 * `options` 里是归一化中心与图片像素字号，`onMove` 把拖动后的 0~1 喊回 App。
 */
export type TextScene = {
  options: TextOptions
  onMove: (x: number, y: number) => void
}

/** 相框的现场（★ 2026-10-17）—— 预览只画四条边，成片在 `image/frame.ts`。 */
export type FrameScene = {
  options: FrameOptions
}

/** 画布扩展现场（★ 2026-10-18）：比例 / 背景 / 边距；成片在 `image/canvasFrame.ts`。 */
export type CanvasFrameScene = {
  options: CanvasFrameOptions
}

/** 液化现场（★ 2026-10-17）—— 笔刷 + 一笔的方向，提交在 `app/useLiquify`。 */
export type LiquifyScene = {
  radius: number
  mode: LiquifyMode
  onStroke: (stroke: LiquifyDrag) => void
}

/** 贴纸现场（★ 2026-10-17）—— 选项 + 拖动后的归一化位置。 */
export type StickerScene = {
  options: StickerOptions
  customPreview?: string | null
  onMove: (x: number, y: number) => void
}

/** 形状现场（★ 2026-10-19）—— 两个归一化端点 + 拖动后的回调。 */
export type ShapeScene = {
  options: ShapeOptions
  onChange: (patch: Partial<ShapeOptions>) => void
}

/** 涂鸦现场（★ 2026-10-18）—— 已完成笔画 + 当前笔刷，松手交一整笔。 */
export type DoodleScene = {
  strokes: readonly DoodleStroke[]
  color: string
  sizePct: number
  opacity: number
  onStroke: (stroke: DoodleStroke) => void
}

/** 光效现场（★ 2026-10-18）—— 纯预览，不接指针。 */
export type LightScene = { options: LightOptions }
export type DuotoneScene = { options: DuotoneOptions }

/** 「人像」工具估出来的人脸框；只用于照片上的定位提示，不参与像素。 */
export type FaceScene = {
  face: FaceBox
  faces?: FaceBox[]
  all?: boolean
  selected?: number
  onPickFace?: (index: number) => void
}
export type FacePickScene = { onPick: (face: FaceBox) => void }

/** 克隆图章现场：源点 + 首笔定下的偏移 + 涂抹回调。 */
export type CloneScene = {
  radius: number
  source: ClonePoint | null
  offset: ClonePoint | null
  onStroke: (points: ClonePoint[]) => void
}

type Props = {
  image: DecodedImage | null
  params: Adjustments
  /** 已提交的文字 / 形状层（★ 2026-10-19）；不传 = 没有。 */
  layers?: EditLayer[]
  /** 正在编辑的那一层先从已提交的预览里拿掉，避免重影。 */
  hiddenLayerId?: string | null
  /** 当前滤镜的样子（null = 没装）；和 `params` 一样是"画在哪"的输入 */
  lutCube: Cube | null
  /** 强度 0–100（没装 = 0） */
  lutAmount: number
  /** 「按住看原图」用的预览（data URL）。null = 没有，按钮就不响应。 */
  originalPreview: string | null
  /** App 需要拿到 canvas 元素来做导出 */
  canvasRef: MutableRefObject<HTMLCanvasElement | null>
  /** 正在等用户点一下（spec §6.3）。true 时画布接受点击并把它换算成坐标。 */
  picking?: boolean
  /** ★ 2026-10-17（白平衡吸管）：正在等用户点一块中性色。 */
  sampling?: boolean
  onSamplePoint?: (x: number, y: number) => void
  sampleHint?: string
  /** 镜头虚化的焦点环；null / 不传 = 没开虚化或正开着别的工具。 */
  lensFocus?: LensFocusScene | null
  /**
   * ★ 2026-10-06（用户原话：「而且中途思考要有一些加载动作比如正在思考，要让
   * 用户知道你在干嘛」）：**正在生成**（判据在 App：`busy === BUSY_GENERATING`）。
   * 为真时照片上盖一层**淡淡的暗罩 + 转圈** —— 那十几秒里照片原来完全没反应，
   * 用户不知道是在等还是坏了。
   * ⚠️ **只有生成这一段**会传 true：「正在思考…」/ 上传 / 切会话那几句不盖
   *   （一个 1.5 秒的闪暗、紧接着再暗十来秒，读起来是界面在抽）。
   * 可选：不传 = 不盖，直接挂载它的测试不用为此表态。
   */
  busy?: boolean
  /** 用户点的那个点，0~1（**相对照片左上角**）。null = 还没点。 */
  marker?: NormPoint | null
  onPickPoint?: (x: number, y: number) => void
  /**
   * ★ 2026-10-06（缩放）：**"换了一张照片"的信号**（App 传的是 `sessionId`）。
   * 它一变，缩放/平移就收回「适应窗口」；**同一条会话里换步骤**（转盘跳一步、
   * 「再来一版」）它不变、视图也**不动** —— 用户正对着同一块地方前后对比，
   * 这时候把视图拽回去等于把他手里的放大镜抢走。
   * 可选：不传 = 永远不归位（直接挂载它的测试不用为此表态）。
   */
  resetKey?: unknown
  /**
   * ★ 2026-10-06（工具行）：工具开着时**手势停用** —— 滚轮、拖动、双击都不响应，
   * 右下角那排缩放按钮也不画。
   * 理由：裁剪时一边拉框一边缩放会让框和手指打架（spec §3.1）。
   */
  viewLocked?: boolean
  /**
   * ★ 2026-10-06（裁剪）：裁剪的现场。null / 不传 = 没在裁（那时这一整块不存在，
   * 照片一个内联样式都不留 —— 和缩放那条"适应窗口"的规矩一样）。
   */
  crop?: CropScene | null
  /**
   * ★ 2026-10-06（对比）：**在不在对比态**（开关在 App：`tool === 'compare'`）。
   * ⚠️ 它和 `viewLocked` 是**两回事**：对比态里缩放 / 平移照常能用、两张图同步
   *   （spec §3.3）—— 用户多半正放大着才去按对比，把他拽回「适应窗口」正好
   *   毁掉这个用法。所以 App 那边只把裁剪算作"工具开着"。
   */
  comparing?: boolean
  /**
   * ★ 2026-10-06（对比）：**原图的 data URL**（App 备好的那一份，长边 ≤ 2048）。
   * null / 不传 = 那一层不存在（原图还在备的路上时就是它）。
   */
  compareWith?: string | null
  /** 右下角那排里那颗「对比」：切开关（和工具行那颗是**同一个**开关）。 */
  onCompare?: () => void
  /**
   * ★ 2026-10-07（点修）：涂抹的现场。null / 不传 = 没在点修。
   * ★ 2026-10-17（磨皮）：磨皮也用这一层（同一个掩码协议）—— App 传下来的是
   * "当前那个工具的现场"，两个同一时刻最多一个非 null。
   * ⚠️ 它和 `viewLocked` 是两回事：点修/磨皮**不禁缩放**（放大着修细节正是
   *   这个工具的用法）—— 手势的停用由这一层自己盖住照片区完成（见
   *   `ui/RetouchOverlay` 文件头），滚轮从它上面冒泡上来照旧能缩放。
   */
  retouch?: RetouchScene | null
  gradient?: GradientScene | null
  perspective?: PerspectiveScene | null
  doubleExposure?: DoubleExposureScene | null
  /** 文字的现场。null / 不传 = 没在写字。 */
  text?: TextScene | null
  /** 相框的现场。null / 不传 = 没在加边框。 */
  frame?: FrameScene | null
  /** 画布扩展的现场。null / 不传 = 没在做画布。 */
  canvasFrame?: CanvasFrameScene | null
  /** 液化的现场。null / 不传 = 没在推像素。 */
  liquify?: LiquifyScene | null
  /** 贴纸的现场。null / 不传 = 没在贴。 */
  sticker?: StickerScene | null
  /** 形状的现场。null / 不传 = 没在画形状。 */
  shape?: ShapeScene | null
  /** 涂鸦的现场。null / 不传 = 没在画。 */
  doodle?: DoodleScene | null
  /** 光效的现场。null / 不传 = 没在加光。 */
  light?: LightScene | null
  /** 双色调的现场。null / 不传 = 没在映射颜色。 */
  duotone?: DuotoneScene | null
  /** 人像工具识别人脸后的取景框（只画框，不接收指针）。 */
  faceShape?: FaceScene | null
  /** 自动找脸失败 / 手动修正时，在照片上拖一个脸框。 */
  facePick?: FacePickScene | null
  /** 克隆图章现场。 */
  clone?: CloneScene | null
  /** 画面这条路出了事，把**要说给用户的那句话**交出去（由 App 决定在哪儿显示）。
   *  组件自己不弹窗、不存状态：它只负责"把话说清楚"，说不说、在哪儿说是上层的事。 */
  onFail?: (message: string) => void
  /** 调色屏的实时直方图；不传 = 不算（别的屏不白花这一趟 GPU 回读）。 */
  onHistogram?: (data: HistogramData) => void
}

/** 画布相对 wrapper 的盒子，单位像素。红圈按它定位（理由见下面那段注释）。 */
type CanvasBox = { left: number; top: number; width: number; height: number }

/** 「按住看原图」要按住这么久才算数（毫秒）。
 *  ⚠️ 不能改回"一按就出"：有了拖动平移之后，那样每次拖动都会先闪一下没调过色的
 *  原图（点选那条路上踩过同一个坑，见 handlePick 上面那段）。 */
const PEEK_HOLD_MS = 150
/** 挪动超过这么多像素才算"在拖"（手抖不算）。 */
const DRAG_MIN_PX = 5
/** 按钮一下放大 / 缩小多少倍。 */
const ZOOM_STEP = 1.4
/** 滚轮：一格（Chrome 上 deltaY ≈ 100）大约 1.16 倍。 */
const WHEEL_RATE = 0.0015

/** 把滚轮的 deltaY 归一成"像素"再谈倍数。
 *  三种量纲：0 像素、1 行、2 页 —— Firefox 上鼠标滚一格是 **3 行**，
 *  不归一的话它那儿几乎转不动（而 Chrome 是 100 像素，看着完全正常）。 */
function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16
  if (e.deltaMode === 2) return e.deltaY * 100
  return e.deltaY
}

/**
 * 渲染链路的三条失败路径 → **说给用户的那句话**。纯函数，没有副作用。
 *
 * 三条路径共用它，但**说给用户的话必须分开**——它们该做的事完全不同：
 *   1. 浏览器拿不到 WebGL2   → 换个浏览器就好
 *   2. 这张照片超出画布上限   → 换浏览器也一样，得换张小点的图
 *   3. 画到一半上下文丢了     → 多半也是图太大
 *
 * 2026-09-22 在手机上真撞到过：三条当时共用一句「或……或……」，
 * **分不清是哪一种**，白白多猜了一轮。而且第 2 种那句话里带着
 * 照片的真实尺寸和设备的真实上限——那是排查时最有用的一条线索，别丢。
 */
export function describeFailure(e: unknown): string {
  const msg = e instanceof Error ? e.message : ''
  if (msg.includes('不支持 WebGL2')) return '这个浏览器打不开 WebGL2。请换 Chrome 或 Safari 打开。'
  if (msg.includes('超出本浏览器的画布上限')) return `${msg}。换一张小一点的照片试试。`
  if (msg.includes('上下文丢失')) return '这张照片太大，浏览器画到一半扛不住了。换一张小一点的照片试试。'
  return '画面出问题了。先刷新一下；还不行就换 Chrome 或 Safari。'
}

/** 画布只负责"把渲染结果贴出来"，不碰像素、不碰状态。 */
export default function Canvas({
  image, params, layers, hiddenLayerId, lutCube, lutAmount, originalPreview, canvasRef, picking, sampling, onSamplePoint,
  sampleHint, marker, onPickPoint, onFail,
  busy, resetKey, viewLocked, crop, comparing, compareWith, onCompare, retouch, gradient, text,
  perspective, doubleExposure, frame, canvasFrame, liquify, sticker, shape, doodle, light, duotone,
  lensFocus,
  faceShape, facePick, clone, onHistogram,
}: Props) {
  const innerRef = useRef<HTMLCanvasElement | null>(null)
  const clipCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const pipeRef = useRef<TonePipeline | null>(null)
  /**
   * WebKit 的一个真实坑：WebGL 上下文建好之后再改 canvas.width/height，
   * 缓冲区里能读回像素，但合成层可能整块不显示（画布看起来全透明）。
   * 所以底图尺寸一变就换一个 canvas 元素，让管线和上下文一起重建。
   */
  const canvasKey = image ? `${image.width}x${image.height}` : 'empty'
  /** 用户此刻按住了画面（在看原图）。 */
  const [peeking, setPeeking] = useState(false)
  const [focusView, setFocusView] = useState(false)
  /** 查看辅助：bit 1 = 高光裁切，bit 2 = 阴影裁切。不进入作品参数。 */
  const [clipWarnings, setClipWarnings] = useState(0)
  const clipHigh = (clipWarnings & 1) !== 0
  const clipLow = (clipWarnings & 2) !== 0
  /** 画布相对 wrapper 的盒子。红圈的定位基准 —— 见下面那个 effect 里的理由。 */
  const [box, setBox] = useState<CanvasBox | null>(null)

  // ── 缩放 / 平移（★ 2026-10-06）──────────────────────────────────────
  //  数学全在 `./viewport`（那边解释了三套坐标系），这里只管接线。
  /** 当前视图：1 = 适应窗口，也就是加这个功能之前的那个样子。 */
  const [view, setView] = useState<View>(FIT)
  /**
   * `view` 的**影子 ref**（和 `StepStrip` 的 `rotRef`、App 的 `cursorIdRef`
   * 同一条规矩：**一起写**）。手势处理器里要读"此刻"的值 —— 读 state 会读到
   * 上一次渲染那一份，而拖动是一次按下连续读好几帧。
   */
  const viewRef = useRef(view)
  const putView = useCallback((next: View) => {
    viewRef.current = next
    setView(next)
  }, [])
  /** 可视区大小（wrapper）。"适应窗口"的算式有一半是它，手势里要现算。 */
  const areaRef = useRef<Size>({ width: 0, height: 0 })
  /**
   * 这一次按下。`panned` 是"刚才真的拖动过没有" —— 松开之后**不能清**：
   * 紧跟其后的那一下 `click` 还要靠它判断"这是点选还是拖完手一松"。
   */
  const pressRef = useRef<
    { id: number; startX: number; startY: number; base: View; panned: boolean } | null
  >(null)
  /** 当前按在照片上的触控点。鼠标不进来；双指手势只从这里读。 */
  const touchPointsRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  /** 双指手势收场（摘 window 监听）。和单指 `stopRef` 分开，互不覆盖。 */
  const pinchStopRef = useRef<(() => void) | null>(null)
  /** 拖动中途组件被卸载时，挂在 window 上的那几个监听器也要收干净。 */
  const stopRef = useRef<(() => void) | null>(null)
  /** 量一次的那个函数（下面 effect 里建好）。缩放之后要**自己再喊一次** —— 理由见那条 effect。 */
  const measureRef = useRef<() => void>(() => {})

  /** 画面这条路出事时走这里：控制台留痕 + 把话说给上层（App 决定显示在哪）。
   *
   *  ⚠️ 它出现在三个 effect 的依赖数组里。今天传进来的 `onFail` 是 App 的
   *  `setNotice`（React 保证稳定），所以这条回调的身份永远不变、effect 不会
   *  重跑；哪天有人传一个现造的箭头函数进来，**代价是 pipeline 被反复重建**
   *  （看得见、测得出来），不是静默失灵 —— 这是故意选的那一边。
   *
   *  原来这里是一个模块级的 `alert` + `lastShown` 去重（防开发模式下 effect
   *  跑两遍弹两次）。改成通报条之后那层去重**不需要了**：同一句话再设一次
   *  是个幂等的 setState，React 自己会 bail out。 */
  const report = useCallback((e: unknown) => {
    console.error(e)
    onFail?.(describeFailure(e))
  }, [onFail])

  useEffect(() => {
    const canvas = innerRef.current
    if (!canvas) return
    try {
      const pipe = new TonePipeline(canvas, report)
      pipeRef.current = pipe
      return () => {
        pipe.dispose()
        pipeRef.current = null
      }
    } catch (e) {
      report(e)
    }
  }, [report, canvasKey])

  // ① 图片换了才上传纹理、重设画布尺寸。
  //    这两件事都很贵——上传一次 1200 万像素的纹理、重设画布尺寸会清空
  //    并重新分配绘图缓冲。**绝不能跟着滑块走。**
  useEffect(() => {
    const pipe = pipeRef.current
    if (!pipe || !image) return
    try {
      pipe.setImage(image)
      pipe.resizeToImage()
    } catch (e) {
      // 尺寸超出浏览器上限会从这里抛出来——pipeline 按「调色不缩图」的铁律
      // 拒绝静默降采样，所以这里必须显式提示，不能把错误咽掉。
      report(e)
    }
  }, [image, report, canvasKey])

  // ② 滤镜换了才传纹理 —— 上传一次 64³ 纹理不便宜（`setLut` 每次都会整块
  //    `texImage3D` 重传，见 `render/pipeline.ts` 那段）。
  //    ⚠️ **依赖数组里只能有 `lutCube` 和 `report`**：把 params 或强度放进来，
  //    拖一下强度滑块就是每帧重传 1MB 的 3D 纹理，而画面看起来完全正常。
  //    `report` 要留着：它一变，上面那条 effect 会把 pipeline **整个重建**，
  //    新管线手里是 1×1×1 的占位纹理 —— 不跟着重传，滤镜会静默消失。
  //    ⚠️ **它必须声明在下面渲染那条之前**：挂载时 effect 按声明顺序跑，
  //    `setLut` 没跑过的话第一次 `render` 画的是"没有滤镜"的画面。
  useEffect(() => {
    try { pipeRef.current?.setLut(lutCube) } catch (e) { report(e) }
  }, [lutCube, report, canvasKey])

  // ③ 换图后、以及拖滑块时，都只更新 uniform 重绘一次。
  //    不碰纹理、不碰画布尺寸（spec §5.2：拖滑块只更新 uniform → 60fps）。
  //
  //    ⚠️ **`lutCube` 也必须在依赖里**（2026-10-05 审查 Critical）：
  //    `setLut` 只上传纹理、记下 `lutOn`，**它自己一帧都不画**（`drawArrays`
  //    只在 `render` 里）。而这个 cube 是**异步**到手的（`useLuts` 里那条
  //    "取它的 cube"要过一次网络 + 解析）：那条路走完时，变的**只有 `lutCube`**。
  //    依赖里没它的话这条 effect 一次都不跑，画布就停在"还没滤镜"那一帧：
  //    用户眼前"选了滤镜没反应"，得去拖任何一根滑块才会突然出现，**全程不报错**。
  //    换滤镜（强度不变）和 F5 恢复会话是同一条路。
  //    ⚠️ 这条**声明在上面那条 `setLut` 之后**是合同、不是排版：挂载时按声明顺序跑，
  //    反过来的话 cube 到位那一次会先按**旧纹理**画一帧，而依赖里已经有 `lutCube`、
  //    之后不会再重画 —— 症状和上面那条一模一样。`Canvas.test.tsx` 里那条**顺序**
  //    断言（不是次数）钉着它（只数次数的话，对调两条照样全绿）。
  //    ⚠️ 这是**渲染**那条 effect，和上面那条 `setLut` 的依赖是两件事、别抄错：
  //    上面只能有 `[lutCube, report]`（amount 进去就是每帧重传 1MB 纹理）。
  useEffect(() => {
    const pipe = pipeRef.current
    if (!pipe || !image) return
    pipe.render(params, lutAmount)
    if (clipHigh || clipLow) {
      try {
        const clipped = pipe.readClippingMask(params, lutAmount)
        const overlay = clipCanvasRef.current
        if (clipped && overlay) {
          overlay.width = clipped.width
          overlay.height = clipped.height
          const ctx = overlay.getContext('2d')
          if (ctx) {
            const imageData = ctx.createImageData(clipped.width, clipped.height)
            for (let p = 0, i = 0; p < clipped.mask.length; p++, i += 4) {
              const kind = clipped.mask[p]
              if (kind === 1 && clipHigh) {
                imageData.data[i] = 255
                imageData.data[i + 1] = 52
                imageData.data[i + 2] = 52
                imageData.data[i + 3] = 178
              } else if (kind === 2 && clipLow) {
                imageData.data[i] = 52
                imageData.data[i + 1] = 120
                imageData.data[i + 2] = 255
                imageData.data[i + 3] = 178
              }
            }
            ctx.putImageData(imageData, 0, 0)
          }
        }
      } catch (e) {
        // 裁切提示是查看辅助，读不回来也不能影响正常画面。
        console.error('裁切警告没读回来', e)
      }
    }
    if (onHistogram) {
      try {
        const h = pipe.readHistogram(params, lutAmount)
        if (h) onHistogram(h)
      } catch (e) {
        // 直方图是辅助信息：读不回来也不能把正常画面带走。
        console.error('直方图没读回来', e)
      }
    }
  }, [image, params, lutAmount, lutCube, onHistogram, canvasKey, clipHigh, clipLow])

  /**
   * 量出**画布**相对 wrapper 的盒子。红圈的定位基准就是这个，不是 wrapper。
   *
   * 为什么非得量：`.canvas-wrap` 是撑满整个 stage 的（width/height 都是 100%），
   * 画布只是**居中在它里面**。`.canvas` 的 `max-width/max-height: 100%` 在"高度
   * 受限"时会在**左右留出空白** —— 于是"相对 wrapper 的百分比"和"照片上的位置"
   * 根本不是一回事。1280×600 档实测：画布 750×500 @95,80，而 stage 内容盒从
   * x=20 起 —— 左边那 75px 是空白，不是照片。
   *
   * ⚠️ **这个坑最坏的地方是它看不出来**：要是坐标按 wrapper 归一化、红圈也按
   * wrapper 的百分比定位，两处会**同时错、正好互相抵消** —— 圈会画在用户点的那
   * 个位置、看着完全正确，而送进模型的那张图里圈却偏了 8% 的宽度（实测：在照片
   * 左边缘点一下，报回来的是 0.083 而不是 0）。看着对、其实错、还照收钱。
   * 所以归一化和定位**两处都以画布为准**。
   *
   * 用测量而不是纯 CSS：百分比那条路要在画布里再套一层"收缩到画布大小"的盒子，
   * 解析规则很容易踩坑；量出来的像素是确定的，而且探针能直接验。**但绝不能在
   * render 里读 offsetLeft / getBoundingClientRect** —— 渲染期读布局是 React 的
   * 经典坑，读到的值会被它自己触发的下一次渲染改掉。
   */
  useLayoutEffect(() => {
    const canvas = innerRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const measure = () => {
      const c = canvas.getBoundingClientRect()
      const w = wrap.getBoundingClientRect()
      areaRef.current = { width: w.width, height: w.height }
      setBox(prev => {
        const next: CanvasBox = {
          left: c.left - w.left, top: c.top - w.top,
          width: c.width, height: c.height,
        }
        // 一个像素都没动就别换 state 对象：ResizeObserver 回调里 setState 是
        // "回调 → 渲染 → 布局 → 回调"这条死循环的经典入口，能不动就不动。
        return prev && prev.left === next.left && prev.top === next.top
          && prev.width === next.width && prev.height === next.height
          ? prev
          : next
      })
      // ★ 缩放：窗口变小 / 切到窄屏之后，原来那个平移量可能已经把照片拉出去太远了
      //   （见 `viewport.clampView` 那条"画面中心永远有照片"）—— 顺手收回来。
      //   没动的话 `clampView` 返回的是同一个对象，不会白渲染一次。
      if (image) {
        const next = clampView(viewRef.current, fitBox(image, areaRef.current))
        if (next !== viewRef.current) putView(next)
      }
    }
    measureRef.current = measure
    measure()
    // 画布尺寸随时会变：换图、屏幕转过来、开合调色面板、手机键盘弹起。
    // 只量一次的话红圈会在这些时候飘走 —— 所以还要盯住它。
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(canvas)
    ro?.observe(wrap)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [image, putView])

  /**
   * ★ 缩放/平移之后**自己再量一次**。`ResizeObserver` 看的是**布局尺寸**，
   * 而缩放走的是 `transform` —— 布局一个像素都没变（这正是选 transform 的理由：
   * 不重排、不碰纹理、不动画布里的像素），所以它一声不吭。
   *
   * 不补这一枪，红圈（`.canvas-marker`）就会**停在放大前的位置上**，而屏幕上
   * 一切"看起来正常"：照片确实大了，圈也确实还在，只是不在你点的那块地方。
   *
   * ★ 2026-10-06（裁剪）：**转照片那一下同理**，而且比缩放更要紧 —— 裁剪框
   *   整个是照量出来的盒子摆的（`CropOverlay` 的定位基准就是它）。转 90° 或拖
   *   矫正滑杆之后不重量的话，框会停在转之前的地方，而照片已经转过去了。
   *   （`k` 那半不依赖测量值 —— 那是**故意**的，量盒子去算 k 是循环依赖。）
   */
  useLayoutEffect(() => { measureRef.current() }, [view, crop?.angle])

  /** 换照片 / 换会话 → 收回「适应窗口」（判据和理由见 `resetKey` 那条 prop）。 */
  useEffect(() => { putView(FIT) }, [resetKey, putView])

  /**
   * 把屏幕上点的那一下换算成 0~1 的归一化坐标。
   *
   * ⚠️ 量的必须是**画布**：wrapper 比画布宽（见上面那个 effect）。
   * 点在照片外面（stage 的留白上）不算数 —— 那不是在指照片里的东西。
   */
  const handlePick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!picking && !sampling) return
    // ★ 2026-10-06（缩放）：**拖动过的那一下不算"点这儿"**。放大之后用户要能
    //   拖着找到位置再点，而浏览器在 pointerup 之后照样会派发 click ——
    //   不挡的话每次平移都会在松手的地方顺手插一个圈。
    if (pressRef.current?.panned) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    // 归一化到 0~1：这样画布怎么缩放都不影响标记的位置
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    if (x < 0 || x > 1 || y < 0 || y > 1) return
    if (sampling) {
      onSamplePoint?.(x, y)
      return
    }
    if (!onPickPoint) return
    onPickPoint(x, y)
  }

  /**
   * 按下去。它可能是三件事：**看原图**（按住不动）、**拖动平移**（动起来）、
   * 或者**点选**（轻轻一下，走 `onClick`）。
   *
   * 前两件在按下去的那一刻分不出来，所以两条都先别急着开始：先记下这一按，
   * 再挂一个 150ms 的计时器等"按住"；指针一动（超过 `DRAG_MIN_PX`）就把计时器
   * 掐掉、改走平移。
   * ⚠️ 回到"一按就出原图"的话，**每次拖动都会先闪一下**没调过色的原图 ——
   * 点选那条路上踩过同一个坑（见 handlePick 里那句）。
   *
   * 手势挂在 wrap 上、不是挂在画布上：手指落在画布外那圈留白上时，事件也要
   * 收得到（画布盖不住那一圈），peek 就挂在它里面。
   * ⚠️ 但**"照片那一块地方"是画布，不是 wrap** —— wrap 比画布大，两者在
   * "高度受限"的屏上差着几十像素。要换算照片上的位置，量的一律是画布
   * （见 handlePick 和上面那个 measurement effect）。
   *
   * ⚠️ 拖动这条线索挂在 **window** 上，不是挂在 wrap 上：放大之后手拖到画面
   * 边缘之外是**常态**（那正是"我要看那边"的意思），挂在 wrap 上一出去就断了，
   * 用户得松手重来。**也别改用 `setPointerCapture`** —— 一捕获，松开时派发的
   * `click` 会落到容器上，点选那一下会被吃掉（`StepStrip` 那条真踩过）。
   *
   * onContextMenu 拦的是另一件事：桌面右键、以及 **Android Chrome 长按**，
   * 默认都会弹"下载图片 / 复制"这类系统菜单，跟按住看原图直接打架。
   */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!image || viewLocked || retouch || gradient || perspective) return
    // 上一次按下要是没收干净（指针被系统抢走、pointerup 没送到），先收掉
    stopRef.current?.()
    pinchStopRef.current?.()

    /**
     * 第二根手指落下 = 从单指拖动切成双指缩放。
     *
     * 收场一定挂在 **window** 上：双指很容易拖出照片区。两指的中点按
     * `wrap` 左上角换算成可视区坐标，交给 `viewport.pinchView`；它负责
     * “指间那块细节跟手”和缩放/平移边界，这里不重复写一遍。
     */
    const startPinch = () => {
      stopRef.current?.()
      pressRef.current = null
      setPeeking(false)
      const points = [...touchPointsRef.current.values()].slice(0, 2)
      if (points.length < 2) return
      const wrap = wrapRef.current
      if (!wrap) return
      const r = wrap.getBoundingClientRect()
      const start: PinchPoint = {
        mid: {
          x: (points[0]!.x + points[1]!.x) / 2 - r.left,
          y: (points[0]!.y + points[1]!.y) / 2 - r.top,
        },
        distance: Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y),
      }
      const base = viewRef.current

      const onMove = (ev: PointerEvent) => {
        const p = touchPointsRef.current.get(ev.pointerId)
        if (!p) return
        p.x = ev.clientX
        p.y = ev.clientY
        if (ev.cancelable) ev.preventDefault()
        if (touchPointsRef.current.size < 2) return
        const [a, b] = [...touchPointsRef.current.values()]
        if (!a || !b) return
        const area = areaRef.current
        const fit = fitBox(image, area)
        const current: PinchPoint = {
          mid: {
            x: (a.x + b.x) / 2 - r.left,
            y: (a.y + b.y) / 2 - r.top,
          },
          distance: Math.hypot(b.x - a.x, b.y - a.y),
        }
        putView(pinchView(base, start, current, fit, area, maxScale(image, fit)))
      }

      const stop = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
        if (pinchStopRef.current === stop) pinchStopRef.current = null
      }
      const onEnd = (ev: PointerEvent) => {
        touchPointsRef.current.delete(ev.pointerId)
        if (touchPointsRef.current.size >= 2) return
        // 双指手势结束就整批清掉：剩下一根手指不再冒充“第二指还在”，
        // 下一次按下去从当前画面重新开始。用户不需要先抬干净再操作。
        touchPointsRef.current.clear()
        stop()
      }
      window.addEventListener('pointermove', onMove, { passive: false })
      window.addEventListener('pointerup', onEnd)
      window.addEventListener('pointercancel', onEnd)
      pinchStopRef.current = stop
    }

    // jsdom 没有 PointerEvent，测试用 MouseEvent 补 `pointerType`；React 的
    // SyntheticPointerEvent 在那种环境里不一定把它抄到外层，读 nativeEvent
    // 这一条兜底对真浏览器无害。
    const pointerType = e.pointerType
      || (e.nativeEvent as PointerEvent | undefined)?.pointerType
    if (pointerType === 'touch') {
      touchPointsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touchPointsRef.current.size === 2) {
        startPinch()
        return
      }
    }

    const p = {
      id: e.pointerId, startX: e.clientX, startY: e.clientY,
      base: viewRef.current, panned: false,
    }
    pressRef.current = p

    let timer: number | null = null
    // 点选模式里不许 peek：那一下是"点一下告诉我是哪儿"，不是"按住看原图"。
    // 不挡的话**每次点选都会先闪一下没调过色的原图**。
    if (!picking && !sampling && originalPreview) {
      timer = window.setTimeout(() => {
        if (pressRef.current === p && !p.panned) setPeeking(true)
      }, PEEK_HOLD_MS)
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== p.id || pressRef.current !== p) return
      const dx = ev.clientX - p.startX
      const dy = ev.clientY - p.startY
      if (!p.panned) {
        // 适应窗口时整张照片都在眼前，没有可挪的余地 —— 照旧什么都不做
        if (p.base.scale <= 1) return
        if (Math.hypot(dx, dy) < DRAG_MIN_PX) return   // 手抖不算拖
        p.panned = true
        if (timer !== null) { window.clearTimeout(timer); timer = null }
        setPeeking(false)                              // 动起来了，那就不叫"按住看原图"
      }
      const area = areaRef.current
      putView(panBy(p.base, dx, dy, fitBox(image, area)))
    }

    // ⚠️ 单指的触控点**不能**在 `bindWindowDrag` 的收场里删：第二根手指落下时
    //    也会先调一次那个收场（把单指拖动停掉），这时第一指还得留在表里，
    //    否则永远凑不齐双指。只在自己的 pointerup / cancel 上删。
    function clearTouch(ev: PointerEvent) {
      if (ev.pointerId !== p.id) return
      touchPointsRef.current.delete(p.id)
      window.removeEventListener('pointerup', clearTouch)
      window.removeEventListener('pointercancel', clearTouch)
    }
    // 先挂：`bindWindowDrag` 的 pointerup 监听会顺手把自己的收场跑掉，
    // 它若排在前面，会在 clearTouch 之前把监听摘掉，触控点就永远留在表里。
    window.addEventListener('pointerup', clearTouch)
    window.addEventListener('pointercancel', clearTouch)
    // 三种"松手"（抬手 / 被抢走 / 取消）那条规矩在 `kit/windowDrag` 里 ——
    // 少接一个，用户按一下就会被**永久留在原图上**，而他没有任何办法按回来。
    // `stopRef` 存的是**完整收场**那一版（摘监听 + 清计时器）：下一趟 pointerdown
    // 和组件卸载都会再调它一次，它是幂等的，不会把收场跑第二遍。
    const d = bindWindowDrag(onMove, () => {
      if (timer !== null) { window.clearTimeout(timer); timer = null }
      setPeeking(false)
      window.removeEventListener('pointerup', clearTouch)
      window.removeEventListener('pointercancel', clearTouch)
    })
    stopRef.current = d.stop
  }

  /**
   * 双击 = **定位到细节**：怼到 100% 真实像素，而且**双击哪儿就以哪儿为中心**
   * （滚轮那条是同一个意思，只是它一格一格地来）。再双击一下回适应窗口。
   * ⚠️ 点选模式里不缩放：那两下是"指位置"、不是"看细节"，而且它已经会插两个圈。
   */
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current
    if (!image || !wrap || picking || viewLocked || retouch || gradient || perspective) return
    const v = viewRef.current
    if (v.scale > 1) { putView(FIT); return }
    const area = areaRef.current
    const fit = fitBox(image, area)
    const r = wrap.getBoundingClientRect()
    putView(zoomTo(v, oneToOne(image, fit), { x: e.clientX - r.left, y: e.clientY - r.top },
      fit, area, maxScale(image, fit)))
  }

  /**
   * 滚轮缩放（以指针为中心 —— 指针底下那块细节不会跑）。
   *
   * ⚠️ 必须**自己挂原生监听**、还要 `{ passive: false }`：React 的 `onWheel` 是在
   * 根容器上**按被动方式**注册的，里面调 `preventDefault()` 会被浏览器无视
   * （页面里有别的滚动区时就会跟着一起滚）。这种失败**不报错**，只是"这一下没
   * 拦住" —— `Canvas.zoom.test.tsx` 里那条 `defaultPrevented` 钉的就是它。
   */
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || !image || viewLocked) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const area = areaRef.current
      const fit = fitBox(image, area)
      const r = wrap.getBoundingClientRect()
      const v = viewRef.current
      putView(zoomTo(
        v, v.scale * Math.exp(-wheelPixels(e) * WHEEL_RATE),
        { x: e.clientX - r.left, y: e.clientY - r.top },
        fit, area, maxScale(image, fit),
      ))
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheel)
  }, [image, putView, viewLocked])

  /** 那两颗按钮：以**可视区中心**为锚点放大 / 缩小一档。 */
  const zoomBy = (factor: number) => {
    if (!image) return
    const area = areaRef.current
    const fit = fitBox(image, area)
    const v = viewRef.current
    putView(zoomTo(v, v.scale * factor, { x: area.width / 2, y: area.height / 2 },
      fit, area, maxScale(image, fit)))
  }

  /** 组件真的走掉时，把还挂在 window 上的那套收干净。 */
  useEffect(() => () => {
    stopRef.current?.()
    pinchStopRef.current?.()
  }, [])

  /**
   * 贴到画布上（以及「按住看原图」那张覆盖图）的那个变换。
   * 适应窗口时给 `undefined`：**那一帧必须和加这个功能之前一模一样**，
   * 一个内联样式都不留（布局探针和一堆测试钉的就是那张照片的盒子）。
   * ⚠️ **两张图必须贴同一个** —— 它们是同一张位置上的两张图，差一点按住的那
   * 一下照片的边就会跳。
   */
  const zoomStyle = view.scale === 1 && view.x === 0 && view.y === 0
    ? undefined
    : { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }

  /**
   * ★ 2026-10-06（裁剪）：**预览那一帧**。转多少度、缩多少倍，都在这儿。
   *
   *   · **转**：CSS 是 `rotate(-angle)`。约定（写在 `image/crop.ts` 的 JSDoc 里）：
   *     `angle > 0` ⇒ 照片在**输出**里逆时针转；CSS 的正角度是顺时针，所以
   *     要取负号。⚠️ 写成 `rotate(angle)` 的话，预览和成片会朝**相反方向**转，
   *     而外框尺寸和输出尺寸两边一模一样 —— 单测/探针都看不出这个错。
   *   · **缩**：转过来之后外框（`rotatedBounds`）比照片大，不缩回去就会溢到
   *     左边预设栏、上面带子和右边对话栏上。倍数 `k = min(1, imgW/bw, imgH/bh)`：
   *     它保证转完的**外框**仍然塞得进照片原来那块地方（`imgW/imgH` 是底图自己的
   *     尺寸，不是量出来的 —— 拿盒子来算就是循环依赖），而且 `≤ 1` 不放大。
   *     例子：1200×800 转 15° → 外框 1366×1084 → k = min(1, .879, .738) = .738。
   *
   * 转和缩都绕**元素中心**（CSS `transform-origin` 默认值），而画布是居中在
   * 剪裁层里的 —— 所以变换后照片的包围盒仍然居中、大小正好是
   * `k × 适应窗口的尺寸` 乘上外框的形状。`measure()` 量的
   * `getBoundingClientRect()` 给的就是**这个包围盒**（它算变换后的可见盒子），
   * 于是 `CropOverlay` 拿到的 `box` 正好是"外框在屏幕上的位置" —— 归一化矩形
   * 和它一比就是框该摆的地方。
   *
   * ⚠️ 裁剪时视图一定在「适应窗口」（进工具时 `resetKey` 归位 + 手势停用），
   *    所以这里直接顶掉 `zoomStyle`、不做两个变换的叠加。
   */
  const cropK = crop && image
    ? (() => {
      const b = rotatedBounds(image.width, image.height, crop.angle)
      return Math.min(1, image.width / b.w, image.height / b.h)
    })()
    : 1
  const stageStyle = crop
    ? {
      transform: `rotate(${-crop.angle}deg) scale(${cropK})` +
        `${crop.flipH ? ' scaleX(-1)' : ''}${crop.flipV ? ' scaleY(-1)' : ''}`,
    }
    : zoomStyle

  /** 那排按钮自己的指针事件**不许冒泡到照片上**（理由见下面那段注释）。 */
  const swallow = (e: React.SyntheticEvent) => e.stopPropagation()
  /**
   * 屏幕上那个红圈的直径（像素）。
   *
   * **和送进图里的那个圈共用 mark.ts 的 `markerRadius`**（半径按长边算，8px 的
   * 下限也在那儿）—— 用户的圈和模型的圈**按构造一致**。
   *
   * 为什么非得共用、不能各写一份：`.canvas-marker` 原来写死 44px，图里那个是按
   * 长边的 12% 算的。手机上画布长边 ~350px，两边凑巧都 ~42px，**看不出来**；
   * 桌面上画布长边 750px 时用户看到 44px、模型收到 90px —— 用户指的那一小块，
   * 模型按两倍大去改。和 R14 同一类：看到的东西和送出去的东西不是一回事。
   *
   * 基准必须是**画布盒子**（`box`）本身：wrapper 比画布大，按它算出来的圈在
   * "高度受限"的屏上又会偏大 —— 那是同一个坑的另一半。
   */
  const markerSize = box ? 2 * markerRadius(Math.max(box.width, box.height)) : 0
  const focusAllowed = !!image && !viewLocked && !picking && !sampling
    && !crop && !retouch && !gradient && !perspective && !doubleExposure
    && !text && !frame && !canvasFrame && !liquify && !sticker && !shape
    && !doodle && !light && !duotone && !faceShape && !facePick && !clone
    && !lensFocus

  useEffect(() => {
    if (!focusAllowed && focusView) setFocusView(false)
  }, [focusAllowed, focusView])

  useEffect(() => {
    if (!focusView) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFocusView(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusView])

  return (
    <div
      ref={wrapRef}
      // 放大之后鼠标变成小手（CSS 里 `.zoomed`）：那是在说"这里可以拖"
      // ★ 2026-10-06（裁剪）：`cropping` 和 `.zoomed` 走的是同一条剪裁规矩
      //   （见 CSS）—— 转出来的外框会比照片大，不剪会漏到舞台和对话栏上。
      className={`canvas-wrap${view.scale > 1 ? ' zoomed' : ''}${crop ? ' cropping' : ''}${sampling ? ' sampling' : ''}${focusView ? ' focused' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={e => e.preventDefault()}
      onClick={handlePick}
    >
      {/* ★ 2026-10-06（缩放）：照片（和「按住看原图」那张覆盖图）**剪在这一层里**
          —— 放大之后它们会撑出这块地方，不剪就会盖到上面那条回溯带子和右边
          对话栏上去。
          ⚠️ 红圈**不在**这一层里：它比照片大一圈（半径按照片长边算，桌面上能到
          90px），剪在这儿的话点在照片边上的圈会被切掉半个，而点边上是常事。
          这一层是 `inset: 0`、和 wrap 一样大 —— 所以照片的盒子、居中的算法、
          红圈量出来的那个盒子，**全都没有变**（布局探针量的还是同一张照片）。
          ⚠️ 只有放大之后才真的剪：适应窗口时不剪，才保得住照片那圈"相纸边"
          和底下的投影（都画在盒子外面）。见 CSS 里 `.zoomed` 那条。 */}
      <div className="canvas-clip">
        <canvas key={canvasKey} ref={node => {
          innerRef.current = node
          canvasRef.current = node
        }} className="canvas" style={stageStyle} />
        {doubleExposure && (
          <img
            className="double-exposure"
            src={doubleExposure.preview}
            alt=""
            aria-hidden="true"
            draggable={false}
            style={{
              ...stageStyle,
              opacity: Math.max(0, Math.min(100, doubleExposure.opacity)) / 100,
              mixBlendMode: doubleExposure.mode,
            }}
          />
        )}
        {peeking && originalPreview && (
          <img className="canvas-peek" src={originalPreview} alt="原图" draggable={false} style={stageStyle} />
        )}
        {clipWarnings > 0 && box && !peeking && !viewLocked && (
          <canvas
            ref={clipCanvasRef}
            className="canvas-clipping"
            aria-hidden="true"
            style={{
              left: box.left, top: box.top,
              width: box.width, height: box.height,
            }}
          />
        )}
      </div>
      {/* ★ 2026-10-06（对比）：**分屏那一层**（spec §3.3）—— 左「原图」、右「现在」，
          中间一条能拖的把手。

          ⚠️ 它整个（含把手）挂在 **wrap** 上、不在剪裁层里：那一层放大时有
          `overflow: clip`，而把手要**不随图片缩放**地守在照片区上（它自己里面
          再套一层 `.canvas-clip` 给原图用，见 `ui/CompareSplit` 文件头）。
          ⚠️ 它排在 `.canvas-clip` **之后** → 画在画布之上；又排在红圈 / 框 /
          暗罩 / 右下角那排**之前** → 那些各自的待遇不变（对比和它们是两个工具，
          本来也不会同时开）。
          ⚠️ `transform` 传的是 `stageStyle` —— 和画布**同一个**（适应窗口 / 放大 /
          平移都跟着）：两份是"同一张位置上的两张图"，差一点就对不齐。 */}
      {comparing && compareWith && (
        <CompareSplit src={compareWith} transform={stageStyle} />
      )}
      {/* ★ 2026-10-06（裁剪）：**框和把手**。和红圈同一个待遇 —— 画在剪裁层
          **外面**（把手正好挂在照片边上，剪在里头会被切掉半个）。
          ⚠️ `box` 是量出来的（`getBoundingClientRect` 算变换后的可见盒子），
          裁着的时候它正好是"外框摆在哪、多大"。
          ⚠️ 红圈这时候**不画**：它现在是"外框"的坐标，而红圈是**照片上**的记号
          （相对照片左上角归一化）—— 转起来之后两者不再是同一个坐标系，
          画出来会在错的地方（点选那条路本来也不该在裁剪时进行）。
          ★ 2026-10-07（点修）：点修时也**不画** —— 那一屏的记号是用户正在涂的
          掩码（红影），再叠一个对话红圈只会让人分不清谁是谁。 */}
      {marker && box && !crop && !retouch && !gradient && !perspective && !doubleExposure
        && !text && !frame && !canvasFrame && !liquify && !sticker && !shape && !doodle && !light && !duotone
        && !faceShape && !clone && !sampling && (
        <span
          className="canvas-marker"
          // 用**像素**、以画布盒子为基准（不是 wrapper 的百分比 —— 理由见上面
          // 那个 measurement effect：wrapper 比画布宽，按它定位在"高度受限"
          // 的屏上会偏出好几成）。
          // 直径也是量出来的，不再是 CSS 里写死的 44px（理由见 markerSize）。
          // margin 取半径的相反数，让**圆心**落在那个点上而不是左上角。
          style={{
            left: box.left + marker.x * box.width,
            top: box.top + marker.y * box.height,
            width: markerSize,
            height: markerSize,
            marginLeft: -markerSize / 2,
            marginTop: -markerSize / 2,
          }}
        />
      )}
      {sampling && (
        <div className="wb-pick-hint" role="status">
          {sampleHint ?? '点一下画面里的灰色或白色'}
        </div>
      )}
      {crop && box && (
        <CropOverlay
          box={box} rect={crop.rect} aspect={crop.aspect} inner={crop.inner}
          grid={!!crop.grid}
          guide={crop.guide}
          onRect={crop.onRect}
        />
      )}
      {perspective && box && (
        <PerspectiveOverlay box={box} quad={perspective.quad} onChange={perspective.onChange} />
      )}
      {/* ★ 2026-10-07（点修）：**涂抹层**（spec §3.2）—— 它盖住整块照片区、
          把指针事件关在门里（放大/平移/点选/按住看原图都不误触发），
          滚轮不拦（放大着修细节正是这个工具的用法）。
          ⚠️ 盒子（`box`）是量出来的**照片可见矩形** —— 缩放/平移下它跟着变，
          所以放大着涂也落在照片上对的地方（换算在 `ui/RetouchOverlay`）。
          ⚠️ 它排在裁剪框**之后**（两个工具不会同时开，顺序只为说明层次）、
          排在暗罩和右下角那排**之前**：生成/擦除中的暗罩要盖住它，
          缩放按钮也要保持可点。 */}
      {retouch && box && image && (
        <RetouchOverlay
          box={box}
          imageWidth={image.width}
          imageHeight={image.height}
          radius={retouch.radius}
          mode={retouch.mode}
          mask={retouch.mask}
          onMaskChange={retouch.onMaskChange}
          revision={retouch.revision}
          readOnly={retouch.readOnly}
        />
      )}
      {clone && box && image && (
        <CloneOverlay
          box={box}
          imageWidth={image.width}
          imageHeight={image.height}
          radius={clone.radius}
          source={clone.source}
          offset={clone.offset}
          onStroke={clone.onStroke}
        />
      )}
      {/* ★ 2026-10-17（渐变蒙版）：同样盖住照片区接收拖动；预览在 SVG 里，
          松手后上层只更新一次渐变参数。 */}
      {gradient && box && (
        <GradientOverlay
          box={box}
          spec={gradient.spec}
          onChange={gradient.onChange}
        />
      )}
      {/* ★ 2026-10-17（文字）：预览 + 拖动层。它排在涂抹层之后、暗罩之前
          （两个工具不会同时开）；坐标基准同样是量出来的照片可见矩形。 */}
      {box && image && !comparing && !peeking && layers?.length
        ? layers
          // 局部层是像素效果、不是叠图：它已经在 `effectiveImage` 里了。
          .filter(layer => layer.id !== hiddenLayerId
            && layer.kind !== 'local' && layer.visible !== false)
          .map(layer => layer.kind === 'shape' ? (
            <ShapeOverlay
              key={layer.id}
              box={box}
              imageWidth={image.width}
              imageHeight={image.height}
              options={layer.options}
              onChange={() => {}}
              readOnly
            />
          ) : layer.kind === 'sticker' ? (
            <StickerOverlay
              key={layer.id}
              box={box}
              options={layer.options}
              customPreview={layer.image ?? null}
              onMove={() => {}}
              readOnly
            />
          ) : layer.kind === 'text' ? (
            <TextOverlay
              key={layer.id}
              box={box}
              imageWidth={image.width}
              imageHeight={image.height}
              options={layer.options}
              onMove={() => {}}
              readOnly
            />
          ) : null)
        : null}
      {text && box && image && (
        <TextOverlay
          box={box}
          imageWidth={image.width}
          imageHeight={image.height}
          options={text.options}
          onMove={text.onMove}
        />
      )}
      {/* ★ 2026-10-17（边框）：四条边的预览；成片才真的裁圆角 / 画齿孔。 */}
      {frame && box && image && (
        <FrameOverlay
          box={box}
          imageWidth={image.width}
          imageHeight={image.height}
          options={frame.options}
        />
      )}
      {canvasFrame && box && image && (
        <CanvasFrameOverlay
          box={box}
          imageWidth={image.width}
          imageHeight={image.height}
          options={canvasFrame.options}
          sourceRef={innerRef}
        />
      )}
      {/* ★ 2026-10-17（液化）：笔刷 / 方向线；松手后由 App 落后一帧重采样。 */}
      {liquify && box && image && (
        <LiquifyOverlay
          box={box}
          imageWidth={image.width}
          imageHeight={image.height}
          radius={liquify.radius}
          onStroke={liquify.onStroke}
        />
      )}
      {/* ★ 2026-10-17（贴纸）：预览和成片共用同一份 SVG path。 */}
      {sticker && box && (
        <StickerOverlay
          box={box}
          options={sticker.options}
          customPreview={sticker.customPreview}
          onMove={sticker.onMove}
        />
      )}
      {shape && box && image && (
        <ShapeOverlay
          box={box}
          imageWidth={image.width}
          imageHeight={image.height}
          options={shape.options}
          onChange={shape.onChange}
        />
      )}
      {doodle && box && (
        <DoodleOverlay
          box={box}
          strokes={doodle.strokes}
          color={doodle.color}
          sizePct={doodle.sizePct}
          opacity={doodle.opacity}
          onStroke={doodle.onStroke}
        />
      )}
      {light && box && (
        <LightOverlay box={box} options={light.options} />
      )}
      {duotone && box && image && (
        <DuotoneOverlay box={box} options={duotone.options} sourceRef={innerRef} />
      )}
      {/* ★ 2026-10-19（镜头虚化）：可拖焦点环。只在 App 判定"正在调虚化"
          时传下来；容器本身不挡画布手势，只有小环接指针。 */}
      {lensFocus && box && image && !comparing && !peeking && (
        <LensFocusOverlay
          box={box}
          x={lensFocus.x}
          y={lensFocus.y}
          shape={lensFocus.shape}
          angle={lensFocus.angle}
          band={lensFocus.band}
          onChange={lensFocus.onChange}
        />
      )}
      {facePick && box && image && (
        <ManualFaceOverlay
          box={box}
          imageWidth={image.width}
          imageHeight={image.height}
          onPick={facePick.onPick}
        />
      )}
      {faceShape && box && image && (
        (faceShape.faces?.length ? faceShape.faces : [faceShape.face]).map((face, index) => (
          <FaceGuide
            key={index}
            box={box}
            imageWidth={image.width}
            imageHeight={image.height}
            face={face}
            active={faceShape.selected === index}
            onPick={faceShape.onPickFace ? () => faceShape.onPickFace!(index) : undefined}
            label={faceShape.all && (faceShape.faces?.length ?? 0) > 1
              ? `脸 ${index + 1}`
              : undefined}
          />
        ))
      )}
      {/* ★ 2026-10-06：生成中那层**暗罩 + 转圈**（用户原话：「要让用户知道你在
          干嘛」——那十几秒照片原来完全没反应）。

          它是 wrap 的最后一个孩子 → 画在照片和红圈之上；`absolute; inset: 0`
          按 wrap 定位 —— `.canvas-wrap` 的 `position: relative` 早就有了
          （本来是给 `.canvas-peek` 当包含块的），暗罩搭同一班车。
          ⚠️ 进出由 CSS 管：`pointer-events: none`（只是指示、不挡操作 ——
          「按住看原图」和图上点选照常收得到事件，它们挂在 wrap 上）。
          ⚠️ `aria-hidden`：它本身没有一个字，要把话说出去的是上面那条气泡。 */}
      {busy && <div className="canvas-veil" aria-hidden="true" />}
      {focusAllowed && (
        <button
          type="button"
          className={`canvas-focus-toggle${focusView ? ' on' : ''}`}
          aria-label={focusView ? '退出专注看图' : '专注看图'}
          aria-pressed={focusView}
          title={focusView ? '退出专注看图（Esc）' : '放大查看整张照片'}
          onPointerDown={swallow}
          onClick={(event) => {
            swallow(event)
            setFocusView(value => !value)
          }}
        >
          {focusView
            ? <Minimize2 size={15} strokeWidth={1.5} aria-hidden="true" />
            : <Maximize2 size={15} strokeWidth={1.5} aria-hidden="true" />}
        </button>
      )}
      {/* ★ 2026-10-06（缩放）：照片**右下角那排按钮**（用户：「在对话区设置一个
          功能帮助用户能够正常缩放照片和定位到具体的细节区域」）。

          滚轮和拖动是给"已经知道能这么干"的人用的；**这排按钮是给所有人用的**
          —— 看得见才知道这个功能存在，也是触屏上唯一的入口。
          「适应窗口」只在放大之后才冒出来：没放大时它无事可做，摆着只是噪音。

          ⚠️ 它自己**吃掉指针事件**（`swallow`）：三颗按钮就压在照片上，不挡的话
          按一下加号会先起一段"按下"（0.15 秒之后照片闪成原图），点选模式下
          还会在按钮底下顺手插一个圈。
          ⚠️ 排在暗罩**后面**：生成中那十几秒照片被压暗，这排按钮要保持看得清
          （用户等的正好是"能不能放大看一眼"). */}
      {image && !viewLocked && (
        <div className="zoom-bar" onPointerDown={swallow} onClick={swallow} onDoubleClick={swallow}>
          {/* ★ 2026-10-06（对比）：入口就在这排里（美图也是把它摆在缩放旁边，
              spec §3.3）—— 排**第一颗**不是随手排的：「适应窗口」只在放大之后
              才冒出来，把它排在后面的话，缩一下这颗按钮就跟着挪一格。
              再点一下它 = 退出对比（和工具行那颗同一个开关）。 */}
          {onCompare && (
            <button
              type="button"
              className={`zoom-compare${comparing ? ' on' : ''}`}
              aria-pressed={comparing}
              title="对比原图"
              onClick={onCompare}
            >对比</button>
          )}
          <div className="clip-toggles" role="group" aria-label="裁切警告">
            <button
              type="button"
              className={`zoom-warn high${clipHigh ? ' on' : ''}`}
              aria-label="高光裁切警告"
              aria-pressed={clipHigh}
              title="显示接近纯白的高光像素"
              onClick={() => setClipWarnings(value => value ^ 1)}
            >
              <Sun size={13} strokeWidth={1.5} aria-hidden="true" />
              高光
            </button>
            <button
              type="button"
              className={`zoom-warn low${clipLow ? ' on' : ''}`}
              aria-label="阴影裁切警告"
              aria-pressed={clipLow}
              title="显示接近纯黑的阴影像素"
              onClick={() => setClipWarnings(value => value ^ 2)}
            >
              <Moon size={13} strokeWidth={1.5} aria-hidden="true" />
              暗部
            </button>
          </div>
          <button
            type="button" className="zoom-btn" aria-label="缩小" title="缩小"
            disabled={view.scale <= 1} onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            <Minus size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button
            type="button" className="zoom-btn" aria-label="放大" title="放大"
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <Plus size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
          {view.scale > 1 && (
            <button type="button" className="zoom-fit" onClick={() => putView(FIT)}>适应窗口</button>
          )}
        </div>
      )}
    </div>
  )
}
