import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, Download, ImagePlus, X } from 'lucide-react'
import {
  DEFAULT_LONG_IMAGE_OPTIONS, LONG_IMAGE_MAX_EDGE, MAX_LONG_IMAGE_FILES,
  exportLongImage, renderLongImageCanvas, type LongImageDirection,
  type LongImageOptions, type LongImageSource,
} from '../image/longImage'
import { downloadFile, type ExportFormat } from '../export/save'
import { Slider } from './kit/Slider.tsx'
import { Btn } from './kit/Btn.tsx'

type Picked = { id: string; file: File; preview: string }
type Result = { blob: Blob; filename: string; width: number; height: number }

const FORMATS: [ExportFormat, string][] = [
  ['image/jpeg', 'JPG'], ['image/png', 'PNG'], ['image/webp', 'WebP'],
]

const DIRECTIONS: [LongImageDirection, string][] = [
  ['vertical', '纵向'], ['horizontal', '横向'],
]

const EDGES = [1080, 1440, 2048]

function looksLikeImage(file: File): boolean {
  return file.type.startsWith('image/')
    || /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(file.name)
}

function previewOf(file: File): string {
  try { return URL.createObjectURL(file) } catch { return '' }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('这张图在预览里没有打开'))
    image.src = src
  })
}

/** 长图拼接（★ 2026-10-18）—— 作品页里的本地多图工作模式。 */
export default function LongImagePanel({ onBack }: { onBack: () => void }) {
  const [files, setFiles] = useState<Picked[]>([])
  const [sources, setSources] = useState<LongImageSource[]>([])
  const [options, setOptions] = useState<LongImageOptions>(DEFAULT_LONG_IMAGE_OPTIONS)
  const [processing, setProcessing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [previewFailed, setPreviewFailed] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const previewRef = useRef<HTMLCanvasElement | null>(null)
  const previewsRef = useRef<string[]>([])
  const idRef = useRef(0)
  const seqRef = useRef(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      for (const url of previewsRef.current) URL.revokeObjectURL(url)
      previewsRef.current = []
    }
  }, [])

  useEffect(() => {
    if (files.length === 0) {
      setSources([])
      return
    }
    let alive = true
    const seq = ++seqRef.current
    setPreviewFailed(null)
    Promise.all(files.map(f => loadImage(f.preview))).then(
      images => {
        if (!alive || seq !== seqRef.current) return
        setSources(images.map(image => ({
          image, width: image.naturalWidth, height: image.naturalHeight,
        })))
      },
      (e) => {
        if (!alive || seq !== seqRef.current) return
        console.error('长图照片没有打开', e)
        setSources([])
        setPreviewFailed('有照片在预览里打不开，换一张试试。')
      },
    )
    return () => { alive = false }
  }, [files])

  useEffect(() => {
    const canvas = previewRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    if (sources.length < 2) {
      canvas.width = 1
      canvas.height = 1
      ctx.clearRect(0, 0, 1, 1)
      setPreviewFailed(null)
      return
    }
    try {
      const rendered = renderLongImageCanvas(sources, options, 720)
      canvas.width = rendered.width
      canvas.height = rendered.height
      ctx.clearRect(0, 0, rendered.width, rendered.height)
      ctx.drawImage(rendered, 0, 0)
      setPreviewFailed(null)
    } catch (e) {
      console.error('长图预览没画出来', e)
      setPreviewFailed('预览没画出来，换几张图试试。')
    }
  }, [sources, options.direction, options.gap, options.radius, options.background])

  function changed() {
    setResult(null)
    setError(null)
  }

  function addFiles(list: FileList | File[]) {
    if (processing) return
    const incoming = Array.from(list).filter(looksLikeImage)
    const room = Math.max(0, MAX_LONG_IMAGE_FILES - files.length)
    const accepted = incoming.slice(0, room).map(file => ({
      id: `long-${Date.now()}-${++idRef.current}`,
      file,
      preview: previewOf(file),
    }))
    for (const item of accepted) {
      if (item.preview) previewsRef.current.push(item.preview)
    }
    setFiles(prev => [...prev, ...accepted])
    changed()
    if (incoming.length > room) {
      setError(`一次最多拼 ${MAX_LONG_IMAGE_FILES} 张，多出来的这次没收。`)
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
  }

  function moveFile(index: number, delta: -1 | 1) {
    if (processing) return
    const next = index + delta
    if (next < 0 || next >= files.length) return
    setFiles(prev => {
      const copy = [...prev]
      const [item] = copy.splice(index, 1)
      if (item) copy.splice(next, 0, item)
      return copy
    })
    changed()
  }

  function update(patch: Partial<LongImageOptions>) {
    setOptions(prev => ({ ...prev, ...patch }))
    changed()
  }

  async function download() {
    if (files.length < 2 || sources.length < 2 || processing) return
    setProcessing(true)
    setResult(null)
    setError(null)
    try {
      const made = await exportLongImage(sources, options, files[0]!.file.name)
      if (!aliveRef.current) return
      downloadFile(made.blob, made.filename)
      setResult(made)
    } catch (e) {
      if (!aliveRef.current) return
      console.error('长图没拼出来', e)
      setError(e instanceof Error ? `这次没拼出来：${e.message}` : '这次没拼出来，再试一次？')
    } finally {
      if (aliveRef.current) setProcessing(false)
    }
  }

  const lossy = options.format !== 'image/png'
  return (
    <section className="gallery batch-page long-image-page" aria-busy={processing}>
      <header className="gallery-head batch-head">
        <button className="batch-back" onClick={onBack} disabled={processing}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          作品
        </button>
        <div className="batch-heading">
          <h1 className="gallery-title">长图拼接</h1>
          <p>把聊天记录、截图或步骤图按顺序接成一张长图，纵向横向都行。</p>
        </div>
      </header>

      <div className="batch-body">
        <section className="batch-section" aria-labelledby="long-files-title">
          <div className="batch-section-head">
            <h2 id="long-files-title">照片</h2>
            <span>{files.length} / {MAX_LONG_IMAGE_FILES}</span>
          </div>
          <div
            className={`batch-drop${dragging ? ' over' : ''}`}
            onDragOver={e => { e.preventDefault(); if (!processing) setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => {
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
              aria-label="选择要拼长图的照片"
              onChange={e => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <ImagePlus size={22} strokeWidth={1.5} aria-hidden="true" />
            <div className="batch-drop-copy">
              <strong>{files.length ? '继续加照片' : '先选两张照片'}</strong>
              <span>按选择顺序拼接；可以直接拖进来。</span>
            </div>
            <button className="batch-pick" onClick={() => inputRef.current?.click()}
                    disabled={processing || files.length >= MAX_LONG_IMAGE_FILES}>
              选照片
            </button>
          </div>

          {files.length > 0 && (
            <ul className="batch-files long-files" aria-label="长图照片顺序">
              {files.map((item, index) => (
                <li key={item.id} className="batch-file-row long-file-row">
                  <span className="collage-order" aria-hidden="true">{index + 1}</span>
                  {item.preview
                    ? <img className="batch-thumb" src={item.preview} alt="" />
                    : <span className="batch-thumb batch-thumb-empty" aria-hidden="true" />}
                  <span className="batch-file-name" title={item.file.name}>{item.file.name}</span>
                  <span className="long-order-actions">
                    <button type="button" className="batch-remove" aria-label={`上移 ${item.file.name}`}
                            disabled={processing || index === 0}
                            onClick={() => moveFile(index, -1)}>
                      <ArrowUp size={14} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                    <button type="button" className="batch-remove" aria-label={`下移 ${item.file.name}`}
                            disabled={processing || index === files.length - 1}
                            onClick={() => moveFile(index, 1)}>
                      <ArrowDown size={14} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  </span>
                  <button className="batch-remove" aria-label={`移除 ${item.file.name}`}
                          disabled={processing} onClick={() => removeFile(item.id)}>
                    <X size={15} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="batch-section" aria-labelledby="long-layout-title">
          <div className="batch-section-head">
            <h2 id="long-layout-title">排版</h2>
            <span>按 1 → {files.length} 的顺序</span>
          </div>
          <div className="collage-templates" role="group" aria-label="长图方向">
            {DIRECTIONS.map(([value, label]) => (
              <button key={value} type="button"
                      className={`crop-chip${options.direction === value ? ' on' : ''}`}
                      aria-pressed={options.direction === value}
                      disabled={processing}
                      onClick={() => update({ direction: value })}>
                {label}
              </button>
            ))}
          </div>
          <div className="collage-controls">
            <Slider label="间距" value={options.gap} min={0} max={48} step={2}
                    changed={options.gap !== DEFAULT_LONG_IMAGE_OPTIONS.gap}
                    onChange={gap => update({ gap })} />
            <Slider label="圆角" value={options.radius} min={0} max={32} step={1}
                    changed={options.radius !== DEFAULT_LONG_IMAGE_OPTIONS.radius}
                    onChange={radius => update({ radius })} />
            <label className="collage-field collage-color">
              <span>背景</span>
              <input type="color" value={options.background} disabled={processing}
                     onChange={e => update({ background: e.target.value })} />
            </label>
          </div>
          <p className="long-note">
            {options.direction === 'vertical' ? '固定宽度' : '固定高度'}按原比例缩放；
            总长超过 {LONG_IMAGE_MAX_EDGE}px 时会整体等比缩小。
          </p>
        </section>

        <section className="batch-section" aria-labelledby="long-preview-title">
          <div className="batch-section-head">
            <h2 id="long-preview-title">预览</h2>
            <span>{options.direction === 'vertical' ? '纵向长图' : '横向长图'}</span>
          </div>
          {sources.length < 2 ? (
            <p className="collage-placeholder">再选一张照片，这里就会出现长图预览。</p>
          ) : (
            <div className="collage-preview-wrap">
              <canvas ref={previewRef} className="collage-preview long-preview"
                      aria-label="长图预览" />
            </div>
          )}
          {previewFailed && <p className="batch-error">{previewFailed}</p>}
        </section>

        <section className="batch-section" aria-labelledby="long-export-title">
          <div className="batch-section-head">
            <h2 id="long-export-title">导出</h2>
            <span>固定边决定成片清晰度</span>
          </div>
          <div className="collage-export">
            <div className="export-row" role="group" aria-label="长图格式">
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
            {lossy && (
              <label className="collage-quality">
                <span className="export-label">质量</span>
                <input type="range" min={60} max={100} step={1}
                       value={options.qualityPct} disabled={processing}
                       onChange={e => update({ qualityPct: Number(e.target.value) })} />
                <span className="collage-quality-value">{options.qualityPct}%</span>
              </label>
            )}
            <div className="export-row" role="group" aria-label="长图固定边">
              <span className="export-label">{options.direction === 'vertical' ? '宽度' : '高度'}</span>
              {EDGES.map(edge => (
                <button key={edge}
                        className={`crop-chip${options.fixedEdge === edge ? ' on' : ''}`}
                        aria-pressed={options.fixedEdge === edge}
                        disabled={processing}
                        onClick={() => update({ fixedEdge: edge })}>
                  {edge}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="batch-run" aria-label="长图操作">
          {error && <p className="batch-error" role="alert">{error}</p>}
          {result && (
            <div className="collage-result">
              <p>长图已下载：{result.filename}（{result.width}×{result.height}）</p>
              <button className="batch-download"
                      onClick={() => downloadFile(result.blob, result.filename)}>
                <Download size={15} strokeWidth={1.5} aria-hidden="true" />
                再下载一次
              </button>
            </div>
          )}
          <div className="batch-actions">
            <Btn className="batch-run-button"
                 disabled={files.length < 2 || sources.length < 2 || processing}
                 onClick={() => void download()}>
              <Download size={14} strokeWidth={1.5} aria-hidden="true" />
              {processing ? '正在拼…' : result ? '再拼一张' : '生成长图'}
            </Btn>
          </div>
        </section>
      </div>
    </section>
  )
}
