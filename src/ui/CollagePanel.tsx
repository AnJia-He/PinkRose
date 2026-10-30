import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, ImagePlus, Play, Square, X } from 'lucide-react'
import {
  COLLAGE_TEMPLATES, DEFAULT_COLLAGE_OPTIONS, MAX_COLLAGE_FILES, exportCollage,
  renderCollageCanvas, type CollageLayout, type CollageOptions,
  type CollageProgress, type CollageRatio, type CollageSource,
} from '../image/collage'
import { downloadImage, type ExportFormat } from '../export/save'
import { Slider } from './kit/Slider.tsx'
import { Btn } from './kit/Btn.tsx'

type Picked = {
  id: string
  file: File
  preview: string
}

function previewOf(file: File): string {
  try { return URL.createObjectURL(file) } catch { return '' }
}

function looksLikeImage(file: File): boolean {
  return file.type.startsWith('image/')
    || /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(file.name)
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('这张图在预览里没有打开'))
    image.src = src
  })
}

const RATIOS: [CollageRatio, string][] = [
  ['1:1', '1:1'], ['4:5', '4:5'], ['3:4', '3:4'], ['16:9', '16:9'],
]

const LAYOUTS: [CollageLayout, string][] = [
  ['auto', '自动'], ['grid', '网格'], ['feature-left', '大图在左'], ['feature-top', '大图在上'],
]

const FORMATS: [ExportFormat, string][] = [
  ['image/jpeg', 'JPG'], ['image/png', 'PNG'], ['image/webp', 'WebP'],
]

/**
 * 多图拼图（★ 2026-10-17）。它是「作品」页里的另一个本地工作模式：
 * 选 2–9 张、选版式、看实时预览、一次导出。和批量处理一样，不占左栏导航，
 * 因为窄屏导航已经放满，而这两件事都属于“把作品交出去”的语境。
 */
export default function CollagePanel({ onBack }: { onBack: () => void }) {
  const [files, setFiles] = useState<Picked[]>([])
  const [options, setOptions] = useState<CollageOptions>(DEFAULT_COLLAGE_OPTIONS)
  const [processing, setProcessing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<CollageProgress | null>(null)
  const [previewFailed, setPreviewFailed] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ blob: Blob; filename: string } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const previewRef = useRef<HTMLCanvasElement | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const previewsRef = useRef<string[]>([])
  const idRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
      for (const url of previewsRef.current) URL.revokeObjectURL(url)
      previewsRef.current = []
    }
  }, [])

  useEffect(() => {
    let alive = true
    if (files.length < 2) {
      const canvas = previewRef.current
      const ctx = canvas?.getContext('2d')
      if (canvas && ctx) {
        canvas.width = 1
        canvas.height = 1
        ctx.clearRect(0, 0, 1, 1)
      }
      setPreviewFailed(null)
      return
    }
    void (async () => {
      try {
        const images = await Promise.all(files.map(f => loadImage(f.preview)))
        if (!alive) return
        const sources: CollageSource[] = images.map(image => ({
          image, width: image.naturalWidth, height: image.naturalHeight,
        }))
        const rendered = renderCollageCanvas(sources, options, 720)
        const target = previewRef.current
        const ctx = target?.getContext('2d')
        if (!target || !ctx) return
        target.width = rendered.width
        target.height = rendered.height
        ctx.drawImage(rendered, 0, 0)
        setPreviewFailed(null)
      } catch (e) {
        if (alive) {
          console.error('拼图预览没画出来', e)
          setPreviewFailed('预览没画出来，换一张图试试。')
        }
      }
    })()
    return () => { alive = false }
  }, [files, options.ratio, options.layout, options.gap, options.radius, options.background])

  function changed() {
    setResult(null)
    setError(null)
  }

  function addFiles(list: FileList | File[]) {
    if (processing) return
    const incoming = Array.from(list).filter(looksLikeImage)
    const room = Math.max(0, MAX_COLLAGE_FILES - files.length)
    const accepted = incoming.slice(0, room).map(file => ({
      id: `collage-${Date.now()}-${++idRef.current}`,
      file,
      preview: previewOf(file),
    }))
    for (const item of accepted) {
      if (item.preview) previewsRef.current.push(item.preview)
    }
    setFiles(prev => [...prev, ...accepted])
    changed()
    if (incoming.length > room) {
      setError(`一次最多拼 ${MAX_COLLAGE_FILES} 张，多出来的这次没收。`)
    } else if (incoming.length === 0 && list.length > 0) {
      setError('这些文件不是照片，换一批试试。')
    }
  }

  function removeFile(id: string) {
    if (processing) return
    const hit = files.find(f => f.id === id)
    if (hit?.preview) {
      URL.revokeObjectURL(hit.preview)
      previewsRef.current = previewsRef.current.filter(url => url !== hit.preview)
    }
    setFiles(prev => prev.filter(f => f.id !== id))
    changed()
    setProgress(null)
  }

  function update(patch: Partial<CollageOptions>) {
    setOptions(prev => ({ ...prev, ...patch }))
    changed()
  }

  async function run() {
    if (files.length < 2 || processing) return
    const controller = new AbortController()
    controllerRef.current = controller
    setProcessing(true)
    setResult(null)
    setError(null)
    setProgress({ completed: 0, total: files.length, currentName: files[0]!.file.name })
    try {
      const made = await exportCollage(
        files.map(f => f.file),
        options,
        next => { if (mountedRef.current) setProgress(next) },
        controller.signal,
      )
      if (!mountedRef.current) return
      setResult(made)
      downloadImage(made.blob, made.filename)
    } catch (e) {
      if (!mountedRef.current) return
      if (e instanceof DOMException && e.name === 'AbortError') {
        setError('已经停止，没有生成半张拼图。')
      } else {
        console.error('拼图没生成', e)
        setError(e instanceof Error ? `这张拼图没生成：${e.message}` : '这张拼图没生成，再试一次？')
      }
    } finally {
      if (mountedRef.current) setProcessing(false)
      controllerRef.current = null
    }
  }

  const done = progress?.completed ?? 0
  const total = progress?.total ?? files.length
  const lossy = options.format !== 'image/png'
  const templateActive = (patch: (typeof COLLAGE_TEMPLATES)[number]['patch']) =>
    patch.ratio === options.ratio && patch.layout === options.layout
    && patch.gap === options.gap && patch.radius === options.radius
    && patch.background === options.background

  return (
    <section className="gallery batch-page collage-page" aria-busy={processing}>
      <header className="gallery-head batch-head">
        <button className="batch-back" onClick={onBack} disabled={processing}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          作品
        </button>
        <div className="batch-heading">
          <h1 className="gallery-title">拼图</h1>
          <p>把几张照片拼成一张，按统一版式导出。</p>
        </div>
      </header>

      <div className="batch-body">
        <section className="batch-section" aria-labelledby="collage-photos-title">
          <div className="batch-section-head">
            <h2 id="collage-photos-title">照片</h2>
            <span>{files.length} / {MAX_COLLAGE_FILES}</span>
          </div>
          <div
            className={`batch-drop${dragging ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); if (!processing) setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              addFiles(e.dataTransfer.files)
            }}
          >
            <input
              ref={inputRef}
              className="batch-file-input"
              type="file"
              accept="image/*,.heic,.heif"
              multiple
              disabled={processing}
              aria-label="选择要拼图的照片"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <ImagePlus size={22} strokeWidth={1.5} aria-hidden="true" />
            <div className="batch-drop-copy">
              <strong>{files.length ? '继续加照片' : '先选两张照片'}</strong>
              <span>按选择顺序排列；可以直接拖进来。</span>
            </div>
            <button className="batch-pick" onClick={() => inputRef.current?.click()}
                    disabled={processing || files.length >= MAX_COLLAGE_FILES}>
              选照片
            </button>
          </div>

          {files.length > 0 && (
            <ul className="batch-files collage-files" aria-label="拼图照片顺序">
              {files.map((item, index) => (
                <li key={item.id} className="batch-file-row collage-file-row">
                  <span className="collage-order" aria-hidden="true">{index + 1}</span>
                  {item.preview
                    ? <img className="batch-thumb" src={item.preview} alt="" />
                    : <span className="batch-thumb batch-thumb-empty" aria-hidden="true" />}
                  <span className="collage-file-copy">
                    <span className="batch-file-name" title={item.file.name}>{item.file.name}</span>
                    <span className="batch-file-size">{fileSize(item.file.size)}</span>
                  </span>
                  <button
                    className="batch-remove"
                    aria-label={`移除 ${item.file.name}`}
                    disabled={processing}
                    onClick={() => removeFile(item.id)}
                  >
                    <X size={15} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="batch-section" aria-labelledby="collage-layout-title">
          <div className="batch-section-head">
            <h2 id="collage-layout-title">版式</h2>
            <span>预览会跟着变</span>
          </div>
          <div className="collage-templates" role="group" aria-label="拼图模板">
            {COLLAGE_TEMPLATES.map(t => (
              <button
                key={t.id} type="button"
                className={`crop-chip${templateActive(t.patch) ? ' on' : ''}`}
                aria-pressed={templateActive(t.patch)}
                disabled={processing}
                onClick={() => update(t.patch)}
              >{t.label}</button>
            ))}
          </div>
          <div className="collage-controls">
            <label className="collage-field">
              <span>画幅</span>
              <select value={options.ratio} disabled={processing}
                      onChange={e => update({ ratio: e.target.value as CollageRatio })}>
                {RATIOS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="collage-field">
              <span>排列</span>
              <select value={options.layout} disabled={processing}
                      onChange={e => update({ layout: e.target.value as CollageLayout })}>
                {LAYOUTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <Slider
              label="间距" value={options.gap} min={0} max={60} step={2}
              changed={options.gap !== DEFAULT_COLLAGE_OPTIONS.gap}
              onChange={gap => update({ gap })}
            />
            <Slider
              label="圆角" value={options.radius} min={0} max={80} step={2}
              changed={options.radius !== DEFAULT_COLLAGE_OPTIONS.radius}
              onChange={radius => update({ radius })}
            />
            <label className="collage-field collage-color">
              <span>背景</span>
              <input type="color" value={options.background} disabled={processing}
                     onChange={e => update({ background: e.target.value })} />
            </label>
          </div>
        </section>

        <section className="batch-section" aria-labelledby="collage-preview-title">
          <div className="batch-section-head">
            <h2 id="collage-preview-title">预览</h2>
            <span>照片按居中裁切，不拉伸</span>
          </div>
          {files.length < 2 ? (
            <p className="collage-placeholder">再选一张照片，这里就会出现拼图预览。</p>
          ) : (
            <div className="collage-preview-wrap">
              <canvas ref={previewRef} className="collage-preview" aria-label="拼图预览" />
            </div>
          )}
          {previewFailed && <p className="batch-error">{previewFailed}</p>}
        </section>

        <section className="batch-section" aria-labelledby="collage-export-title">
          <div className="batch-section-head">
            <h2 id="collage-export-title">导出</h2>
            <span>长边决定成片清晰度</span>
          </div>
          <div className="collage-export">
            <div className="export-row" role="group" aria-label="拼图格式">
              <span className="export-label">格式</span>
              {FORMATS.map(([value, label]) => (
                <button key={value} className={`crop-chip${options.format === value ? ' on' : ''}`}
                        aria-pressed={options.format === value} disabled={processing}
                        onClick={() => update({ format: value })}>
                  {label}
                </button>
              ))}
            </div>
            {lossy && (
              <label className="collage-quality">
                <span className="export-label">质量</span>
                <input type="range" min={60} max={100} step={1}
                       value={options.qualityPct} disabled={processing}
                       onChange={e => update({ qualityPct: Number(e.target.value) })} />
                <span className="collage-quality-value">{options.qualityPct}%</span>
              </label>
            )}
            <div className="export-row" role="group" aria-label="拼图长边">
              <span className="export-label">长边</span>
              {[2048, 1080].map(edge => (
                <button key={edge} className={`crop-chip${options.longEdge === edge ? ' on' : ''}`}
                        aria-pressed={options.longEdge === edge} disabled={processing}
                        onClick={() => update({ longEdge: edge })}>
                  {edge}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="batch-run" aria-label="拼图操作">
          {error && <p className="batch-error" role="alert">{error}</p>}
          {progress && (
            <div className="batch-progress" aria-live="polite">
              <div className="batch-progress-copy">
                <span>{processing ? '正在拼图' : '这一次已经处理完'}</span>
                <span>{done} / {total}</span>
              </div>
              <progress value={done} max={Math.max(1, total)} aria-label="拼图进度" />
              {processing && progress.currentName && (
                <p className="batch-current">{progress.currentName}</p>
              )}
            </div>
          )}
          {result && (
            <div className="collage-result">
              <p>拼图已下载：{result.filename}</p>
              <button className="batch-download"
                      onClick={() => downloadImage(result.blob, result.filename)}>
                <Download size={15} strokeWidth={1.5} aria-hidden="true" />
                再下载一次
              </button>
            </div>
          )}
          <div className="batch-actions">
            {processing ? (
              <button className="batch-stop" onClick={() => controllerRef.current?.abort()}>
                <Square size={13} strokeWidth={1.5} aria-hidden="true" />
                停止
              </button>
            ) : (
              <Btn className="batch-run-button" disabled={files.length < 2}
                   onClick={() => void run()}>
                <Play size={14} strokeWidth={1.5} aria-hidden="true" />
                {result ? '再拼一张' : '生成拼图'}
              </Btn>
            )}
          </div>
        </section>
      </div>
    </section>
  )
}
