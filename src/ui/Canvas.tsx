import { useEffect, useRef, type MutableRefObject } from 'react'
import { TonePipeline } from '../render/pipeline'
import type { DecodedImage } from '../image/decode'
import type { Adjustments } from '../../shared/adjustments.ts'

type Props = {
  image: DecodedImage | null
  params: Adjustments
  /** App 需要拿到 canvas 元素来做导出 */
  canvasRef: MutableRefObject<HTMLCanvasElement | null>
}

/**
 * 渲染链路的统一失败出口：控制台留痕 + 用户可见的 alert。
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
/** 上一句已经弹过的提示。用来防重复弹窗：开发模式下 React 会把 effect 跑两遍，
 *  **同一句话弹两次**既莫名其妙又像出了两个错。内容不同的错照弹。 */
let lastShown = ''

function fail(e: unknown) {
  console.error(e)
  const msg = e instanceof Error ? e.message : ''
  let say: string
  if (msg.includes('不支持 WebGL2')) {
    say = '这个浏览器打不开 WebGL2。请换 Chrome 或 Safari 打开。'
  } else if (msg.includes('超出本浏览器的画布上限')) {
    say = `${msg}。换一张小一点的照片试试。`
  } else if (msg.includes('上下文丢失')) {
    say = '这张照片太大，浏览器画到一半扛不住了。换一张小一点的照片试试。'
  } else {
    say = '画面出问题了。先刷新一下；还不行就换 Chrome 或 Safari。'
  }
  if (say === lastShown) return
  lastShown = say
  alert(say)
}

/** 画布只负责"把渲染结果贴出来"，不碰像素、不碰状态。 */
export default function Canvas({ image, params, canvasRef }: Props) {
  const innerRef = useRef<HTMLCanvasElement | null>(null)
  const pipeRef = useRef<TonePipeline | null>(null)

  useEffect(() => {
    const canvas = innerRef.current
    if (!canvas) return
    try {
      const pipe = new TonePipeline(canvas, fail)
      pipeRef.current = pipe
      return () => {
        pipe.dispose()
        pipeRef.current = null
      }
    } catch (e) {
      fail(e)
    }
  }, [])

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
      fail(e)
    }
  }, [image])

  // ② 换图后、以及拖滑块时，都只更新 uniform 重绘一次。
  //    不碰纹理、不碰画布尺寸（spec §5.2：拖滑块只更新 uniform → 60fps）。
  useEffect(() => {
    const pipe = pipeRef.current
    if (!pipe || !image) return
    pipe.render(params)
  }, [image, params])

  return <canvas ref={node => {
    innerRef.current = node
    canvasRef.current = node
  }} className="canvas" />
}
