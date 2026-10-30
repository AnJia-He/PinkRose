import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, ImagePlus, Sparkles, X } from 'lucide-react'
import {
  encodeGifFromFiles, type GifFit,
} from '../gif/gif'
import { renderMotionMp4 } from '../gif/motion'
import { downloadImage } from '../export/save'
import { PHOTO_FILE_ACCEPT } from '../image/decode'
import { Btn } from './kit/Btn.tsx'

type Picked = { id: string; file: File; preview: string }

const MAX_FILES = 12
const ASPECTS = [
  { id: '1:1', label: '1:1 方形', ratio: 1 },
  { id: '4:5', label: '4:5 竖版', ratio: 4 / 5 },
  { id: '3:4', label: '3:4 竖版', ratio: 3 / 4 },
  { id: '9:16', label: '9:16 手机', ratio: 9 / 16 },
  { id: '16:9', label: '16:9 宽屏', ratio: 16 / 9 },
] as const

const WIDTHS = [480, 720, 1080] as const
const DURATIONS = [
  { ms: 400, label: '0.4 秒 / 张' },
  { ms: 800, label: '0.8 秒 / 张' },
  { ms: 1200, label: '1.2 秒 / 张' },
  { ms: 2000, label: '2 秒 / 张' },
] as const

function looksLikeImage(file: File): boolean {
  return file.type.startsWith('image/')
    || /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp|tiff?|dng|cr2|cr3|nef|arw|raf|orf|rw2)$/i.test(file.name)
}

function previewOf(file: File): string {
  try { return URL.createObjectURL(file) } catch { return '' }
}

function stamp(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
}

export default function GifPanel({ onBack }: { onBack: () => void }) {
  const [files, setFiles] = useState<Picked[]>([])
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]['id']>('1:1')
  const [width, setWidth] = useState<(typeof WIDTHS)[number]>(720)
  const [duration, setDuration] = useState(800)
  const [fit, setFit] = useState<GifFit>('cover')
  const [background, setBackground] = useState('#ffffff')
  const [loop, setLoop] = useState(true)
  const [preview, setPreview] = useState<{
    url: string; blob: Blob; filename: string; width: number; height: number
  } | null>(null)
  const [generating, setGenerating] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [exportingMp4, setExportingMp4] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const idRef = useRef(0)
  const previewRef = useRef<string | null>(null)
  const fileUrlsRef = useRef<string[]>([])
  const aspectRatio = ASPECTS.find(a => a.id === aspect)?.ratio ?? 1
  const height = Math.max(64, Math.round(width / aspectRatio))
  const totalSeconds = (files.length * duration) / 1000

  function clearPreview() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = null
    setPreview(null)
    setError(null)
  }

  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    for (const url of fileUrlsRef.current) URL.revokeObjectURL(url)
    fileUrlsRef.current = []
  }, [])

  function addFiles(list: FileList | File[]) {
    if (generating) return
    const incoming = Array.from(list).filter(looksLikeImage)
    const room = Math.max(0, MAX_FILES - files.length)
    const accepted = incoming.slice(0, room).map(file => ({
      id: `gif-${Date.now()}-${++idRef.current}`,
      file,
      preview: previewOf(file),
    }))
    for (const item of accepted) {
      if (item.preview) fileUrlsRef.current.push(item.preview)
    }
    setFiles(prev => [...prev, ...accepted])
    clearPreview()
    setError(incoming.length > room
      ? `一次最多 ${MAX_FILES} 张，多出来的这次没收。`
      : incoming.length === 0 && list.length > 0 ? '这些文件不是照片，换一批试试。' : null)
  }

  function removeFile(id: string) {
    const hit = files.find(f => f.id === id)
    if (hit?.preview) {
      URL.revokeObjectURL(hit.preview)
      fileUrlsRef.current = fileUrlsRef.current.filter(url => url !== hit.preview)
    }
    setFiles(prev => prev.filter(f => f.id !== id))
    clearPreview()
  }

  async function generate() {
    if (files.length < 2 || generating) return
    setGenerating(true)
    setError(null)
    clearPreview()
    try {
      const blob = await encodeGifFromFiles(files.map(f => f.file), {
        width,
        height,
        delayMs: duration,
        fit,
        background,
        loop,
      })
      const url = URL.createObjectURL(blob)
      previewRef.current = url
      setPreview({
        url, blob, width, height,
        filename: `PinkRose-motion-${stamp()}.gif`,
      })
    } catch (e) {
      console.error('照片动图没生成', e)
      setError(e instanceof Error ? `照片动图没生成：${e.message}` : '照片动图没生成，再试一次。')
    } finally {
      setGenerating(false)
    }
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

  async function downloadMp4() {
    if (files.length < 2 || exportingMp4) return
    setExportingMp4(true)
    setError(null)
    try {
      const blob = await renderMotionMp4(files.map(f => f.file), {
        width,
        height,
        delayMs: duration,
        fit,
        background,
      })
      downloadImage(blob, `PinkRose-motion-${stamp()}.mp4`)
    } catch (e) {
      console.error('照片视频没生成', e)
      setError(e instanceof Error ? e.message : '照片视频没生成，再试一次。')
    } finally {
      setExportingMp4(false)
    }
  }

  return (
    <section className="gallery batch-page gif-page" aria-busy={generating || downloading || exportingMp4}>
      <header className="gallery-head batch-head">
        <button className="batch-back" onClick={onBack} disabled={generating || downloading || exportingMp4}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          作品
        </button>
        <div className="batch-heading">
          <h1 className="gallery-title">照片动图</h1>
          <p>把 2–12 张照片做成循环 GIF，直接发聊天、朋友圈或保存成表情。</p>
        </div>
      </header>

      <div className="batch-body">
        <section className="batch-section" aria-labelledby="gif-files-title">
          <div className="batch-section-head">
            <h2 id="gif-files-title">照片</h2>
            <span>{files.length} / {MAX_FILES}</span>
          </div>
          <div
            className={`batch-drop${dragging ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
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
              accept={PHOTO_FILE_ACCEPT}
              multiple
              aria-label="选择要做成动图的照片"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <ImagePlus size={22} strokeWidth={1.5} aria-hidden="true" />
            <div className="batch-drop-copy">
              <strong>{files.length ? '再加几张' : '把照片选进来'}</strong>
              <span>按选择顺序播放；支持 JPG、PNG、WebP、HEIC / HEIF。</span>
            </div>
            <button className="batch-pick" onClick={() => inputRef.current?.click()}
              disabled={generating || exportingMp4 || files.length >= MAX_FILES}>
              选照片
            </button>
          </div>
          {files.length > 0 && (
            <ul className="batch-files" aria-label="已选动图照片">
              {files.map((item, index) => (
                <li key={item.id} className="batch-file-row gif-file-row">
                  <span className="gif-thumb-wrap">
                    <span className="gif-order">{index + 1}</span>
                    {item.preview
                      ? <img className="batch-thumb" src={item.preview} alt="" />
                      : <span className="batch-thumb batch-thumb-empty" aria-hidden="true" />}
                  </span>
                  <span className="batch-file-name" title={item.file.name}>{item.file.name}</span>
                  <button className="batch-remove" aria-label={`移除 ${item.file.name}`}
                    disabled={generating || exportingMp4} onClick={() => removeFile(item.id)}>
                    <X size={15} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="batch-section" aria-labelledby="gif-options-title">
          <div className="batch-section-head">
            <h2 id="gif-options-title">动图设置</h2>
            <span>约 {totalSeconds.toFixed(1)} 秒 · {files.length} 帧</span>
          </div>
          <label className="batch-preset">
            <span>画幅</span>
            <select value={aspect} onChange={e => { setAspect(e.target.value as typeof aspect); clearPreview() }}>
              {ASPECTS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
          <label className="batch-preset">
            <span>尺寸</span>
            <select value={width} onChange={e => { setWidth(Number(e.target.value) as typeof width); clearPreview() }}>
              {WIDTHS.map(w => <option key={w} value={w}>{w}px</option>)}
            </select>
          </label>
          <label className="batch-preset">
            <span>停留</span>
            <select value={duration} onChange={e => { setDuration(Number(e.target.value)); clearPreview() }}>
              {DURATIONS.map(d => <option key={d.ms} value={d.ms}>{d.label}</option>)}
            </select>
          </label>
          <div className="retouch-modes print-options" role="group" aria-label="动图画幅填充">
            <button type="button" className={`crop-chip${fit === 'cover' ? ' on' : ''}`}
              aria-pressed={fit === 'cover'} onClick={() => { setFit('cover'); clearPreview() }}>
              填满裁切
            </button>
            <button type="button" className={`crop-chip${fit === 'contain' ? ' on' : ''}`}
              aria-pressed={fit === 'contain'} onClick={() => { setFit('contain'); clearPreview() }}>
              完整留白
            </button>
          </div>
          {fit === 'contain' && (
            <label className="batch-preset">
              <span>留白</span>
              <input type="color" className="batch-color-input" value={background}
                aria-label="动图留白颜色"
                onChange={e => { setBackground(e.target.value); clearPreview() }} />
            </label>
          )}
          <label className="batch-toggle">
            <input type="checkbox" checked={loop}
              onChange={e => { setLoop(e.target.checked); clearPreview() }} />
            <span>循环播放</span>
          </label>
          <p className="batch-hint">
            GIF 使用 256 色全局调色板；照片感强、颜色多的题材会有轻微色彩断层，
            适合聊天表情和轻量分享。
          </p>
        </section>

        <section className="batch-section" aria-labelledby="gif-preview-title">
          <div className="batch-section-head">
            <h2 id="gif-preview-title">预览</h2>
            <span>{width} × {height} · GIF</span>
          </div>
          {error && <p className="batch-error" role="alert">{error}</p>}
          {generating && <p className="tool-note">正在合成动图…</p>}
          {!error && (preview ? (
            <img className="gif-preview" src={preview.url} alt="照片动图预览" />
          ) : (
            <p className="gallery-none">至少选 2 张照片，再点「生成动图」。</p>
          ))}
          <div className="crop-tools print-actions">
            <Btn className="crop-done" disabled={files.length < 2 || generating || exportingMp4}
              onClick={() => void generate()}>
              <Sparkles size={14} strokeWidth={1.5} aria-hidden="true" />
              {generating ? '正在生成…' : '生成动图'}
            </Btn>
            <button className="crop-btn" disabled={!preview || downloading || exportingMp4}
              onClick={download}>
              <Download size={14} strokeWidth={1.5} aria-hidden="true" />
              下载 GIF
            </button>
            <button className="crop-btn" disabled={files.length < 2 || exportingMp4 || generating}
              onClick={() => void downloadMp4()}>
              <Download size={14} strokeWidth={1.5} aria-hidden="true" />
              {exportingMp4 ? '正在编码 MP4…' : '导出 MP4'}
            </button>
          </div>
          <p className="batch-hint">
            MP4 需要本机 Node 服务与 ffmpeg；画质和平台兼容性比 GIF 好，苹果端可直接下载。
          </p>
        </section>
      </div>
    </section>
  )
}
