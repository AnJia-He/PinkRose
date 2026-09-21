import { useEffect, useRef } from 'react'
import { TonePipeline } from './render/pipeline'
import { ZERO, toUnit } from './core/adjustments'

export default function App() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    const pipe = new TonePipeline(canvas)
    // 造一张测试图。上半/下半颜色不同、左上角有白方块——
    // 这样"上下颠倒"或"左右镜像"是**看得出来**的。
    // （早先的版本左右分色、上下对称，恰好掩盖了 V 轴翻转的 bug。）
    const c = document.createElement('canvas')
    c.width = c.height = 256
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#808080'                    // 上半：中灰
    ctx.fillRect(0, 0, 256, 128)
    ctx.fillStyle = '#cc6633'                    // 下半：橙
    ctx.fillRect(0, 128, 256, 128)
    ctx.fillStyle = '#ffffff'                    // 左上角白方块
    ctx.fillRect(0, 0, 56, 56)
    createImageBitmap(c).then(bm => {
      pipe.setImage({ bitmap: bm, width: 256, height: 256 })
      pipe.resizeToImage()
      pipe.render(toUnit({ ...ZERO, exposure: 40, saturation: 50, temperature: 30 }))
    })
    return () => pipe.dispose()
  }, [])
  return <canvas ref={ref} style={{ maxWidth: '90vw', maxHeight: '90vh' }} />
}
