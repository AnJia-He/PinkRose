import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, ImagePlus, X } from 'lucide-react'
import {
  DEFAULT_POSTER, POSTER_TEMPLATES, renderPoster,
  type PosterOptions,
} from '../poster/poster'
import { downloadImage } from '../export/save'
import { PHOTO_FILE_ACCEPT } from '../image/decode'
import { Btn } from './kit/Btn.tsx'

function previewOf(file: File): string {
  try { return URL.createObjectURL(file) } catch { return '' }
}

export default function PosterPanel({ onBack }: { onBack: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [thumb, setThumb] = useState<string>('')
  const [options, setOptions] = useState<PosterOptions>({ ...DEFAULT_POSTER })
  const [format, setFormat] = useState<'image/jpeg' | 'image/png'>('image/jpeg')
  const [preview, setPreview] = useState<{
    url: string; blob: Blob; filename: string
  } | null>(null)
  const [generating, setGenerating] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previewRef = useRef<string | null>(null)
  const thumbRef = useRef<string | null>(null)
  const seqRef = useRef(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  function clearPreview() {
    seqRef.current++
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = null
    setPreview(null)
  }

  useEffect(() => () => {
    seqRef.current++
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    if (thumbRef.current) URL.revokeObjectURL(thumbRef.current)
  }, [])

  useEffect(() => {
    clearPreview()
    setError(null)
    if (!file) return
    const seq = ++seqRef.current
    setGenerating(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const made = await renderPoster(file, { ...options, format })
          if (seq !== seqRef.current) return
          const url = URL.createObjectURL(made.blob)
          previewRef.current = url
          setPreview({ url, blob: made.blob, filename: made.filename })
        } catch (e) {
          if (seq !== seqRef.current) return
          console.error('海报预览没生成', e)
          setError(e instanceof Error ? `海报没生成：${e.message}` : '海报没生成，再试一次。')
        } finally {
          if (seq === seqRef.current) setGenerating(false)
        }
      })()
    }, 150)
    return () => clearTimeout(timer)
  }, [file, options, format])

  function choose(next: File | undefined) {
    if (!next) return
    if (thumbRef.current) URL.revokeObjectURL(thumbRef.current)
    const url = previewOf(next)
    thumbRef.current = url || null
    setThumb(url)
    setFile(next)
  }

  function clearFile() {
    if (thumbRef.current) URL.revokeObjectURL(thumbRef.current)
    thumbRef.current = null
    setThumb('')
    setFile(null)
    clearPreview()
  }

  function patch(next: Partial<PosterOptions>) {
    setOptions(prev => ({ ...prev, ...next }))
  }

  function download() {
    if (!preview || downloading) return
    setDownloading(true)
    try {
      downloadImage(preview.blob, preview.filename)
    } finally {
      setDownloading(false)
    }
  }

  const template = POSTER_TEMPLATES.find(t => t.id === options.template) ?? POSTER_TEMPLATES[0]!

  return (
    <section className="gallery batch-page poster-page" aria-busy={generating || downloading}>
      <header className="gallery-head batch-head">
        <button className="batch-back" onClick={onBack} disabled={generating || downloading}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          作品
        </button>
        <div className="batch-heading">
          <h1 className="gallery-title">社交封面</h1>
          <p>一张照片 + 标题，直接做成小红书 / 朋友圈 / 故事封面。</p>
        </div>
      </header>

      <div className="batch-body">
        <section className="batch-section" aria-labelledby="poster-photo-title">
          <div className="batch-section-head">
            <h2 id="poster-photo-title">照片</h2>
            <span>{template.width} × {template.height}</span>
          </div>
          <div className="batch-drop">
            <input
              ref={inputRef}
              className="batch-file-input"
              type="file"
              accept={PHOTO_FILE_ACCEPT}
              aria-label="选择一张照片做海报"
              onChange={(e) => {
                choose(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            {thumb ? (
              <img className="batch-thumb poster-thumb" src={thumb} alt="" />
            ) : (
              <ImagePlus size={22} strokeWidth={1.5} aria-hidden="true" />
            )}
            <div className="batch-drop-copy">
              <strong>{file ? file.name : '选一张照片'}</strong>
              <span>支持 JPG、PNG、WebP、HEIC / HEIF。</span>
            </div>
            <button className="batch-pick" onClick={() => inputRef.current?.click()}>
              {file ? '换一张' : '选照片'}
            </button>
            {file && (
              <button className="batch-remove" aria-label="移除照片" onClick={clearFile}>
                <X size={15} strokeWidth={1.5} aria-hidden="true" />
              </button>
            )}
          </div>
        </section>

        <section className="batch-section" aria-labelledby="poster-options-title">
          <div className="batch-section-head">
            <h2 id="poster-options-title">版式</h2>
            <span>{template.note}</span>
          </div>
          <div className="retouch-modes print-options" role="group" aria-label="海报版式">
            {POSTER_TEMPLATES.map(t => (
              <button
                key={t.id}
                type="button"
                className={`crop-chip${options.template === t.id ? ' on' : ''}`}
                aria-pressed={options.template === t.id}
                onClick={() => patch({ template: t.id })}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="poster-fields">
            <label className="poster-field">
              <span>标题</span>
              <input value={options.title} maxLength={60}
                onChange={e => patch({ title: e.target.value })} />
            </label>
            <label className="poster-field">
              <span>副标题</span>
              <input value={options.subtitle} maxLength={80}
                onChange={e => patch({ subtitle: e.target.value })} />
            </label>
            <label className="poster-field">
              <span>日期</span>
              <input value={options.date} maxLength={24} placeholder="可留空"
                onChange={e => patch({ date: e.target.value })} />
            </label>
            <label className="poster-field">
              <span>强调色</span>
              <input type="color" value={options.accent}
                onChange={e => patch({ accent: e.target.value })} />
            </label>
            <label className="poster-field">
              <span>文字色</span>
              <input type="color" value={options.textColor}
                onChange={e => patch({ textColor: e.target.value })} />
            </label>
            <label className="poster-field">
              <span>底色</span>
              <input type="color" value={options.background}
                onChange={e => patch({ background: e.target.value })} />
            </label>
            <label className="poster-field">
              <span>格式</span>
              <select value={format} onChange={e => setFormat(e.target.value as typeof format)}>
                <option value="image/jpeg">JPG</option>
                <option value="image/png">PNG</option>
              </select>
            </label>
          </div>
          <p className="batch-hint">
            底色只影响「朋友圈 / 杂志留白」；标题超过一行会自动折行。
          </p>
        </section>

        <section className="batch-section" aria-labelledby="poster-preview-title">
          <div className="batch-section-head">
            <h2 id="poster-preview-title">预览</h2>
            <span>{template.width} × {template.height}</span>
          </div>
          {error && <p className="batch-error" role="alert">{error}</p>}
          {generating && <p className="tool-note">正在生成海报…</p>}
          {!error && (preview ? (
            <img className="poster-preview" src={preview.url} alt="海报预览" />
          ) : (
            <p className="gallery-none">选一张照片后，这里会出现封面预览。</p>
          ))}
          <div className="crop-tools print-actions">
            <Btn className="crop-done" disabled={!preview || generating || downloading}
              onClick={download}>
              <Download size={14} strokeWidth={1.5} aria-hidden="true" />
              下载海报
            </Btn>
          </div>
        </section>
      </div>
    </section>
  )
}
