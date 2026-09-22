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
 * 三条路径共用它：pipeline 构造失败、照片尺寸超出浏览器上限（pipeline 抛错）、
 * WebGL 上下文丢失（pipeline 的回调）。
 */
function fail(e: unknown) {
  console.error(e)
  alert('这个浏览器打不开 WebGL2，或画不动这张照片，换 Chrome/Safari 试试，或换张小一点的图')
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
