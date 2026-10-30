import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, ImagePlus, Play, Square, X } from 'lucide-react'
import {
  DEFAULT_HDR_OPTIONS, MAX_HDR_FILES, exportHdrMerge, renderHdrMergeCanvas,
  type HdrOptions, type HdrProgress, type HdrSource, type HdrStyle,
} from '../image/hdrMerge'
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

const STYLES: [HdrStyle, string][] = [
  ['natural', '自然'], ['vivid', '鲜明'], ['dramatic', '戏剧'],
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
 * HDR 合成（★ 2026-10-18）。和全景同一个位置：作品页里的本地工作模式。
 * 选同一场景的 2–5 张不同曝光照片，本机做曝光融合；预览和成片共用
 * `renderHdrMergeCanvas`，风格、对齐和输出尺寸不会两套。
 */
export default function HdrPanel({
  onBack, initialFiles,
}: { onBack: () => void; initialFiles?: File[] }) {
  const [files, setFiles] = useState<Picked[]>([])
  const [options, setOptions] = useState<HdrOptions>(DEFAULT_HDR_OPTIONS)
  const [processing, setProcessing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<HdrProgress | null>(null)
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
  const seededRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
      queueMicrotask(() => {
        if (mountedRef.current) return
        for (const url of previewsRef.current) URL.revokeObjectURL(url)
        previewsRef.current = []
      })
    }
  }, [])

  useEffect(() => {
    if (seededRef.current || !initialFiles?.length) return
    seededRef.current = true
    const incoming = initialFiles.filter(looksLikeImage)
    const accepted = incoming.slice(0, MAX_HDR_FILES).map(file => {
      const preview = previewOf(file)
      if (preview) previewsRef.current.push(preview)
      return {
        id: `hdr-${Date.now()}-${++idRef.current}`,
        file,
        preview,
      }
    })
    setFiles(accepted)
    if (incoming.length > MAX_HDR_FILES) {
      setError(`一次最多合成 ${MAX_HDR_FILES} 张，多出来的这次没收。`)
    }
  }, [initialFiles])

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
        const sources: HdrSource[] = images.map(image => ({
          image, width: image.naturalWidth, height: image.naturalHeight,
        }))
        const rendered = renderHdrMergeCanvas(sources, options, 480)
        const target = previewRef.current
        const ctx = target?.getContext('2d')
        if (!target || !ctx) return
        target.width = rendered.width
        target.height = rendered.height
        ctx.drawImage(rendered.canvas, 0, 0)
        setPreviewFailed(null)
      } catch (e) {
        if (alive) {
          console.error('HDR 预览没画出来', e)
          setPreviewFailed('预览没画出来，换一组曝光照片试试。')
        }
      }
    })()
    return () => { alive = false }
  }, [files, options.height, options.style, options.align])

  function changed() {
    setResult(null)
    setError(null)
  }

  function addFiles(list: FileList | File[]) {
    if (processing) return
    const incoming = Array.from(list).filter(looksLikeImage)
    const room = Math.max(0, MAX_HDR_FILES - files.length)
    const accepted = incoming.slice(0, room).map(file => ({
      id: `hdr-${Date.now()}-${++idRef.current}`,
      file,
      preview: previewOf(file),
    }))
    for (const item of accepted) {
      if (item.preview) previewsRef.current.push(item.preview)
    }
    setFiles(prev => [...prev, ...accepted])
    changed()
    if (incoming.length > room) {
      setError(`一次最多合成 ${MAX_HDR_FILES} 张，多出来的这次没收。`)
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

  function update(patch: Partial<HdrOptions>) {
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
      const made = await exportHdrMerge(
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
        setError('已经停止，没有生成半张 HDR。')
      } else {
        console.error('HDR 没合成', e)
        setError(e instanceof Error ? `这张 HDR 没合成：${e.message}` : '这张 HDR 没合成，再试一次？')
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
    <section className="gallery batch-page hdr-page" aria-busy={processing}>
      <header className="gallery-head batch-head">
        <button className="batch-back" onClick={onBack} disabled={processing}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          作品
        </button>
        <div className="batch-heading">
          <h1 className="gallery-title">HDR 合成</h1>
          <p>把同一场景的几张不同曝光照片合成一张，暗部和亮部都保住。</p>
        </div>
      </header>

      <div className="batch-body">
        <section className="batch-section" aria-labelledby="hdr-photos-title">
          <div className="batch-section-head">
            <h2 id="hdr-photos-title">曝光照片</h2>
            <span>{files.length} / {MAX_HDR_FILES}</span>
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
              aria-label="选择要合成的曝光照片"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <ImagePlus size={22} strokeWidth={1.5} aria-hidden="true" />
            <div className="batch-drop-copy">
              <strong>{files.length ? '继续加曝光照片' : '先选两张不同曝光的照片'}</strong>
              <span>同一场景、机位尽量不动；顺序不影响结果。</span>
            </div>
            <button className="batch-pick" onClick={() => inputRef.current?.click()}
                    disabled={processing || files.length >= MAX_HDR_FILES}>
              选照片
            </button>
          </div>

          {files.length > 0 && (
            <ul className="batch-files collage-files" aria-label="HDR 曝光照片">
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

        <section className="batch-section" aria-labelledby="hdr-preview-title">
          <div className="batch-section-head">
            <h2 id="hdr-preview-title">预览</h2>
            <span>亮曝光补暗部，暗曝光保高光</span>
          </div>
          {files.length < 2 ? (
            <p className="collage-placeholder">再选一张曝光照片，这里就会出现 HDR 预览。</p>
          ) : (
            <div className="collage-preview-wrap panorama-preview-wrap">
              <canvas ref={previewRef} className="collage-preview panorama-preview"
                      aria-label="HDR 预览" />
            </div>
          )}
          {previewFailed && <p className="batch-error">{previewFailed}</p>}
        </section>

        <section className="batch-section" aria-labelledby="hdr-style-title">
          <div className="batch-section-head">
            <h2 id="hdr-style-title">风格</h2>
            <span>自然最稳，戏剧反差最大</span>
          </div>
          <div className="collage-export">
            <div className="export-row" role="group" aria-label="HDR 风格">
              <span className="export-label">风格</span>
              {STYLES.map(([value, label]) => (
                <button key={value} className={`crop-chip${options.style === value ? ' on' : ''}`}
                        aria-pressed={options.style === value} disabled={processing}
                        onClick={() => update({ style: value })}>
                  {label}
                </button>
              ))}
            </div>
            <label className="batch-toggle">
              <input type="checkbox" checked={options.align} disabled={processing}
                     onChange={e => update({ align: e.target.checked })} />
              自动对齐轻微手抖
            </label>
            <p className="batch-hint">对齐只做平移；拍摄时人物或树枝动得太多，合成可能出现重影。</p>
          </div>
        </section>

        <section className="batch-section" aria-labelledby="hdr-export-title">
          <div className="batch-section-head">
            <h2 id="hdr-export-title">导出</h2>
            <span>高度决定成片清晰度，宽度按照片比例自动算</span>
          </div>
          <div className="collage-export">
            <div className="export-row" role="group" aria-label="HDR 格式">
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
            <div className="export-row" role="group" aria-label="HDR 高度">
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

        <section className="batch-run" aria-label="HDR 操作">
          {error && <p className="batch-error" role="alert">{error}</p>}
          {progress && (
            <div className="batch-progress" aria-live="polite">
              <div className="batch-progress-copy">
                <span>{processing ? '正在合成 HDR' : '这一次已经处理完'}</span>
                <span>{done} / {total}</span>
              </div>
              <progress value={done} max={Math.max(1, total)} aria-label="HDR 进度" />
              {processing && progress.currentName && (
                <p className="batch-current">{progress.currentName}</p>
              )}
            </div>
          )}
          {result && (
            <div className="collage-result">
              <p>HDR 已下载：{result.filename}（{result.width}×{result.height}）</p>
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
                {result ? '再合成一张' : '生成 HDR'}
              </Btn>
            )}
          </div>
        </section>
      </div>
    </section>
  )
}
