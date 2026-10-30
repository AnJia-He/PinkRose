import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import {
  liveLoupeCrop, liveZoomCrop, paintFalseColor, paintFocusPeaking, paintZebra,
} from '../image/liveOverlay'
import { computeHistogram, type HistogramData } from '../render/histogram'

type Props = {
  src: string
}

function drawHistogram(
  ctx: CanvasRenderingContext2D,
  data: HistogramData,
  width: number,
) {
  const cssWidth = ctx.canvas.clientWidth || width
  const scale = Math.max(1, width / Math.max(1, cssWidth))
  const cssBoxW = Math.min(220, Math.max(120, cssWidth * 0.42))
  const cssBoxH = Math.round(cssBoxW * 0.38)
  const boxW = Math.round(cssBoxW * scale)
  const boxH = Math.round(cssBoxH * scale)
  const gap = Math.round(8 * scale)
  const x = width - boxW - gap
  const y = gap
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,.62)'
  ctx.fillRect(x, y, boxW, boxH)
  ctx.strokeStyle = data.highlightClip > 0.005 || data.shadowClip > 0.005
    ? 'rgba(255,92,92,.9)'
    : 'rgba(255,255,255,.28)'
  ctx.lineWidth = scale
  ctx.strokeRect(x + scale / 2, y + scale / 2, boxW - scale, boxH - scale)
  const innerW = boxW - gap * 1.5
  const innerH = boxH - gap * 1.5
  const channel = (values: readonly number[], color: string) => {
    if (values.length === 0) return
    const step = innerW / Math.max(1, values.length - 1)
    ctx.beginPath()
    values.forEach((value, index) => {
      const px = x + gap * 0.75 + index * step
      const py = y + boxH - gap * 0.75 - Math.max(0, Math.min(1, value)) * innerH
      if (index === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(scale, 1)
    ctx.stroke()
  }
  channel(data.r, '#ff6969')
  channel(data.g, '#6be39b')
  channel(data.b, '#76a7ff')
  ctx.restore()
}

/** 相机桥实时取景：画面 + 构图网格 / 对焦峰值 / 过曝斑马纹。 */
export default function CameraLiveView({ src }: Props) {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const loupeRef = useRef<HTMLCanvasElement | null>(null)
  const [grid, setGrid] = useState(true)
  const [peaking, setPeaking] = useState(false)
  const [zebra, setZebra] = useState(false)
  const [falseColor, setFalseColor] = useState(false)
  const [histogram, setHistogram] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [expanded, setExpanded] = useState(false)
  const [loupe, setLoupe] = useState(false)
  const [focus, setFocus] = useState({ x: 0.5, y: 0.5 })
  const [failed, setFailed] = useState(false)

  const paint = useCallback(() => {
    const img = imgRef.current
    const canvas = canvasRef.current
    if (!img || !canvas || !img.naturalWidth || !img.naturalHeight) return
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d', {
      willReadFrequently: peaking || zebra || falseColor || histogram,
    })
    if (!ctx) return
    const crop = liveZoomCrop(img.naturalWidth, img.naturalHeight, zoom, focus.x, focus.y)
    ctx.drawImage(
      img,
      crop.x, crop.y, crop.w, crop.h,
      0, 0, canvas.width, canvas.height,
    )
    let histogramData: HistogramData | null = null
    if (peaking || zebra || falseColor || histogram) {
      try {
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
        if (histogram) histogramData = computeHistogram(frame.data, 64)
        if (falseColor) paintFalseColor(frame.data, canvas.width, canvas.height)
        if (zebra) paintZebra(frame.data, canvas.width, canvas.height)
        if (peaking) paintFocusPeaking(frame.data, canvas.width, canvas.height)
        ctx.putImageData(frame, 0, 0)
      } catch {
        // 跨域画面不能读像素时仍保留原图，只是不给像素级辅助线。
      }
    }
    if (grid) {
      const line = Math.max(1, Math.round(canvas.width / 900))
      ctx.lineWidth = line
      ctx.strokeStyle = 'rgba(255,255,255,.55)'
      ctx.beginPath()
      for (const part of [1 / 3, 2 / 3]) {
        ctx.moveTo(Math.round(canvas.width * part), 0)
        ctx.lineTo(Math.round(canvas.width * part), canvas.height)
        ctx.moveTo(0, Math.round(canvas.height * part))
        ctx.lineTo(canvas.width, Math.round(canvas.height * part))
      }
      ctx.stroke()
    }
    if (zoom > 1) {
      const line = Math.max(8, Math.round(canvas.width / 70))
      const cx = canvas.width / 2
      const cy = canvas.height / 2
      ctx.strokeStyle = 'rgba(255,255,255,.85)'
      ctx.lineWidth = Math.max(1, Math.round(canvas.width / 900))
      ctx.beginPath()
      ctx.moveTo(cx - line, cy)
      ctx.lineTo(cx + line, cy)
      ctx.moveTo(cx, cy - line)
      ctx.lineTo(cx, cy + line)
      ctx.stroke()
    }
    if (histogramData) drawHistogram(ctx, histogramData, canvas.width)

    const loupeCanvas = loupeRef.current
    if (loupe && loupeCanvas) {
      const crop = liveLoupeCrop(img.naturalWidth, img.naturalHeight, focus.x, focus.y)
      loupeCanvas.width = crop.w
      loupeCanvas.height = crop.h
      const loupeCtx = loupeCanvas.getContext('2d')
      if (loupeCtx) {
        loupeCtx.drawImage(
          img,
          crop.x, crop.y, crop.w, crop.h,
          0, 0, crop.w, crop.h,
        )
        const cx = crop.w / 2
        const cy = crop.h / 2
        const arm = Math.max(8, Math.round(Math.min(crop.w, crop.h) * 0.07))
        loupeCtx.strokeStyle = 'rgba(255,255,255,.9)'
        loupeCtx.lineWidth = Math.max(1, Math.round(crop.w / 320))
        loupeCtx.beginPath()
        loupeCtx.moveTo(cx - arm, cy)
        loupeCtx.lineTo(cx + arm, cy)
        loupeCtx.moveTo(cx, cy - arm)
        loupeCtx.lineTo(cx, cy + arm)
        loupeCtx.stroke()
      }
    }
  }, [falseColor, focus.x, focus.y, grid, histogram, loupe, peaking, zebra, zoom])

  const chooseFocus = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const img = imgRef.current
    const canvas = canvasRef.current
    if (!img || !canvas || (zoom <= 1 && !loupe)) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const nx = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const ny = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    const crop = liveZoomCrop(img.naturalWidth, img.naturalHeight, zoom, focus.x, focus.y)
    setFocus({
      x: (crop.x + nx * crop.w) / img.naturalWidth,
      y: (crop.y + ny * crop.h) / img.naturalHeight,
    })
  }

  useEffect(() => {
    setFailed(false)
    paint()
  }, [src, paint])

  useEffect(() => {
    if (!expanded) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setExpanded(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [expanded])

  return (
    <div className="camera-live-view">
      <img
        ref={imgRef}
        src={src}
        alt=""
        crossOrigin="anonymous"
        onLoad={() => { setFailed(false); paint() }}
        onError={() => setFailed(true)}
        hidden
      />
      <div className={`camera-live-frame${expanded ? ' expanded' : ''}`}>
        <canvas
          ref={canvasRef}
          aria-label="相机实时取景"
          style={{ cursor: zoom > 1 ? 'crosshair' : undefined }}
          onPointerDown={chooseFocus}
        />
        {loupe && (
          <div className="camera-loupe" aria-label="100% 对焦放大镜预览">
            <canvas ref={loupeRef} aria-label="100% 对焦放大镜画面" />
            <span>100%</span>
          </div>
        )}
        <div className="camera-live-tools">
          <div className="camera-live-toolgroup" role="group" aria-label="取景辅助">
            <button
              type="button"
              className={`crop-chip${grid ? ' on' : ''}`}
              aria-pressed={grid}
              onClick={() => setGrid(value => !value)}
            >网格</button>
            <button
              type="button"
              className={`crop-chip${peaking ? ' on' : ''}`}
              aria-pressed={peaking}
              onClick={() => setPeaking(value => !value)}
            >对焦峰值</button>
            <button
              type="button"
              className={`crop-chip${zebra ? ' on' : ''}`}
              aria-pressed={zebra}
              onClick={() => setZebra(value => !value)}
            >斑马纹</button>
            <button
              type="button"
              className={`crop-chip${falseColor ? ' on' : ''}`}
              aria-pressed={falseColor}
              onClick={() => setFalseColor(value => !value)}
            >伪色</button>
            <button
              type="button"
              className={`crop-chip${histogram ? ' on' : ''}`}
              aria-pressed={histogram}
              onClick={() => setHistogram(value => !value)}
            >直方图</button>
          </div>
          <div className="camera-live-toolgroup" role="group" aria-label="实时取景放大">
            <button
              type="button"
              className={`crop-chip${loupe ? ' on' : ''}`}
              aria-label="100% 对焦放大镜"
              aria-pressed={loupe}
              onClick={() => setLoupe(value => !value)}
            >100%</button>
            {[1, 2, 4].map(value => (
              <button
                key={value}
                type="button"
                className={`crop-chip${zoom === value ? ' on' : ''}`}
                aria-pressed={zoom === value}
                onClick={() => setZoom(value)}
              >{value}×</button>
            ))}
            <button
              type="button"
              className={`crop-chip${expanded ? ' on' : ''}`}
              aria-label={expanded ? '退出全屏取景' : '全屏取景'}
              aria-pressed={expanded}
              onClick={() => setExpanded(value => !value)}
            >
              {expanded
                ? <Minimize2 size={14} strokeWidth={1.5} aria-hidden="true" />
                : <Maximize2 size={14} strokeWidth={1.5} aria-hidden="true" />}
              全屏
            </button>
          </div>
        </div>
        {failed && <span className="camera-live-error">实时取景没拿到画面</span>}
      </div>
    </div>
  )
}
