import {
  useEffect, useRef, useState,
  type CSSProperties, type MouseEvent, type PointerEvent,
} from 'react'
import { RotateCcw, X } from 'lucide-react'
import { makeCanvas } from '../core/canvas'
import { rotatedBounds } from '../core/crop'
import {
  clampBatchCrop, cropAtZoom, maxCropForAspect, moveCropBy, moveCropTo,
  zoomOfCrop, type BatchCropRect,
} from '../core/batchCrop'
import { decodeImageFile } from '../image/decode'
import { exportAspectRatio, type ExportAspect } from '../export/save'
import { Slider } from './kit/Slider.tsx'
import { Btn } from './kit/Btn.tsx'

type Orientation =
  | 'original' | 'left' | 'right' | 'flip180' | 'mirror-h' | 'mirror-v'

type Props = {
  file: File
  name: string
  aspect: Exclude<ExportAspect, 'original'>
  orientation: Orientation
  initialCrop?: BatchCropRect
  onCancel: () => void
  onApply: (crop: BatchCropRect) => void
}

function orientationParts(o: Orientation): { turns: number; flipH: boolean; flipV: boolean } {
  return {
    turns: o === 'left' ? 1 : o === 'right' ? -1 : o === 'flip180' ? 2 : 0,
    flipH: o === 'mirror-h',
    flipV: o === 'mirror-v',
  }
}

/**
 * 把「方向」先落到一张预览图上，再让用户在这个已经转正、翻好的画面上取景。
 *
 * 不能直接拿原始 `<img>` 当底：方向设置改的是像素层，预览若还按原方向显示，
 * 用户框出来的位置在成片里会跟着转 90°；这是那种"预览看着对、导出才错"的
 * 事故，必须在源头对齐。
 */
function orientedPreview(
  bitmap: ImageBitmap,
  orientation: Orientation,
  maxSide: number,
): { url: string; width: number; height: number } {
  const { turns, flipH, flipV } = orientationParts(orientation)
  const angle = turns * 90
  const bounds = rotatedBounds(bitmap.width, bitmap.height, angle)
  const scale = Math.min(1, maxSide / Math.max(bounds.w, bounds.h))
  const { canvas, ctx } = makeCanvas(
    Math.max(1, Math.round(bounds.w * scale)),
    Math.max(1, Math.round(bounds.h * scale)),
    '取景预览画不出来',
  )
  ctx.imageSmoothingQuality = 'high'
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((-angle * Math.PI) / 180)
  if (flipH || flipV) ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1)
  ctx.drawImage(
    bitmap,
    -bitmap.width * scale / 2,
    -bitmap.height * scale / 2,
    bitmap.width * scale,
    bitmap.height * scale,
  )
  return {
    url: canvas.toDataURL('image/jpeg', 0.92),
    width: bounds.w,
    height: bounds.h,
  }
}

export default function BatchCropDialog({
  file, name, aspect, orientation, initialCrop, onCancel, onApply,
}: Props) {
  const ratio = exportAspectRatio(aspect)
  const [preview, setPreview] = useState<{
    url: string; width: number; height: number
  } | null>(null)
  const [crop, setCrop] = useState<BatchCropRect | null>(null)
  const [zoom, setZoom] = useState(100)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    startX: number; startY: number; rect: BatchCropRect; boxW: number; boxH: number
  } | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      let decoded: Awaited<ReturnType<typeof decodeImageFile>> | null = null
      try {
        decoded = await decodeImageFile(file)
        const made = orientedPreview(decoded.bitmap, orientation, 1600)
        if (!alive) return
        const next = initialCrop
          ? clampBatchCrop(initialCrop)
          : maxCropForAspect(made.width, made.height, ratio)
        setPreview(made)
        setCrop(next)
        setZoom(initialCrop ? zoomOfCrop(made.width, made.height, ratio, next) : 100)
      } catch (e) {
        if (alive) {
          console.error('逐张取景预览没生成', e)
          setError(e instanceof Error ? `这张图打不开：${e.message}` : '这张图打不开，换一张试试。')
        }
      } finally {
        decoded?.bitmap.close()
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [file, orientation, ratio, initialCrop])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  function updateZoom(value: number) {
    const next = Math.max(100, Math.min(250, value))
    setZoom(next)
    if (!preview || !crop) return
    const centerX = crop.x + crop.w / 2
    const centerY = crop.y + crop.h / 2
    setCrop(cropAtZoom(preview.width, preview.height, ratio, next / 100, centerX, centerY))
  }

  function startDrag(e: PointerEvent<HTMLDivElement>) {
    if (!crop || !stageRef.current) return
    const box = stageRef.current.getBoundingClientRect()
    if (!box.width || !box.height) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      rect: crop,
      boxW: box.width,
      boxH: box.height,
    }
  }

  function moveDrag(e: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    e.preventDefault()
    setCrop(moveCropBy(
      drag.rect,
      (e.clientX - drag.startX) / drag.boxW,
      (e.clientY - drag.startY) / drag.boxH,
    ))
  }

  function endDrag(e: PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    dragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 已释放 */ }
  }

  function centerAt(e: MouseEvent<HTMLImageElement>) {
    if (!crop || !preview) return
    const box = e.currentTarget.getBoundingClientRect()
    if (!box.width || !box.height) return
    const x = (e.clientX - box.left) / box.width
    const y = (e.clientY - box.top) / box.height
    setCrop(moveCropTo(crop, x, y))
  }

  const style = {
    '--batch-crop-ar': preview ? preview.width / preview.height : 1,
  } as CSSProperties

  return (
    <div className="camera-dialog batch-crop-dialog" role="dialog" aria-modal="true"
      aria-labelledby="batch-crop-title">
      <div className="camera-panel batch-crop-panel">
        <header className="camera-head">
          <div>
            <h2 id="batch-crop-title">逐张取景</h2>
            <p title={name}>{name} · 拖动框选位置，点画面把框移过去。</p>
          </div>
          <button type="button" className="camera-close" aria-label="取消逐张取景" onClick={onCancel}>
            <X size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </header>

        <div className="batch-crop-stage" ref={stageRef}>
          {loading && <p className="tool-note">正在准备取景预览…</p>}
          {error && <p className="batch-error" role="alert">{error}</p>}
          {!loading && !error && preview && crop && (
            <div className="batch-crop-canvas" style={style}>
              <img
                className="batch-crop-image"
                src={preview.url}
                alt=""
                draggable={false}
                onClick={centerAt}
              />
              <div
                className="batch-crop-frame"
                role="group"
                aria-label="裁切框：拖动调整位置，方向键微调，Shift 加速"
                tabIndex={0}
                style={{
                  left: `${crop.x * 100}%`,
                  top: `${crop.y * 100}%`,
                  width: `${crop.w * 100}%`,
                  height: `${crop.h * 100}%`,
                }}
                onPointerDown={startDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 0.05 : 0.01
                  const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
                  const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
                  if (dx === 0 && dy === 0) return
                  e.preventDefault()
                  setCrop(moveCropBy(crop, dx, dy))
                }}
              >
                <i className="batch-crop-grid-v" />
                <i className="batch-crop-grid-v second" />
                <i className="batch-crop-grid-h" />
                <i className="batch-crop-grid-h second" />
              </div>
            </div>
          )}
        </div>

        <div className="batch-crop-controls">
          <Slider
            label="取景范围"
            value={zoom}
            min={100}
            max={250}
            changed={zoom !== 100}
            onChange={updateZoom}
          />
          <p className="batch-crop-hint">
            100% 是这张照片能取到的最大范围；往右拖会缩小取景框，画面中心不动。
            键盘用户点中取景框后，可用方向键微调、Shift + 方向键加速。
          </p>
          <div className="crop-tools">
            <button
              type="button"
              className="crop-btn"
              disabled={!preview || loading}
              onClick={() => {
                setZoom(100)
                if (preview) setCrop(maxCropForAspect(preview.width, preview.height, ratio))
              }}
            >
              <RotateCcw size={14} strokeWidth={1.5} aria-hidden="true" />
              重置取景
            </button>
            <Btn className="crop-done" disabled={!crop || loading || !!error} onClick={() => crop && onApply(crop)}>
              用这个取景
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
