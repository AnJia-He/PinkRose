import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, ImagePlus, X } from 'lucide-react'
import {
  orientTemplate, PRINT_MAX_FILES, PRINT_TEMPLATES, renderPrintSheet, templateById,
  type PrintFit, type PrintOrientation, type PrintTemplateId,
} from '../print/printSheet'
import { downloadImage } from '../export/save'
import { Slider } from './kit/Slider.tsx'
import { jpegToPdf } from '../print/pdf'

type Picked = { id: string; file: File; preview: string }

function looksLikeImage(file: File): boolean {
  return file.type.startsWith('image/')
    || /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(file.name)
}

function previewOf(file: File): string {
  try { return URL.createObjectURL(file) } catch { return '' }
}

export default function PrintPanel({ onBack }: { onBack: () => void }) {
  const [files, setFiles] = useState<Picked[]>([])
  const [templateId, setTemplateId] = useState<PrintTemplateId>('6x4-8')
  const [orientation, setOrientation] = useState<PrintOrientation>('auto')
  const [fit, setFit] = useState<PrintFit>('cover')
  const [cutLines, setCutLines] = useState(true)
  const [marginPct, setMarginPct] = useState(3.5)
  const [gapPct, setGapPct] = useState(1.8)
  const [customWidthMm, setCustomWidthMm] = useState(152)
  const [customHeightMm, setCustomHeightMm] = useState(102)
  const [customCols, setCustomCols] = useState(2)
  const [customRows, setCustomRows] = useState(2)
  /** null = 按顺序循环铺；数组 = 每格指定第几张照片。 */
  const [order, setOrder] = useState<number[] | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const idRef = useRef(0)
  const seqRef = useRef(0)
  const previewRef = useRef<string | null>(null)
  const fileUrlsRef = useRef<string[]>([])
  const customW = Number.isFinite(customWidthMm) ? Math.max(50, Math.min(500, customWidthMm)) : 152
  const customH = Number.isFinite(customHeightMm) ? Math.max(50, Math.min(500, customHeightMm)) : 102
  const customC = Number.isFinite(customCols) ? Math.max(1, Math.min(4, Math.round(customCols))) : 2
  const customR = Number.isFinite(customRows) ? Math.max(1, Math.min(4, Math.round(customRows))) : 2
  const customTemplate = templateId === 'custom'
    ? {
      id: 'custom' as const,
      label: `自定义 ${customW}×${customH}mm`,
      width: Math.round(customW / 25.4 * 300),
      height: Math.round(customH / 25.4 * 300),
      cols: customC,
      rows: customR,
      note: `${customC} × ${customR}，自定义相纸`,
    }
    : null
  const template = orientTemplate(customTemplate ?? templateById(templateId), orientation)
  const cellCount = template.cols * template.rows
  const effectiveOrder = order && order.length === cellCount
    ? order.map(i => (Number.isInteger(i) && i >= 0 && i < files.length ? i : 0))
    : Array.from({ length: cellCount }, (_, i) => i % Math.max(1, files.length))

  function clearPreview() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = null
    setPreview(null)
  }

  useEffect(() => () => {
    seqRef.current++
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    for (const url of fileUrlsRef.current) URL.revokeObjectURL(url)
    fileUrlsRef.current = []
  }, [])

  useEffect(() => {
    clearPreview()
    setError(null)
    if (files.length === 0) return
    const seq = ++seqRef.current
    setPreviewing(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const made = await renderPrintSheet(
            files.map(f => f.file), templateId, fit, cutLines, 900,
            { order: effectiveOrder, marginPct, gapPct },
            orientation,
            customTemplate,
          )
          if (seq !== seqRef.current) return
          const url = URL.createObjectURL(made.blob)
          previewRef.current = url
          setPreview(url)
        } catch (e) {
          if (seq !== seqRef.current) return
          console.error('打印排版预览没生成', e)
          setError(e instanceof Error ? e.message : '排版预览没生成，再试一次。')
        } finally {
          if (seq === seqRef.current) setPreviewing(false)
        }
      })()
    }, 150)
    return () => clearTimeout(timer)
  }, [
    files, templateId, fit, cutLines, order, marginPct, gapPct, cellCount, orientation,
    customW, customH, customC, customR,
  ])

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list).filter(looksLikeImage)
    const room = Math.max(0, PRINT_MAX_FILES - files.length)
    const accepted = incoming.slice(0, room).map(file => ({
      id: `print-${Date.now()}-${++idRef.current}`,
      file,
      preview: previewOf(file),
    }))
    for (const item of accepted) {
      if (item.preview) fileUrlsRef.current.push(item.preview)
    }
    setFiles(prev => [...prev, ...accepted])
    setOrder(null)
    setError(incoming.length > room
      ? `一次最多放 ${PRINT_MAX_FILES} 张，多出来的这次没收。`
      : incoming.length === 0 && list.length > 0 ? '这些文件不是照片，换一批试试。' : null)
  }

  function removeFile(id: string) {
    const hit = files.find(f => f.id === id)
    if (hit?.preview) {
      URL.revokeObjectURL(hit.preview)
      fileUrlsRef.current = fileUrlsRef.current.filter(url => url !== hit.preview)
    }
    setFiles(prev => prev.filter(f => f.id !== id))
    setOrder(null)
  }

  async function downloadSheet() {
    if (!files.length || downloading) return
    setDownloading(true)
    setError(null)
    try {
      const made = await renderPrintSheet(
        files.map(f => f.file), templateId, fit, cutLines, undefined,
        { order: effectiveOrder, marginPct, gapPct },
        orientation,
        customTemplate,
      )
      downloadImage(made.blob, made.filename)
    } catch (e) {
      console.error('打印排版没生成', e)
      setError(e instanceof Error ? `排版没生成：${e.message}` : '排版没生成，再试一次。')
    } finally {
      setDownloading(false)
    }
  }

  async function downloadPdf() {
    if (!files.length || downloadingPdf) return
    setDownloadingPdf(true)
    setError(null)
    try {
      const made = await renderPrintSheet(
        files.map(f => f.file), templateId, fit, cutLines, undefined,
        { order: effectiveOrder, marginPct, gapPct },
        orientation,
        customTemplate,
      )
      const jpeg = new Uint8Array(await made.blob.arrayBuffer())
      const pdf = jpegToPdf(jpeg, made.width, made.height, 300)
      downloadImage(
        new Blob([pdf.buffer as ArrayBuffer], { type: 'application/pdf' }),
        made.filename.replace(/\.jpg$/i, '.pdf'),
      )
    } catch (e) {
      console.error('打印 PDF 没生成', e)
      setError(e instanceof Error ? `PDF 没生成：${e.message}` : 'PDF 没生成，再试一次。')
    } finally {
      setDownloadingPdf(false)
    }
  }

  return (
    <section className="gallery batch-page print-page" aria-busy={previewing || downloading || downloadingPdf}>
      <header className="gallery-head batch-head">
        <button className="batch-back" onClick={onBack} disabled={downloading || downloadingPdf}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          作品
        </button>
        <div className="batch-heading">
          <h1 className="gallery-title">打印排版</h1>
          <p>把多张照片排进 6 寸 / 5×7 / A4 / A5 相纸，下载 300dpi JPG 或 PDF。</p>
        </div>
      </header>

      <div className="batch-body">
        <section className="batch-section" aria-labelledby="print-files-title">
          <div className="batch-section-head">
            <h2 id="print-files-title">照片</h2>
            <span>{files.length} / {PRINT_MAX_FILES}</span>
          </div>
          <div
            className={`batch-drop${dragging ? ' over' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
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
              aria-label="选择要打印排版的照片"
              onChange={e => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <ImagePlus size={22} strokeWidth={1.5} aria-hidden="true" />
            <div className="batch-drop-copy">
              <strong>{files.length ? '再加几张' : '把照片选进来'}</strong>
              <span>一张照片会排满整版；多张按顺序循环铺格。</span>
            </div>
            <button
              className="batch-pick"
              onClick={() => inputRef.current?.click()}
              disabled={files.length >= PRINT_MAX_FILES}
            >选照片</button>
          </div>
          {files.length > 0 && (
            <ul className="batch-files" aria-label="已选打印照片">
              {files.map(item => (
                <li key={item.id} className="batch-file-row">
                  {item.preview
                    ? <img className="batch-thumb" src={item.preview} alt="" />
                    : <span className="batch-thumb batch-thumb-empty" aria-hidden="true" />}
                  <span className="batch-file-name" title={item.file.name}>{item.file.name}</span>
                  <button className="batch-remove" aria-label={`移除 ${item.file.name}`}
                    onClick={() => removeFile(item.id)}>
                    <X size={15} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="batch-section" aria-labelledby="print-template-title">
          <div className="batch-section-head">
            <h2 id="print-template-title">版式</h2>
            <span>{template.note}</span>
          </div>
          <label className="batch-preset">
            <span>模板</span>
            <select value={templateId}
              onChange={e => setTemplateId(e.target.value as PrintTemplateId)}>
              {PRINT_TEMPLATES.map(t => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </label>
          <label className="batch-preset">
            <span>方向</span>
            <select value={orientation}
              onChange={e => setOrientation(e.target.value as PrintOrientation)}>
              <option value="auto">模板默认</option>
              <option value="landscape">横版</option>
              <option value="portrait">竖版</option>
            </select>
          </label>
          {templateId === 'custom' && (
            <div className="poster-fields print-custom-fields">
              <label className="poster-field">
                <span>宽（mm）</span>
                <input type="number" min={50} max={500} value={customWidthMm}
                  onChange={e => setCustomWidthMm(Number(e.target.value))} />
              </label>
              <label className="poster-field">
                <span>高（mm）</span>
                <input type="number" min={50} max={500} value={customHeightMm}
                  onChange={e => setCustomHeightMm(Number(e.target.value))} />
              </label>
              <label className="poster-field">
                <span>列</span>
                <input type="number" min={1} max={4} value={customCols}
                  onChange={e => setCustomCols(Number(e.target.value))} />
              </label>
              <label className="poster-field">
                <span>行</span>
                <input type="number" min={1} max={4} value={customRows}
                  onChange={e => setCustomRows(Number(e.target.value))} />
              </label>
            </div>
          )}
          <div className="retouch-modes print-options">
            <button type="button"
              className={`crop-chip${fit === 'cover' ? ' on' : ''}`}
              aria-pressed={fit === 'cover'}
              onClick={() => setFit('cover')}>填满裁切</button>
            <button type="button"
              className={`crop-chip${fit === 'contain' ? ' on' : ''}`}
              aria-pressed={fit === 'contain'}
              onClick={() => setFit('contain')}>完整留白</button>
          </div>
          <label className="batch-toggle">
            <input type="checkbox" checked={cutLines}
              onChange={e => setCutLines(e.target.checked)} />
            <span>显示裁切参考线</span>
          </label>
          <div className="print-layout-sliders">
            <Slider
              label="页边距"
              value={marginPct}
              min={0}
              max={10}
              step={0.5}
              changed={marginPct !== 3.5}
              onChange={setMarginPct}
            />
            <Slider
              label="格子间距"
              value={gapPct}
              min={0}
              max={5}
              step={0.5}
              changed={gapPct !== 1.8}
              onChange={setGapPct}
            />
          </div>
        </section>

        {files.length > 0 && (
          <section className="batch-section" aria-labelledby="print-cells-title">
            <div className="batch-section-head">
              <h2 id="print-cells-title">格子</h2>
              <div className="batch-section-tools">
                <span>{cellCount} 格</span>
                {order && (
                  <button className="batch-cull" onClick={() => setOrder(null)}>
                    按顺序铺
                  </button>
                )}
              </div>
            </div>
            <p className="batch-hint">
              每一格都可以单独换成别的照片；不换时按已选顺序循环铺满整版。
            </p>
            <div className="print-cell-grid">
              {effectiveOrder.map((sourceIndex, cell) => {
                const item = files[sourceIndex] ?? files[0]
                return (
                  <label className="print-cell" key={cell}>
                    <span className="print-cell-index">{cell + 1}</span>
                    {item?.preview
                      ? <img className="print-cell-thumb" src={item.preview} alt="" />
                      : <span className="print-cell-thumb print-cell-thumb-empty" aria-hidden="true" />}
                    <select
                      aria-label={`第 ${cell + 1} 格照片`}
                      value={sourceIndex}
                      onChange={(e) => {
                        const next = [...effectiveOrder]
                        next[cell] = Number(e.target.value)
                        setOrder(next)
                      }}
                    >
                      {files.map((file, index) => (
                        <option key={file.id} value={index}>{file.file.name}</option>
                      ))}
                    </select>
                  </label>
                )
              })}
            </div>
          </section>
        )}

        <section className="batch-section" aria-labelledby="print-preview-title">
          <div className="batch-section-head">
            <h2 id="print-preview-title">预览</h2>
            <span>{template.width} × {template.height} · 300dpi</span>
          </div>
          {error && <p className="batch-error" role="alert">{error}</p>}
          {previewing && <p className="tool-note">正在排版…</p>}
          {!error && (preview ? (
            <img className="print-preview" src={preview} alt="打印排版预览" />
          ) : (
            <p className="gallery-none">选照片后，这里会出现整版预览。</p>
          ))}
          <div className="crop-tools print-actions">
            <button className="crop-btn btn-primary"
              disabled={!files.length || previewing || downloading || downloadingPdf}
              onClick={() => void downloadSheet()}>
              <Download size={14} strokeWidth={1.5} aria-hidden="true" />
              {downloading ? '正在生成…' : '下载排版 JPG'}
            </button>
            <button className="crop-btn"
              disabled={!files.length || previewing || downloadingPdf || downloading}
              onClick={() => void downloadPdf()}>
              <Download size={14} strokeWidth={1.5} aria-hidden="true" />
              {downloadingPdf ? '正在生成 PDF…' : '下载 PDF'}
            </button>
          </div>
          <p className="batch-hint">
            PDF 按 300dpi 页面尺寸封装，适合送印或归档；JPG 适合直接看图。
          </p>
        </section>
      </div>
    </section>
  )
}
