import { useEffect, useRef, type MutableRefObject } from 'react'
import { TonePipeline } from '../render/pipeline'
import type { DecodedImage } from '../image/decode'
import type { Unit } from '../core/tone'

type Props = {
  image: DecodedImage | null
  unit: Unit
  /** App 需要拿到 canvas 元素来做导出 */
  canvasRef: MutableRefObject<HTMLCanvasElement | null>
}

/** 画布只负责"把渲染结果贴出来"，不碰像素、不碰状态。 */
export default function Canvas({ image, unit, canvasRef }: Props) {
  const innerRef = useRef<HTMLCanvasElement | null>(null)
  const pipeRef = useRef<TonePipeline | null>(null)

  useEffect(() => {
    const canvas = innerRef.current
    if (!canvas) return
    try {
      const pipe = new TonePipeline(canvas)
      pipeRef.current = pipe
      return () => {
        pipe.dispose()
        pipeRef.current = null
      }
    } catch (e) {
      console.error(e)
      alert('这个浏览器打不开 WebGL2，换 Chrome 或 Safari 试试')
    }
  }, [])

  // ① 图片换了才上传纹理、重设画布尺寸。
  //    这两件事都很贵——上传一次 1200 万像素的纹理、重设画布尺寸会清空
  //    并重新分配绘图缓冲。**绝不能跟着滑块走。**
  useEffect(() => {
    const pipe = pipeRef.current
    if (!pipe || !image) return
    pipe.setImage(image)
    pipe.resizeToImage()
  }, [image])

  // ② 换图后、以及拖滑块时，都只更新 uniform 重绘一次。
  //    不碰纹理、不碰画布尺寸（spec §5.2：拖滑块只更新 uniform → 60fps）。
  useEffect(() => {
    const pipe = pipeRef.current
    if (!pipe || !image) return
    pipe.render(unit)
  }, [image, unit])

  return <canvas ref={node => {
    innerRef.current = node
    canvasRef.current = node
  }} className="canvas" />
}
