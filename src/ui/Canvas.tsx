import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { TonePipeline } from '../render/pipeline'
import type { DecodedImage } from '../image/decode'
import type { NormPoint } from '../image/mark'
import { markerRadius } from '../image/mark'
import type { Adjustments } from '../../shared/adjustments.ts'
import type { Cube } from '../../shared/lut.ts'

type Props = {
  image: DecodedImage | null
  params: Adjustments
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
  /** 用户点的那个点，0~1（**相对照片左上角**）。null = 还没点。 */
  marker?: NormPoint | null
  onPickPoint?: (x: number, y: number) => void
  /** 画面这条路出了事，把**要说给用户的那句话**交出去（由 App 决定在哪儿显示）。
   *  组件自己不弹窗、不存状态：它只负责"把话说清楚"，说不说、在哪儿说是上层的事。 */
  onFail?: (message: string) => void
}

/** 画布相对 wrapper 的盒子，单位像素。红圈按它定位（理由见下面那段注释）。 */
type CanvasBox = { left: number; top: number; width: number; height: number }

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
  image, params, lutCube, lutAmount, originalPreview, canvasRef, picking, marker, onPickPoint, onFail,
}: Props) {
  const innerRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const pipeRef = useRef<TonePipeline | null>(null)
  /** 用户此刻按住了画面（在看原图）。 */
  const [peeking, setPeeking] = useState(false)
  /** 画布相对 wrapper 的盒子。红圈的定位基准 —— 见下面那个 effect 里的理由。 */
  const [box, setBox] = useState<CanvasBox | null>(null)

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
  }, [report])

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
  }, [image, report])

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
  }, [lutCube, report])

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
  //    ⚠️ 这是**渲染**那条 effect，和上面那条 `setLut` 的依赖是两件事、别抄错：
  //    上面只能有 `[lutCube, report]`（amount 进去就是每帧重传 1MB 纹理）。
  useEffect(() => {
    const pipe = pipeRef.current
    if (!pipe || !image) return
    pipe.render(params, lutAmount)
  }, [image, params, lutAmount, lutCube])

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
    }
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
  }, [image])

  /**
   * 把屏幕上点的那一下换算成 0~1 的归一化坐标。
   *
   * ⚠️ 量的必须是**画布**：wrapper 比画布宽（见上面那个 effect）。
   * 点在照片外面（stage 的留白上）不算数 —— 那不是在指照片里的东西。
   */
  const handlePick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!picking || !onPickPoint) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    // 归一化到 0~1：这样画布怎么缩放都不影响标记的位置
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    if (x < 0 || x > 1 || y < 0 || y > 1) return
    onPickPoint(x, y)
  }

  /**
   * 「按住图 = 看原图，松手回来」（spec §2.5）。
   *
   * 手势挂在 wrap 上、不是挂在画布上：手指落在画布外那圈留白上时，事件也要
   * 收得到（画布盖不住那一圈），peek 就挂在它里面。
   * ⚠️ 但**"照片那一块地方"是画布，不是 wrap** —— wrap 比画布大，两者在
   * "高度受限"的屏上差着几十像素。要换算照片上的位置，量的一律是画布
   * （见 handlePick 和上面那个 measurement effect）。
   *
   * **三种"松手"都要收拾干净**：抬手、手指滑出画面、系统把指针抢走
   * （来电、通知、滚动接管）——少接一个，用户按一下就被永久留在原图上，
   * 而他没有任何办法按回来。
   *
   * onContextMenu 拦的是另一件事：桌面右键、以及 **Android Chrome 长按**，
   * 默认都会弹"下载图片 / 复制"这类系统菜单，跟按住看原图直接打架。
   */
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

  return (
    <div
      ref={wrapRef}
      className="canvas-wrap"
      onPointerDown={() => {
        // 点选模式里不许 peek：那一下是"点一下告诉我是哪儿"，不是"按住看原图"。
        // 不挡的话**每次点选都会先闪一下没调过色的原图**。
        if (picking) return
        if (originalPreview) setPeeking(true)
      }}
      onPointerUp={() => setPeeking(false)}
      onPointerCancel={() => setPeeking(false)}
      onPointerLeave={() => setPeeking(false)}
      onContextMenu={e => e.preventDefault()}
      onClick={handlePick}
    >
      <canvas ref={node => {
        innerRef.current = node
        canvasRef.current = node
      }} className="canvas" />
      {peeking && originalPreview && (
        <img className="canvas-peek" src={originalPreview} alt="原图" draggable={false} />
      )}
      {marker && box && (
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
    </div>
  )
}
