import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, ImagePlus, X } from 'lucide-react'
import {
  DEFAULT_GRID_SPLIT_OPTIONS, GRID_SIZES, gridTilePlan,
  splitGrid, type GridSize, type GridSplitOptions,
} from '../image/gridSplit'
import { downloadFile } from '../export/save'
import { Slider } from './kit/Slider.tsx'
import { Btn } from './kit/Btn.tsx'

type Result = { blob: Blob; filename: string; count: number }

function looksLikeImage(file: File): boolean {
  return file.type.startsWith('image/')
    || /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(file.name)
}

function previewOf(file: File): string {
  try { return URL.createObjectURL(file) } catch { return '' }
}

const FORMATS: ['image/jpeg' | 'image/png', string][] = [
  ['image/jpeg', 'JPG'], ['image/png', 'PNG'],
]

/**
 * 九宫格切图（★ 2026-10-18）——「作品」页里的本地工作模式。
 *
 * 一张照片进、N² 张独立图片出，按 1 → N² 打包成 ZIP。支持间距 / 圆角 /
 * 白底或透明底 / JPG 或 PNG / 单格长边上限；预览上直接画格子和序号，
 * 用户发出去之前就知道每张会落在哪一格。
 */
export default function GridSplitPanel({ onBack }: { onBack: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [options, setOptions] = useState<GridSplitOptions>(DEFAULT_GRID_SPLIT_OPTIONS)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const previewRef = useRef<HTMLCanvasElement | null>(null)
  const previewUrlRef = useRef<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!preview) { setImage(null); return }
    let alive = true
    const img = new Image()
    img.onload = () => { if (alive) setImage(img) }
    img.onerror = () => {
      if (alive) setError('这张图在预览里打不开，换一张试试。')
    }
    img.src = preview
    return () => { alive = false }
  }, [preview])

  useEffect(() => {
    const canvas = previewRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !image) return
    const maxW = 720
    const maxH = 520
    const scale = Math.min(maxW / image.naturalWidth, maxH / image.naturalHeight, 1)
    const w = Math.max(1, Math.round(image.naturalWidth * scale))
    const h = Math.max(1, Math.round(image.naturalHeight * scale))
    canvas.width = w
    canvas.height = h
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(image, 0, 0, w, h)

    const stepX = w / options.size
    const stepY = h / options.size
    // 深色描边 + 白色细线：浅照片和深照片上都看得见。
    for (const [lineWidth, strokeStyle] of [[4, 'rgba(0,0,0,.55)'], [2, 'rgba(255,255,255,.95)']] as const) {
      ctx.save()
      ctx.lineWidth = lineWidth
      ctx.strokeStyle = strokeStyle
      ctx.beginPath()
      for (let i = 1; i < options.size; i++) {
        ctx.moveTo(stepX * i, 0)
        ctx.lineTo(stepX * i, h)
        ctx.moveTo(0, stepY * i)
        ctx.lineTo(w, stepY * i)
      }
      ctx.stroke()
      ctx.restore()
    }

    const fontSize = Math.max(12, Math.round(Math.min(w, h) * 0.035))
    for (let index = 0; index < options.size * options.size; index++) {
      const col = index % options.size
      const row = Math.floor(index / options.size)
      const cx = stepX * (col + 0.5)
      const cy = stepY * (row + 0.5)
      const r = fontSize * 0.9
      ctx.save()
      ctx.fillStyle = 'rgba(0,0,0,.48)'
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = `600 ${fontSize}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(index + 1), cx, cy)
      ctx.restore()
    }
  }, [image, options.size])

  function choose(fileToUse: File | null) {
    if (processing) return
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = null
    setResult(null)
    setError(null)
    setImage(null)
    if (!fileToUse) {
      setFile(null)
      setPreview(null)
      return
    }
    if (!looksLikeImage(fileToUse)) {
      setFile(null)
      setPreview(null)
      setError('这个文件不是照片，换一张试试。')
      return
    }
    const url = previewOf(fileToUse)
    previewUrlRef.current = url || null
    setFile(fileToUse)
    setPreview(url || null)
  }

  function update(patch: Partial<GridSplitOptions>) {
    setOptions(prev => {
      const next = { ...prev, ...patch }
      if (next.format === 'image/jpeg' && next.background === 'transparent') {
        next.background = '#ffffff'
      }
      return next
    })
    setResult(null)
    setError(null)
  }

  async function download() {
    if (!file || !image || processing) return
    setProcessing(true)
    setResult(null)
    setError(null)
    try {
      const made = await splitGrid(
        image, image.naturalWidth, image.naturalHeight, options, file.name,
      )
      if (!aliveRef.current) return
      downloadFile(made.zip, made.zipFilename)
      setResult({ blob: made.zip, filename: made.zipFilename, count: made.tiles.length })
    } catch (e) {
      if (!aliveRef.current) return
      console.error('九宫格没切出来', e)
      setError(e instanceof Error ? `这次没切出来：${e.message}` : '这次没切出来，再试一次？')
    } finally {
      if (aliveRef.current) setProcessing(false)
    }
  }

  const count = options.size * options.size
  const transparent = options.background === 'transparent' && options.format !== 'image/jpeg'
  const plan = image ? gridTilePlan(
    image.naturalWidth, image.naturalHeight, options.size,
    options.tileLongEdge, options.gap,
  ) : null

  return (
    <section className="gallery batch-page grid-split-page" aria-busy={processing}>
      <header className="gallery-head batch-head">
        <button className="batch-back" onClick={onBack} disabled={processing}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          作品
        </button>
        <div className="batch-heading">
          <h1 className="gallery-title">九宫格切图</h1>
          <p>一张照片切成 2×2 / 3×3 / 4×4，按顺序打包下载，发出去就能拼回一张。</p>
        </div>
      </header>

      <div className="batch-body">
        <section className="batch-section" aria-labelledby="grid-file-title">
          <div className="batch-section-head">
            <h2 id="grid-file-title">照片</h2>
            <span>{file ? '1 / 1' : '未选择'}</span>
          </div>
          <div
            className={`batch-drop${dragging ? ' over' : ''}`}
            onDragOver={e => { e.preventDefault(); if (!processing) setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => {
              e.preventDefault()
              setDragging(false)
              choose(e.dataTransfer.files[0] ?? null)
            }}
          >
            <input
              ref={inputRef}
              className="batch-file-input"
              type="file"
              accept="image/*,.heic,.heif"
              disabled={processing}
              aria-label="选择要切图的照片"
              onChange={e => {
                choose(e.target.files?.[0] ?? null)
                e.target.value = ''
              }}
            />
            <ImagePlus size={22} strokeWidth={1.5} aria-hidden="true" />
            <div className="batch-drop-copy">
              <strong>{file ? '换一张照片' : '先选一张照片'}</strong>
              <span>支持 JPG / PNG / WebP / HEIC；也可以直接拖进来。</span>
            </div>
            <button className="batch-pick" onClick={() => inputRef.current?.click()}
                    disabled={processing}>
              选照片
            </button>
          </div>
          {file && (
            <ul className="batch-files" aria-label="已选照片">
              <li className="batch-file-row">
                {preview
                  ? <img className="batch-thumb" src={preview} alt="" />
                  : <span className="batch-thumb batch-thumb-empty" aria-hidden="true" />}
                <span className="batch-file-name" title={file.name}>{file.name}</span>
                <button className="batch-remove" aria-label="移除这张照片"
                        disabled={processing} onClick={() => choose(null)}>
                  <X size={15} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </li>
            </ul>
          )}
        </section>

        <section className="batch-section" aria-labelledby="grid-layout-title">
          <div className="batch-section-head">
            <h2 id="grid-layout-title">切法</h2>
            <span>导出 {count} 张</span>
          </div>
          <div className="collage-templates" role="group" aria-label="切图网格">
            {GRID_SIZES.map(size => (
              <button key={size} type="button"
                      className={`crop-chip${options.size === size ? ' on' : ''}`}
                      aria-pressed={options.size === size}
                      disabled={processing}
                      onClick={() => update({ size: size as GridSize })}>
                {size}×{size}
              </button>
            ))}
          </div>
          <div className="collage-controls">
            <Slider label="间距" value={options.gap} min={0} max={24} step={1}
                    changed={options.gap !== DEFAULT_GRID_SPLIT_OPTIONS.gap}
                    onChange={gap => update({ gap })} />
            <Slider label="圆角" value={options.radius} min={0} max={24} step={1}
                    changed={options.radius !== DEFAULT_GRID_SPLIT_OPTIONS.radius}
                    onChange={radius => update({ radius })} />
            <label className="collage-field collage-color">
              <span>背景</span>
              <input type="color"
                     value={transparent ? '#ffffff' : options.background}
                     disabled={processing || transparent}
                     onChange={e => update({ background: e.target.value })} />
            </label>
            {options.format !== 'image/jpeg' && (
              <button type="button"
                      className={`crop-chip${transparent ? ' on' : ''}`}
                      aria-pressed={transparent}
                      disabled={processing}
                      onClick={() => update({ background: transparent ? '#ffffff' : 'transparent' })}>
                透明底
              </button>
            )}
          </div>
          <p className="grid-note">
            间距和圆角只加在每张图的边缘；单格长边 {options.tileLongEdge}px，
            {plan ? ` 实际 ${plan.tileW}×${plan.tileH}px（不会放大原图）` : ' 不会放大原图'}。
          </p>
        </section>

        <section className="batch-section" aria-labelledby="grid-preview-title">
          <div className="batch-section-head">
            <h2 id="grid-preview-title">预览</h2>
            <span>按 1 → {count} 的顺序拼回原图</span>
          </div>
          {!image ? (
            <p className="collage-placeholder">选一张照片，这里会出现切图预览。</p>
          ) : (
            <div className="collage-preview-wrap">
              <canvas ref={previewRef} className="collage-preview grid-preview"
                      aria-label="九宫格切图预览" />
            </div>
          )}
        </section>

        <section className="batch-section" aria-labelledby="grid-export-title">
          <div className="batch-section-head">
            <h2 id="grid-export-title">导出</h2>
            <span>ZIP 里是 {count} 张独立图片</span>
          </div>
          <div className="collage-export">
            <div className="export-row" role="group" aria-label="切图格式">
              <span className="export-label">格式</span>
              {FORMATS.map(([value, label]) => (
                <button key={value}
                        className={`crop-chip${options.format === value ? ' on' : ''}`}
                        aria-pressed={options.format === value}
                        disabled={processing}
                        onClick={() => update({ format: value })}>
                  {label}
                </button>
              ))}
            </div>
            <div className="export-row" role="group" aria-label="单格长边">
              <span className="export-label">单格长边</span>
              {[1080, 2048].map(edge => (
                <button key={edge}
                        className={`crop-chip${options.tileLongEdge === edge ? ' on' : ''}`}
                        aria-pressed={options.tileLongEdge === edge}
                        disabled={processing}
                        onClick={() => update({ tileLongEdge: edge })}>
                  {edge}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="batch-run" aria-label="九宫格操作">
          {error && <p className="batch-error" role="alert">{error}</p>}
          {result && (
            <div className="collage-result">
              <p>九宫格已下载：{result.filename}（{result.count} 张）</p>
              <button className="batch-download"
                      onClick={() => downloadFile(result.blob, result.filename)}>
                <Download size={15} strokeWidth={1.5} aria-hidden="true" />
                再下载一次
              </button>
            </div>
          )}
          <div className="batch-actions">
            <Btn className="batch-run-button" disabled={!image || processing}
                 onClick={() => void download()}>
              <Download size={14} strokeWidth={1.5} aria-hidden="true" />
              {processing ? '正在切…' : `下载 ${count} 张（ZIP）`}
            </Btn>
          </div>
        </section>
      </div>
    </section>
  )
}
