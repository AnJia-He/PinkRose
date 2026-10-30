import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, ImagePlus, X } from 'lucide-react'
import {
  ID_PHOTO_BACKGROUNDS, ID_PHOTO_SIZES,
  renderIdPhoto, type IdPhotoResult,
} from '../idphoto/idPhoto'
import { renderIdPhotoSheet } from '../idphoto/idPhotoSheet'
import { downloadImage } from '../export/save'

function looksLikeImage(file: File): boolean {
  return file.type.startsWith('image/')
    || /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(file.name)
}

/**
 * 证件照工作区：本地选一张照片，按标准尺寸做人脸取景、自动抠主体、
 * 换纯色底，实时预览后下载。全程不联网、不花模型额度。
 */
export default function IdPhotoPanel({ onBack }: { onBack: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [sizeId, setSizeId] = useState(ID_PHOTO_SIZES[0]!.id)
  const [backgroundId, setBackgroundId] = useState(ID_PHOTO_BACKGROUNDS[0]!.id)
  const [result, setResult] = useState<IdPhotoResult | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [sheetBusy, setSheetBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const previewRef = useRef<string | null>(null)
  const seqRef = useRef(0)

  const size = ID_PHOTO_SIZES.find(s => s.id === sizeId) ?? ID_PHOTO_SIZES[0]!
  const background = ID_PHOTO_BACKGROUNDS.find(b => b.id === backgroundId)
    ?? ID_PHOTO_BACKGROUNDS[0]!

  function clearPreview() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = null
    setPreview(null)
  }

  useEffect(() => () => {
    seqRef.current++
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = null
  }, [])

  useEffect(() => {
    if (!file) {
      clearPreview()
      setResult(null)
      setError(null)
      return
    }
    const seq = ++seqRef.current
    setProcessing(true)
    setError(null)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const made = await renderIdPhoto(file, size, background)
          if (seq !== seqRef.current) return
          const url = URL.createObjectURL(made.blob)
          if (previewRef.current) URL.revokeObjectURL(previewRef.current)
          previewRef.current = url
          setPreview(url)
          setResult(made)
        } catch (e) {
          if (seq !== seqRef.current) return
          console.error('证件照没生成', e)
          setResult(null)
          setError(e instanceof Error ? e.message : '这张证件照没生成，换一张试试。')
        } finally {
          if (seq === seqRef.current) setProcessing(false)
        }
      })()
    }, 180)
    return () => clearTimeout(timer)
  }, [file, size.id, background.id])

  function choose(next: File | undefined) {
    if (!next) return
    if (!looksLikeImage(next)) {
      setError('这个文件不是照片，换一张试试。')
      return
    }
    seqRef.current++
    clearPreview()
    setResult(null)
    setError(null)
    setFile(next)
  }

  function removeFile() {
    seqRef.current++
    clearPreview()
    setResult(null)
    setError(null)
    setFile(null)
  }

  async function downloadSheet() {
    if (!result || sheetBusy) return
    setSheetBusy(true)
    setError(null)
    try {
      const sheet = await renderIdPhotoSheet(result.blob)
      downloadImage(sheet.blob, result.filename.replace(/\.jpg$/i, '-排版8张.jpg'))
    } catch (e) {
      console.error('证件照排版没生成', e)
      setError(e instanceof Error ? `排版没生成：${e.message}` : '排版没生成，再试一次。')
    } finally {
      setSheetBusy(false)
    }
  }

  return (
    <section className="gallery batch-page id-photo-page" aria-busy={processing}>
      <header className="gallery-head batch-head">
        <button className="batch-back" onClick={onBack} disabled={processing}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          作品
        </button>
        <div className="batch-heading">
          <h1 className="gallery-title">证件照</h1>
          <p>标准尺寸、纯色底，全程本机完成。</p>
        </div>
      </header>

      <div className="batch-body">
        <section className="batch-section" aria-labelledby="id-photo-file-title">
          <div className="batch-section-head">
            <h2 id="id-photo-file-title">照片</h2>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,.heic,.heif"
            hidden
            onChange={e => {
              choose(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          {!file ? (
            <div
              className={`batch-drop${dragging ? ' over' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => {
                e.preventDefault()
                setDragging(false)
                choose(e.dataTransfer.files[0])
              }}
            >
              <ImagePlus size={22} strokeWidth={1.5} aria-hidden="true" />
              <p>先选一张正脸照片</p>
              <span>支持 JPG、PNG、WebP；背景越干净越容易换底。</span>
              <button className="crop-btn" onClick={() => inputRef.current?.click()}>
                选照片
              </button>
            </div>
          ) : (
            <div className="id-photo-file">
              <span>{file.name}</span>
              <button className="crop-btn" onClick={() => inputRef.current?.click()}>换一张</button>
              <button className="crop-btn" onClick={removeFile} aria-label="移除照片">
                <X size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
          )}
        </section>

        <section className="batch-section" aria-labelledby="id-photo-size-title">
          <div className="batch-section-head">
            <h2 id="id-photo-size-title">尺寸</h2>
            <span>{size.note}</span>
          </div>
          <div className="retouch-modes id-photo-options">
            {ID_PHOTO_SIZES.map(s => (
              <button
                key={s.id}
                type="button"
                className={`crop-chip${size.id === s.id ? ' on' : ''}`}
                aria-pressed={size.id === s.id}
                onClick={() => setSizeId(s.id)}
              >{s.label}</button>
            ))}
          </div>
        </section>

        <section className="batch-section" aria-labelledby="id-photo-bg-title">
          <div className="batch-section-head">
            <h2 id="id-photo-bg-title">底色</h2>
          </div>
          <div className="id-photo-swatches" role="group" aria-label="证件照底色">
            {ID_PHOTO_BACKGROUNDS.map(b => (
              <button
                key={b.id}
                type="button"
                className={`id-photo-swatch${background.id === b.id ? ' on' : ''}`}
                aria-pressed={background.id === b.id}
                onClick={() => setBackgroundId(b.id)}
              >
                <span className="id-photo-swatch-dot" style={{ background: b.color }} />
                {b.label}
              </button>
            ))}
          </div>
        </section>

        <section className="batch-section id-photo-result" aria-labelledby="id-photo-preview-title">
          <div className="batch-section-head">
            <h2 id="id-photo-preview-title">预览</h2>
            <span>{size.width} × {size.height}</span>
          </div>
          {processing && <p className="tool-note">正在裁切、抠主体、换底…</p>}
          {error && <p className="batch-error">{error}</p>}
          {!error && (preview ? (
            <img className="id-photo-preview" src={preview} alt="证件照预览"
              style={{ aspectRatio: `${size.width} / ${size.height}` }} />
          ) : (
            <p className="gallery-none">选一张照片后，这里会出现预览。</p>
          ))}
          <div className="crop-tools id-photo-actions">
            <button
              className="crop-btn"
              disabled={!result || processing || sheetBusy}
              onClick={() => void downloadSheet()}
            >{sheetBusy ? '正在排版…' : '排版 8 张'}</button>
            <button
              className="crop-btn btn-primary"
              disabled={!result || processing}
              onClick={() => result && downloadImage(result.blob, result.filename)}
            >
              <Download size={14} strokeWidth={1.5} aria-hidden="true" />
              下载证件照
            </button>
          </div>
        </section>
      </div>
    </section>
  )
}
