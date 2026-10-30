import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, ImagePlus, Play, Square, X } from 'lucide-react'
import {
  DEFAULT_LONG_EXPOSURE_OPTIONS, MAX_LONG_EXPOSURE_FILES, exportLongExposure,
  renderLongExposureCanvas, type LongExposureMode, type LongExposureOptions,
  type LongExposureProgress, type LongExposureSource,
} from '../image/longExposure'
import { downloadImage, type ExportFormat } from '../export/save'
import { Btn } from './kit/Btn.tsx'

type Picked = {
  id: string
  file: File
  preview: string
}

const FORMATS: [ExportFormat, string][] = [
  ['image/jpeg', 'JPG'], ['image/png', 'PNG'], ['image/webp', 'WebP'],
]

const MODES: [LongExposureMode, string][] = [
  ['trail', '车流光轨'], ['smooth', '流水丝滑'],
]

const HEIGHTS = [1200, 1600, 2000] as const

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

/**
 * 长曝光工作区（★ 2026-10-18）。
 * 和 HDR / 全景同一位置：作品页里的本地工作模式。2–8 张同机位照片，
 * 车流光轨取逐通道最亮值，流水丝滑取多帧平均；预览与成片共用同一个引擎。
 */
export default function LongExposurePanel({ onBack }: { onBack: () => void }) {
  const [files, setFiles] = useState<Picked[]>([])
  const [options, setOptions] = useState<LongExposureOptions>(DEFAULT_LONG_EXPOSURE_OPTIONS)
  const [processing, setProcessing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<LongExposureProgress | null>(null)
  const [previewFailed, setPreviewFailed] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    blob: Blob; filename: string; width: number; height: number
  } | null>(null)
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
        const sources: LongExposureSource[] = images.map(image => ({
          image, width: image.naturalWidth, height: image.naturalHeight,
        }))
        const rendered = renderLongExposureCanvas(sources, options, 480)
        const target = previewRef.current
        const ctx = target?.getContext('2d')
        if (!target || !ctx) return
        target.width = rendered.width
        target.height = rendered.height
        ctx.drawImage(rendered.canvas, 0, 0)
        setPreviewFailed(null)
      } catch (e) {
        if (alive) {
          console.error('长曝光预览没画出来', e)
          setPreviewFailed('预览没画出来，换一组同机位照片试试。')
        }
      }
    })()
    return () => { alive = false }
  }, [files, options.height, options.mode, options.align])

  function changed() {
    setResult(null)
    setError(null)
  }

  function addFiles(list: FileList | File[]) {
    if (processing) return
    const incoming = Array.from(list).filter(looksLikeImage)
    const room = Math.max(0, MAX_LONG_EXPOSURE_FILES - files.length)
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
      setError(`一次最多合成 ${MAX_LONG_EXPOSURE_FILES} 张，多出来的这次没收。`)
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

  function update(patch: Partial<LongExposureOptions>) {
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
      const made = await exportLongExposure(
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
        setError('已经停止，没有生成半张长曝光。')
      } else {
        console.error('长曝光没合成', e)
        setError(e instanceof Error ? `这张长曝光没合成：${e.message}` : '这张长曝光没合成，再试一次？')
      }
    } finally {
      if (mountedRef.current) setProcessing(false)
      controllerRef.current = null
    }
  }

  const done = progress?.completed ?? 0
  const total = progress?.total ?? files.length
  const lossy = options.format !== 'image/png'

  return (
    <section className="gallery batch-page long-exposure-page" aria-busy={processing}>
      <header className="gallery-head batch-head">
        <button className="batch-back" onClick={onBack} disabled={processing}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          作品
        </button>
        <div className="batch-heading">
          <h1 className="gallery-title">长曝光</h1>
          <p>把同一机位的多张照片合成光轨或丝滑流水，画面更有流动感。</p>
        </div>
      </header>

      <div className="batch-body">
        <section className="batch-section" aria-labelledby="long-photos-title">
          <div className="batch-section-head">
            <h2 id="long-photos-title">连续照片</h2>
            <span>{files.length} / {MAX_LONG_EXPOSURE_FILES}</span>
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
              aria-label="选择长曝光的连续照片"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <ImagePlus size={22} strokeWidth={1.5} aria-hidden="true" />
            <div className="batch-drop-copy">
              <strong>{files.length ? '继续加连续照片' : '先选两张同机位的照片'}</strong>
              <span>顺序不影响结果；机位越稳，光轨和背景越干净。</span>
            </div>
            <button className="batch-pick" onClick={() => inputRef.current?.click()}
                    disabled={processing || files.length >= MAX_LONG_EXPOSURE_FILES}>
              选照片
            </button>
          </div>

          {files.length > 0 && (
            <ul className="batch-files collage-files" aria-label="长曝光连续照片">
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

        <section className="batch-section" aria-labelledby="long-preview-title">
          <div className="batch-section-head">
            <h2 id="long-preview-title">预览</h2>
            <span>光轨累积亮线，丝滑把运动拉成柔顺轨迹</span>
          </div>
          {files.length < 2 ? (
            <p className="collage-placeholder">再选一张连续照片，这里就会出现长曝光预览。</p>
          ) : (
            <div className="collage-preview-wrap panorama-preview-wrap">
              <canvas ref={previewRef} className="collage-preview panorama-preview"
                      aria-label="长曝光预览" />
            </div>
          )}
          {previewFailed && <p className="batch-error">{previewFailed}</p>}
        </section>

        <section className="batch-section" aria-labelledby="long-mode-title">
          <div className="batch-section-head">
            <h2 id="long-mode-title">效果</h2>
            <span>车流、星轨用光轨；瀑布、海浪用丝滑</span>
          </div>
          <div className="collage-export">
            <div className="export-row" role="group" aria-label="长曝光效果">
              <span className="export-label">效果</span>
              {MODES.map(([value, label]) => (
                <button key={value} className={`crop-chip${options.mode === value ? ' on' : ''}`}
                        aria-pressed={options.mode === value} disabled={processing}
                        onClick={() => update({ mode: value })}>
                  {label}
                </button>
              ))}
            </div>
            <label className="batch-toggle">
              <input type="checkbox" checked={options.align} disabled={processing}
                     onChange={e => update({ align: e.target.checked })} />
              自动对齐轻微手抖
            </label>
            <p className="batch-hint">对齐只做平移。拍摄时主体变化太大，背景可能出现重影或空洞。</p>
          </div>
        </section>

        <section className="batch-section" aria-labelledby="long-export-title">
          <div className="batch-section-head">
            <h2 id="long-export-title">导出</h2>
            <span>高度决定成片清晰度，宽度按照片比例自动算</span>
          </div>
          <div className="collage-export">
            <div className="export-row" role="group" aria-label="长曝光格式">
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
            <div className="export-row" role="group" aria-label="长曝光高度">
              <span className="export-label">高度</span>
              {HEIGHTS.map(height => (
                <button key={height} className={`crop-chip${options.height === height ? ' on' : ''}`}
                        aria-pressed={options.height === height} disabled={processing}
                        onClick={() => update({ height })}>
                  {height}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="batch-run" aria-label="长曝光操作">
          {error && <p className="batch-error" role="alert">{error}</p>}
          {progress && (
            <div className="batch-progress" aria-live="polite">
              <div className="batch-progress-copy">
                <span>{processing ? '正在合成长曝光' : '这一次已经处理完'}</span>
                <span>{done} / {total}</span>
              </div>
              <progress value={done} max={Math.max(1, total)} aria-label="长曝光进度" />
              {processing && progress.currentName && (
                <p className="batch-current">{progress.currentName}</p>
              )}
            </div>
          )}
          {result && (
            <div className="collage-result">
              <p>长曝光已下载：{result.filename}（{result.width}×{result.height}）</p>
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
                {result ? '再合成一张' : '生成长曝光'}
              </Btn>
            )}
          </div>
        </section>
      </div>
    </section>
  )
}
