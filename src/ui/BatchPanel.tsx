import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, Download, ImagePlus, Play, Share2, Sparkles, Square, X,
} from 'lucide-react'
import {
  blendAdjustments, clampAdjustments, ZERO, type Adjustments,
} from '../../shared/adjustments.ts'
import { PRESETS } from '../core/presets'
import { usePresets } from '../app/usePresets'
import { useLuts } from '../app/useLuts'
import type { Cube } from '../../shared/lut.ts'
import {
  MAX_BATCH_FILES, processBatchFiles, type BatchBackgroundKind,
  type BatchOutcome, type BatchProgress,
} from '../batch/process'
import { assessCull, type CullAssessment, type CullMetrics } from '../core/cull'
import { analyzePhoto } from '../image/cull'
import { dedupeRawPreviews } from '../core/rawPair'
import {
  clearBatchPrefs, DEFAULT_BATCH_PREFS, loadBatchPrefs, saveBatchPrefs,
  type BatchNamingMode, type BatchOrientation,
} from '../batch/prefs'
import {
  canShareFile, DEFAULT_EXPORT_OPTIONS, downloadImage, shareFile,
  type ExportAspect, type ExportOptions,
} from '../export/save'
import ExportSettings from './ExportSettings'
import BatchCropDialog from './BatchCropDialog'
import type { BatchCropRect } from '../core/batchCrop'
import { Btn } from './kit/Btn.tsx'
import { Slider } from './kit/Slider.tsx'
import WatermarkControls from './WatermarkControls'
import {
  loadTextWatermark, loadWatermarkLogo, saveTextWatermark,
  type WatermarkLogo, type WatermarkOptions,
} from '../image/watermark'
import { decodeImageFile, PHOTO_FILE_ACCEPT } from '../image/decode'
import { blobToDataUrl } from '../image/blob'
import { createWork, renameWork } from '../api/works'
import {
  DEFAULT_DUOTONE, DUOTONE_PRESETS, type DuotoneOptions,
} from '../image/duotone'
import { getHeicCapability } from '../export/heicCapability'

type Picked = {
  id: string
  file: File
  /** 同目录同名 XMP；每张照片优先使用自己的旁车参数。 */
  sidecar?: File
  preview: string
  assessment?: CullAssessment | 'fail'
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function previewOf(file: File): string {
  try { return URL.createObjectURL(file) } catch { return '' }
}

function looksLikeImage(file: File): boolean {
  return file.type.startsWith('image/')
    || /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp|tiff?|dng|cr2|cr3|nef|arw|raf|orf|rw2)$/i.test(file.name)
}

function looksLikeSidecar(file: File): boolean {
  return /\.xmp$/i.test(file.name)
}

function filePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
}

function fileStemKey(file: File): string {
  const path = filePath(file).replace(/\\/g, '/')
  const slash = path.lastIndexOf('/')
  return `${path.slice(0, slash + 1)}${path.slice(slash + 1).replace(/\.[^.]+$/, '').toLowerCase()}`
}

/** 只在同一目录、同一 stem 恰好一份 XMP 时配对；多个候选不猜。 */
function matchingSidecar(photo: File, sidecars: readonly File[]): File | undefined {
  const key = fileStemKey(photo)
  const matches = sidecars.filter(sidecar => fileStemKey(sidecar) === key)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * 批量处理工作区（★ 2026-10-17）。它是「作品」页里的一个模式，不是第六个
 * 一级导航 —— 窄屏导航已经接近放满，而这里做的是"把一批图拿走"，和作品页
 * 原本的语境一致。
 *
 * 交互顺序刻意做成一条直线：选照片 → 选一套调色 → 选导出 → 开始 → 下载。
 * 所有重活都在本机做，不花生成额度；不使用弹窗，避免处理中把进度和失败清单
 * 藏在一个需要先关掉的浮层里。
 */
export default function BatchPanel({
  onBack, currentParams, initialFiles, sourceNote, initialPresetId,
}: {
  onBack: () => void
  /** 编辑器里正在用的那套参数；null / 不给 = 不提供「当前调色」。 */
  currentParams?: Adjustments | null
  /** Files already chosen before entering (e.g. multi-select on welcome). */
  initialFiles?: File[]
  /** 整批照片从哪儿来（例如整组相册）；取失败 / 超上限的张数也在这里说清。 */
  sourceNote?: string | null
  /** 设置页的默认风格；批量入口也按它起手。 */
  initialPresetId?: string | null
}) {
  const [initialPrefs] = useState(loadBatchPrefs)
  const { presets: mine } = usePresets()
  const [files, setFiles] = useState<Picked[]>([])
  const [pairNote, setPairNote] = useState<string | null>(null)
  const [presetId, setPresetId] = useState(initialPresetId ?? PRESETS[0]!.id)
  const [presetAmount, setPresetAmount] = useState(100)
  const [lutId, setLutId] = useState<number | null>(null)
  const [lutAmount, setLutAmount] = useState(100)
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)
  const [heicSupported, setHeicSupported] = useState(false)
  const [aspect, setAspect] = useState<ExportAspect>(initialPrefs.aspect)
  const [orientation, setOrientation] = useState<BatchOrientation>(initialPrefs.orientation)
  const [autoEnhance, setAutoEnhance] = useState(initialPrefs.autoEnhance)
  const [autoLens, setAutoLens] = useState(initialPrefs.autoLens)
  const [smartCrop, setSmartCrop] = useState(initialPrefs.smartCrop)
  /** 逐张手动取景：key 是 Picked.id，值是相对转向后照片的归一化框。 */
  const [crops, setCrops] = useState<Record<string, BatchCropRect>>({})
  const [cropEditorId, setCropEditorId] = useState<string | null>(null)
  const cropEditing = cropEditorId
    ? files.find(f => f.id === cropEditorId) ?? null
    : null
  const [upscale, setUpscale] = useState(false)
  const [upscaleFactor, setUpscaleFactor] = useState(2)
  const [includeXmp, setIncludeXmp] = useState(false)
  const [backgroundKind, setBackgroundKind] = useState<BatchBackgroundKind>('off')
  const [backgroundColor, setBackgroundColor] = useState('#ffffff')
  const [backgroundImage, setBackgroundImage] = useState<{ name: string; url: string } | null>(null)
  const [portraitSmooth, setPortraitSmooth] = useState(0)
  const [portraitMultiFace, setPortraitMultiFace] = useState(false)
  const [portraitLight, setPortraitLight] = useState(0)
  const [portraitWhiten, setPortraitWhiten] = useState(0)
  const [portraitRosy, setPortraitRosy] = useState(0)
  const [portraitBlemish, setPortraitBlemish] = useState(false)
  const [portraitSlim, setPortraitSlim] = useState(0)
  const [portraitNeck, setPortraitNeck] = useState(0)
  const [portraitDoubleChin, setPortraitDoubleChin] = useState(0)
  const [portraitShoulder, setPortraitShoulder] = useState(0)
  const [portraitSmile, setPortraitSmile] = useState(0)
  const [duotoneOn, setDuotoneOn] = useState(false)
  const [duotone, setDuotone] = useState<DuotoneOptions>({ ...DEFAULT_DUOTONE })
  const [nameMode, setNameMode] = useState<BatchNamingMode>(initialPrefs.nameMode)
  const [namePrefix, setNamePrefix] = useState(initialPrefs.namePrefix)
  const [watermark, setWatermark] = useState<WatermarkOptions>(loadTextWatermark)
  const [logo, setLogo] = useState<WatermarkLogo | null>(null)
  const [processing, setProcessing] = useState(false)
  const [culling, setCulling] = useState(false)
  const [cullNote, setCullNote] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const [outcome, setOutcome] = useState<BatchOutcome | null>(null)
  const [savingWorks, setSavingWorks] = useState(false)
  const [saveNote, setSaveNote] = useState<string | null>(null)
  const [sharingArchive, setSharingArchive] = useState(false)
  const [archiveNote, setArchiveNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const bgInputRef = useRef<HTMLInputElement | null>(null)
  const idRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const previewsRef = useRef<string[]>([])
  const backgroundBitmapRef = useRef<ImageBitmap | null>(null)
  const backgroundPreviewRef = useRef<string | null>(null)
  const logoRef = useRef<WatermarkLogo | null>(null)
  const lutsApi = useLuts({
    lut: lutId === null ? null : { lutId, amount: lutAmount },
    image: null,
    params: ZERO,
    onError: setError,
  })

  useEffect(() => {
    let alive = true
    void getHeicCapability().then(capability => {
      if (!alive) return
      setHeicSupported(capability.available)
      if (!capability.available) {
        setOptions(current => current.format === 'image/heic'
          ? { ...current, format: 'image/jpeg' }
          : current)
      }
    })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    saveBatchPrefs({
      aspect,
      orientation,
      autoEnhance,
      autoLens,
      smartCrop,
      nameMode,
      namePrefix,
    })
  }, [aspect, orientation, autoEnhance, autoLens, smartCrop, nameMode, namePrefix])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
      logoRef.current?.close?.()
      logoRef.current = null
      backgroundBitmapRef.current?.close()
      backgroundBitmapRef.current = null
      if (backgroundPreviewRef.current) URL.revokeObjectURL(backgroundPreviewRef.current)
      backgroundPreviewRef.current = null
      for (const url of previewsRef.current) URL.revokeObjectURL(url)
      previewsRef.current = []
    }
  }, [])

  const allPresets = [
    ...(currentParams
      ? [{ id: '__current__', label: '当前调色', adjustments: clampAdjustments(currentParams) }]
      : []),
    ...PRESETS.map(p => ({ id: p.id, label: p.label, adjustments: p.adjustments })),
    ...mine.map(p => ({
      id: String(p.id), label: p.name, adjustments: clampAdjustments(p.params),
    })),
  ]
  const selectedPreset = allPresets.find(p => p.id === presetId) ?? allPresets[0]!
  const batchAdjustments = blendAdjustments(ZERO, selectedPreset.adjustments, presetAmount)
  const selectedLut: { cube: Cube; amount: number } | null = lutId === null
    ? null
    : (lutsApi.cube ? { cube: lutsApi.cube, amount: lutAmount } : null)
  const portraitOn = portraitSmooth > 0 || portraitLight > 0
    || portraitWhiten > 0 || portraitRosy > 0 || portraitBlemish
    || portraitSlim > 0 || portraitNeck > 0 || portraitDoubleChin > 0
    || portraitShoulder > 0 || portraitSmile > 0

  function changedSelection() {
    setOutcome(null)
    setSaveNote(null)
    setArchiveNote(null)
    setProgress(null)
    setError(null)
  }

  function resetBatchPreferences() {
    clearBatchPrefs()
    setAspect(DEFAULT_BATCH_PREFS.aspect)
    setOrientation(DEFAULT_BATCH_PREFS.orientation)
    setAutoEnhance(DEFAULT_BATCH_PREFS.autoEnhance)
    setAutoLens(DEFAULT_BATCH_PREFS.autoLens)
    setSmartCrop(DEFAULT_BATCH_PREFS.smartCrop)
    setNameMode(DEFAULT_BATCH_PREFS.nameMode)
    setNamePrefix(DEFAULT_BATCH_PREFS.namePrefix)
    changedSelection()
  }

  function addFiles(list: FileList | File[]) {
    if (processing || culling) return
    const all = Array.from(list)
    const incoming = all.filter(file => !looksLikeSidecar(file) && looksLikeImage(file))
    const incomingSidecars = all.filter(looksLikeSidecar)
    const knownSidecars = files.flatMap(item => item.sidecar ? [item.sidecar] : [])
    const sidecars = [...knownSidecars, ...incomingSidecars]
    const deduped = dedupeRawPreviews([...files.map(item => item.file), ...incoming])
    const byFile = new Map(files.map(item => [item.file, item] as const))
    const candidates = deduped.files.map(file => {
      const existing = byFile.get(file)
      const sidecar = existing?.sidecar ?? matchingSidecar(file, sidecars)
      return existing
        ? { ...existing, sidecar }
        : {
            id: `batch-${Date.now()}-${++idRef.current}`,
            file,
            ...(sidecar ? { sidecar } : {}),
            preview: previewOf(file),
          }
    })
    const accepted = candidates.slice(0, MAX_BATCH_FILES)
    const kept = new Set(accepted.map(item => item.file))
    for (const item of files) {
      if (!kept.has(item.file) && item.preview) {
        URL.revokeObjectURL(item.preview)
        previewsRef.current = previewsRef.current.filter(url => url !== item.preview)
      }
    }
    for (const item of accepted) {
      if (item.preview && !previewsRef.current.includes(item.preview)) {
        previewsRef.current.push(item.preview)
      }
    }
    setFiles(accepted.map(item => byFile.has(item.file)
      ? { ...item, assessment: undefined }
      : item))
    const sidecarCount = accepted.filter(item => item.sidecar).length
    const notes = [
      deduped.skippedPreviews.length
        ? `已合并 ${deduped.skippedPreviews.length} 组同目录 RAW + 预览，保留 RAW 原始数据。`
        : '',
      sidecarCount > 0 ? `已匹配 ${sidecarCount} 份同名 XMP，对应照片优先使用自己的调色。` : '',
    ].filter(Boolean)
    setPairNote(notes.length ? notes.join(' ') : null)
    setCullNote(null)
    changedSelection()
    if (candidates.length > MAX_BATCH_FILES) {
      setError(`一次最多处理 ${MAX_BATCH_FILES} 张，多出来的这次没收。`)
    } else if (incoming.length === 0 && incomingSidecars.length === 0 && list.length > 0) {
      setError('这些文件不是照片，换一批试试。')
    }
  }

  useEffect(() => {
    if (!initialFiles?.length) return
    const sidecars = initialFiles.filter(looksLikeSidecar)
    const photos = initialFiles.filter(file => !looksLikeSidecar(file) && looksLikeImage(file))
    const deduped = dedupeRawPreviews(photos)
    const picked = deduped.files.slice(0, MAX_BATCH_FILES).map(file => {
      const sidecar = matchingSidecar(file, sidecars)
      return {
        id: `batch-${Date.now()}-${++idRef.current}`,
        file,
        ...(sidecar ? { sidecar } : {}),
        preview: previewOf(file),
      }
    })
    for (const url of previewsRef.current) URL.revokeObjectURL(url)
    previewsRef.current = picked.flatMap(item => item.preview ? [item.preview] : [])
    setFiles(picked)
    const sidecarCount = picked.filter(item => item.sidecar).length
    const notes = [
      deduped.skippedPreviews.length
        ? `已合并 ${deduped.skippedPreviews.length} 组同目录 RAW + 预览，保留 RAW 原始数据。`
        : '',
      sidecarCount > 0 ? `已匹配 ${sidecarCount} 份同名 XMP，对应照片优先使用自己的调色。` : '',
    ].filter(Boolean)
    setPairNote(notes.length ? notes.join(' ') : null)
    setCrops({})
    setCropEditorId(null)
    setCullNote(null)
    setOutcome(null)
    setSaveNote(null)
    setProgress(null)
    setError(null)
  }, [initialFiles])

  function removeFile(id: string) {
    if (processing || culling) return
    const hit = files.find(f => f.id === id)
    if (hit?.preview) {
      URL.revokeObjectURL(hit.preview)
      previewsRef.current = previewsRef.current.filter(url => url !== hit.preview)
    }
    setFiles(prev => prev.filter(f => f.id !== id).map(f => ({ ...f, assessment: undefined })))
    setCrops(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    if (cropEditorId === id) setCropEditorId(null)
    setCullNote(null)
    changedSelection()
  }

  async function run() {
    if (!files.length || processing || culling) return
    if (lutId !== null && !selectedLut) {
      setError('那套 Lut 还没取回来。稍等一下，或者先换成「不用」。')
      return
    }
    if (backgroundKind === 'image' && !backgroundBitmapRef.current) {
      setError('先选一张背景图，或者把背景改回「保持原样」。')
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    setProcessing(true)
    setOutcome(null)
    setSaveNote(null)
    setArchiveNote(null)
    setError(null)
    setProgress({ completed: 0, total: files.length, currentName: files[0]!.file.name })
    try {
      const activeWatermark = watermark.kind === 'logo'
        ? (logo ? watermark : null)
        : (watermark.text.trim() ? watermark : null)
      const result = await processBatchFiles(
        files.map(f => ({ id: f.id, file: f.file, sidecar: f.sidecar })),
        batchAdjustments,
        options,
        next => { if (mountedRef.current) setProgress(next) },
        controller.signal,
        activeWatermark,
        logo,
        {
          aspect, autoEnhance, autoLens,
          smartCrop: aspect !== 'original' && smartCrop,
          crops: aspect !== 'original' ? crops : undefined,
          upscale,
          upscaleFactor,
          includeXmp,
          rotateTurns: orientation === 'left' ? 1
            : orientation === 'right' ? -1
              : orientation === 'flip180' ? 2 : 0,
          flipH: orientation === 'mirror-h',
          flipV: orientation === 'mirror-v',
          background: backgroundKind === 'color'
            ? { kind: 'color', color: backgroundColor }
            : backgroundKind === 'image'
              ? {
                kind: 'image',
                bitmap: backgroundBitmapRef.current ?? undefined,
                name: backgroundImage?.name,
              }
              : { kind: backgroundKind },
          portrait: portraitOn
            ? {
              multiFace: portraitMultiFace,
              smooth: portraitSmooth,
              light: portraitLight,
              whiten: portraitWhiten,
              rosy: portraitRosy,
              blemish: portraitBlemish,
              slim: portraitSlim,
              neck: portraitNeck,
              doubleChin: portraitDoubleChin,
              shoulder: portraitShoulder,
              smile: portraitSmile,
            }
            : undefined,
          duotone: duotoneOn ? duotone : undefined,
          rename: { mode: nameMode, prefix: namePrefix },
          lut: selectedLut,
        },
      )
      if (!mountedRef.current) return
      setOutcome(result)
      if (result.successes.length === 0) {
        setError(result.cancelled
          ? '已经停下来了。这一批还没有处理完的照片。'
          : '这批照片一张都没处理成。换一张试试？')
      }
    } catch (e) {
      if (!mountedRef.current) return
      console.error('批量处理失败', e)
      setError(e instanceof Error ? `这批没处理成：${e.message}` : '这批没处理成，再试一次？')
    } finally {
      if (mountedRef.current) setProcessing(false)
      controllerRef.current = null
    }
  }

  async function saveToWorks() {
    if (!outcome || savingWorks) return
    const items = outcome.successes.filter(item => item.blob)
    if (items.length === 0) return
    setSavingWorks(true)
    setSaveNote(null)
    let saved = 0
    let failed = 0
    for (const item of items) {
      try {
        const image = await blobToDataUrl(item.workBlob ?? item.blob!)
        const { id } = await createWork({
          image,
          thumb: item.preview,
          sourceName: item.sourceName,
          ...(item.capturedAt ? { capturedAt: item.capturedAt } : {}),
          ...(item.cameraMake ? { cameraMake: item.cameraMake } : {}),
          ...(item.cameraModel ? { cameraModel: item.cameraModel } : {}),
          ...(item.lensModel ? { lensModel: item.lensModel } : {}),
        })
        await renameWork(id, item.filename).catch(() => { /* 图已存进去，名字失败不拖累整批 */ })
        saved++
      } catch (e) {
        console.error('批量成片存进作品失败', item.filename, e)
        failed++
      }
      if (mountedRef.current) {
        setSaveNote(`正在存进作品：${saved + failed} / ${items.length}`)
      }
    }
    if (mountedRef.current) {
      setSaveNote(`已存进作品 ${saved} 张${failed ? `，${failed} 张没存成` : ''}。`)
      setSavingWorks(false)
    }
  }

  async function shareArchive() {
    const archive = outcome?.archive
    if (!archive || sharingArchive) return
    const filename = outcome.archiveName
    setSharingArchive(true)
    setArchiveNote(null)
    try {
      const result = await shareFile(archive, filename)
      if (result === 'shared') {
        setArchiveNote('批量成片 ZIP 已分享；它仍是一个压缩包，接收后需要解压。')
      }
    } catch (e) {
      console.error('批量成片 ZIP 分享失败，改为下载', e)
      downloadImage(archive, filename)
      setArchiveNote('系统分享没成功，已改为下载批量成片 ZIP。')
    } finally {
      setSharingArchive(false)
    }
  }

  /** 本地看一遍清晰度 / 曝光，只给建议，不自动删照片。 */
  async function runCull() {
    if (files.length < 2 || processing || culling) return
    const snapshot = files.map(f => ({ id: f.id, file: f.file }))
    setCulling(true)
    setCullNote(null)
    setError(null)
    const ids: string[] = []
    const metrics: CullMetrics[] = []
    const failed = new Set<string>()
    try {
      for (const item of snapshot) {
        try {
          metrics.push(await analyzePhoto(item.file))
          ids.push(item.id)
        } catch {
          failed.add(item.id)
        }
      }
      const verdicts = assessCull(metrics)
      const byId = new Map(ids.map((id, i) => [id, verdicts[i]!]))
      setFiles(prev => prev.map(f => ({
        ...f,
        assessment: byId.get(f.id) ?? (failed.has(f.id) ? 'fail' : undefined),
      })))
      const keep = verdicts.filter(v => v.keep).length
      setCullNote(
        `已看完 ${snapshot.length} 张：${keep} 张推荐保留`
        + `${failed.size ? `，${failed.size} 张没分析成` : ''}。只给建议，不会自动删照片。`,
      )
    } finally {
      if (mountedRef.current) setCulling(false)
    }
  }

  function patchOptions(next: Partial<ExportOptions>) {
    setOptions(prev => ({ ...prev, ...next }))
    changedSelection()
  }

  function updateWatermark(next: WatermarkOptions) {
    setWatermark(next)
    saveTextWatermark(next)
    changedSelection()
  }

  async function pickLogo(file: File | null) {
    const next = file ? await loadWatermarkLogo(file) : null
    logoRef.current?.close?.()
    logoRef.current = next
    setLogo(next)
    if (file) setWatermark(w => ({ ...w, kind: 'logo' }))
    changedSelection()
  }

  async function pickBackgroundImage(file: File | null) {
    if (!file || processing) return
    try {
      const decoded = await decodeImageFile(file)
      if (!mountedRef.current) {
        decoded.bitmap.close()
        return
      }
      backgroundBitmapRef.current?.close()
      backgroundBitmapRef.current = decoded.bitmap
      if (backgroundPreviewRef.current) URL.revokeObjectURL(backgroundPreviewRef.current)
      const url = URL.createObjectURL(file)
      backgroundPreviewRef.current = url
      setBackgroundImage({ name: file.name, url })
      setBackgroundKind('image')
      changedSelection()
    } catch (e) {
      console.error('批量背景图打不开', e)
      setError('这张背景图打不开，换一张 JPG / PNG 试试。')
    }
  }

  const done = progress?.completed ?? 0
  const total = progress?.total ?? files.length
  const savable = outcome?.successes.filter(item => item.blob).length ?? 0

  return (
    <section className="gallery batch-page" aria-busy={processing}>
      <header className="gallery-head batch-head">
        <button className="batch-back" onClick={onBack} disabled={processing}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          作品
        </button>
        <div className="batch-heading">
          <h1 className="gallery-title">批量处理</h1>
          <p>同一套调色、背景和人像精修，套到一组照片上。都在本机完成。</p>
          {sourceNote && <p className="batch-source-note" role="status">{sourceNote}</p>}
        </div>
      </header>

      <div className="batch-body">
        <section className="batch-section" aria-labelledby="batch-photos-title">
          <div className="batch-section-head">
            <h2 id="batch-photos-title">照片</h2>
            <div className="batch-section-tools">
              <span>{files.length} / {MAX_BATCH_FILES}</span>
              <button
                className="batch-cull"
                disabled={files.length < 2 || processing || culling}
                onClick={() => void runCull()}
              >
                <Sparkles size={13} strokeWidth={1.5} aria-hidden="true" />
                {culling ? '正在看…' : '智能挑图'}
              </button>
            </div>
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
              accept={PHOTO_FILE_ACCEPT}
              multiple
              disabled={processing}
              aria-label="选择要批量处理的照片"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <ImagePlus size={22} strokeWidth={1.5} aria-hidden="true" />
            <div className="batch-drop-copy">
              <strong>{files.length ? '再加几张' : '把照片选进来'}</strong>
              <span>支持 JPG、PNG、WebP、HEIC / HEIF；也可以直接拖到这里。</span>
            </div>
            <button className="batch-pick" onClick={() => inputRef.current?.click()}
                    disabled={processing || culling || files.length >= MAX_BATCH_FILES}>
              选照片
            </button>
          </div>

          {pairNote && <p className="batch-hint" role="status">{pairNote}</p>}
          {files.length > 0 && (
            <ul className="batch-files" aria-label="已选照片">
              {files.map(item => (
                <li key={item.id} className="batch-file-row">
                  {item.preview
                    ? <img className="batch-thumb" src={item.preview} alt="" />
                    : <span className="batch-thumb batch-thumb-empty" aria-hidden="true" />}
                  <span className="batch-file-copy">
                    <span className="batch-file-name" title={item.file.name}>{item.file.name}</span>
                    {item.assessment === 'fail'
                      ? <span className="batch-score fail" title="这张没分析成，仍可正常处理">未分析</span>
                      : item.assessment
                        ? (
                          <span
                            className={`batch-score ${item.assessment.keep ? 'keep' : 'review'}`}
                            title={item.assessment.reason}
                          >
                            {item.assessment.keep ? '保留' : '复查'}
                          </span>
                        )
                        : null}
                  </span>
                  <span className="batch-file-size">{fileSize(item.file.size)}</span>
                  {aspect !== 'original' && (
                    <button
                      type="button"
                      className={`batch-frame${crops[item.id] ? ' on' : ''}`}
                      disabled={processing}
                      aria-pressed={!!crops[item.id]}
                      title={crops[item.id]
                        ? '这张已经手动取景；点一下重新调整'
                        : '手动决定这张的裁切位置和范围'}
                      onClick={() => setCropEditorId(item.id)}
                    >
                      {crops[item.id] ? '已取景' : '取景'}
                    </button>
                  )}
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
          {cullNote && <p className="batch-cull-note" role="status">{cullNote}</p>}
        </section>

        <section className="batch-section" aria-labelledby="batch-unify-title">
          <div className="batch-section-head">
            <h2 id="batch-unify-title">统一处理</h2>
            <span>逐张按自己的画面校正</span>
          </div>
          <label className="batch-preset">
            <span>画幅</span>
            <select
              value={aspect}
              disabled={processing}
              onChange={(e) => {
                setAspect(e.target.value as ExportAspect)
                // 画幅变了，旧的手动取景比例已经不对；宁可清空，也不让
                // 用户以为框还在、导出时却裁歪。
                setCrops({})
                setCropEditorId(null)
                changedSelection()
              }}
            >
              <option value="original">保持原样</option>
              <option value="1:1">1:1 方形</option>
              <option value="4:5">4:5 竖版</option>
              <option value="3:4">3:4 竖版</option>
              <option value="4:3">4:3 横版</option>
              <option value="9:16">9:16 手机</option>
              <option value="16:9">16:9 宽屏</option>
            </select>
          </label>
          <label className="batch-preset">
            <span>方向</span>
            <select
              value={orientation}
              disabled={processing}
              onChange={(e) => {
                setOrientation(e.target.value as typeof orientation)
                // 取景坐标相对转向后的照片；方向一变，坐标的参照系就换了。
                setCrops({})
                setCropEditorId(null)
                changedSelection()
              }}
            >
              <option value="original">保持原样</option>
              <option value="left">左转 90°</option>
              <option value="right">右转 90°</option>
              <option value="flip180">旋转 180°</option>
              <option value="mirror-h">水平翻转</option>
              <option value="mirror-v">垂直翻转</option>
            </select>
          </label>
          {aspect !== 'original' && (
            <>
              <label className="batch-toggle">
                <input
                  type="checkbox"
                  checked={smartCrop}
                  disabled={processing}
                  onChange={(e) => {
                    setSmartCrop(e.target.checked)
                    changedSelection()
                  }}
                />
                <span>智能主体构图</span>
              </label>
              <p className="batch-hint">
                想自己决定裁切位置：在照片列表里逐张点「取景」。手动取景的照片优先用自己的框，
                其余照片继续按智能主体构图或居中裁切；换画幅 / 方向会重置手动取景。
              </p>
            </>
          )}
          <label className="batch-toggle">
            <input
              type="checkbox"
              checked={autoEnhance}
              disabled={processing}
              onChange={(e) => {
                setAutoEnhance(e.target.checked)
                changedSelection()
              }}
            />
            <span>每张自动增强</span>
          </label>
          <label className="batch-toggle">
            <input
              type="checkbox"
              checked={autoLens}
              disabled={processing}
              onChange={(e) => {
                setAutoLens(e.target.checked)
                changedSelection()
              }}
            />
            <span>按 EXIF 自动镜头校正</span>
          </label>
          <label className="batch-preset">
            <span>背景</span>
            <select
              value={backgroundKind}
              disabled={processing}
              onChange={(e) => {
                setBackgroundKind(e.target.value as BatchBackgroundKind)
                changedSelection()
              }}
            >
              <option value="off">保持原样</option>
              <option value="transparent">透明背景（PNG）</option>
              <option value="white">纯白</option>
              <option value="blue">证件蓝</option>
              <option value="gray">浅灰</option>
              <option value="blur">虚化原背景</option>
              <option value="color">自定义颜色</option>
              <option value="image">自定义背景图</option>
            </select>
          </label>
          {backgroundKind === 'color' && (
            <label className="batch-preset">
              <span>颜色</span>
              <input
                className="batch-color-input"
                type="color"
                aria-label="批量背景颜色"
                value={backgroundColor}
                disabled={processing}
                onChange={(e) => {
                  setBackgroundColor(e.target.value)
                  changedSelection()
                }}
              />
            </label>
          )}
          {backgroundKind === 'image' && (
            <div className="batch-bg-pick">
              {backgroundImage && (
                <img className="batch-thumb" src={backgroundImage.url} alt="" />
              )}
              <button
                type="button"
                className="batch-pick"
                disabled={processing}
                onClick={() => bgInputRef.current?.click()}
              >
                {backgroundImage ? '换一张背景图' : '选背景图'}
              </button>
              {backgroundImage && (
                <span className="batch-bg-name" title={backgroundImage.name}>
                  {backgroundImage.name}
                </span>
              )}
              <input
                ref={bgInputRef}
                className="batch-file-input"
                type="file"
                accept="image/*,.heic,.heif"
                aria-label="选择批量背景图"
                disabled={processing}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void pickBackgroundImage(file)
                  e.target.value = ''
                }}
              />
            </div>
          )}
          {backgroundKind !== 'off' && (
            <p className="batch-hint">
              本机逐张识别主体后换背景；没认出主体的那张会单独跳过，不影响其它照片。
              透明背景固定导出 PNG。
              {backgroundKind === 'image' ? ' 背景图会等比铺满每张成片。' : ''}
            </p>
          )}
          <p className="batch-hint">
            方向和画幅会先统一，再套调色；智能主体构图会逐张把裁切中心移到主体上，认不出主体就居中。
            自动增强只校正曝光、对比、高光、阴影、白平衡和饱和度，保留所选风格的其它参数。
            自动镜头校正会按每张照片的 EXIF 认镜头；认出的照片覆盖畸变 / 暗角 / 色差三根，认不出的保留你选的值。
          </p>
        </section>

        <section className="batch-section" aria-labelledby="batch-portrait-title">
          <div className="batch-section-head">
            <h2 id="batch-portrait-title">人像精修</h2>
            <span>逐张找脸，找不到就保留原样</span>
          </div>
          <label className="batch-toggle">
            <input
              type="checkbox"
              checked={portraitMultiFace}
              disabled={processing}
              onChange={(e) => {
                setPortraitMultiFace(e.target.checked)
                changedSelection()
              }}
            />
            <span>合影多人脸</span>
          </label>
          {portraitMultiFace && (
            <p className="batch-hint">
              会让本地肤色检测里的多张脸都参与磨皮、补光、美白、红润、去斑和瘦脸 / 微笑；
              瘦颈 / 双下巴 / 肩线仍按最大的一张脸处理。背景暖色块可能被误认，建议先用小批试。
            </p>
          )}
          <Slider
            label="磨皮"
            value={portraitSmooth}
            min={0}
            max={100}
            changed={portraitSmooth !== 0}
            onChange={(value) => {
              setPortraitSmooth(value)
              changedSelection()
            }}
          />
          <Slider
            label="面部补光"
            value={portraitLight}
            min={0}
            max={100}
            changed={portraitLight !== 0}
            onChange={(value) => {
              setPortraitLight(value)
              changedSelection()
            }}
          />
          <Slider
            label="美白"
            value={portraitWhiten}
            min={0}
            max={100}
            changed={portraitWhiten !== 0}
            onChange={(value) => {
              setPortraitWhiten(value)
              changedSelection()
            }}
          />
          <Slider
            label="红润"
            value={portraitRosy}
            min={0}
            max={100}
            changed={portraitRosy !== 0}
            onChange={(value) => {
              setPortraitRosy(value)
              changedSelection()
            }}
          />
          <Slider
            label="瘦脸"
            value={portraitSlim}
            min={0}
            max={100}
            changed={portraitSlim !== 0}
            onChange={(value) => {
              setPortraitSlim(value)
              changedSelection()
            }}
          />
          <Slider
            label="瘦颈"
            value={portraitNeck}
            min={0}
            max={100}
            changed={portraitNeck !== 0}
            onChange={(value) => {
              setPortraitNeck(value)
              changedSelection()
            }}
          />
          <Slider
            label="双下巴"
            value={portraitDoubleChin}
            min={0}
            max={100}
            changed={portraitDoubleChin !== 0}
            onChange={(value) => {
              setPortraitDoubleChin(value)
              changedSelection()
            }}
          />
          <Slider
            label="直角肩"
            value={portraitShoulder}
            min={0}
            max={100}
            changed={portraitShoulder !== 0}
            onChange={(value) => {
              setPortraitShoulder(value)
              changedSelection()
            }}
          />
          <Slider
            label="微笑"
            value={portraitSmile}
            min={0}
            max={100}
            changed={portraitSmile !== 0}
            onChange={(value) => {
              setPortraitSmile(value)
              changedSelection()
            }}
          />
          <label className="batch-toggle">
            <input
              type="checkbox"
              checked={portraitBlemish}
              disabled={processing}
              onChange={(e) => {
                setPortraitBlemish(e.target.checked)
                changedSelection()
              }}
            />
            <span>自动去斑</span>
          </label>
          <p className="batch-hint">
            本机识别正脸后逐张处理；没找到人脸的照片会保留原样，并在结果里单独计数。
            磨皮、补光、美白、红润和塑形都从 0 开始，调到大于 0 才生效。
          </p>
        </section>

        <section className="batch-section" aria-labelledby="batch-duotone-title">
          <div className="batch-section-head">
            <h2 id="batch-duotone-title">创意风格</h2>
            <span>整批统一双色调</span>
          </div>
          <label className="batch-toggle">
            <input
              type="checkbox"
              name="batch-duotone"
              checked={duotoneOn}
              disabled={processing}
              onChange={(e) => {
                setDuotoneOn(e.target.checked)
                changedSelection()
              }}
            />
            <span>双色调</span>
          </label>
          {duotoneOn && (
            <>
              <div className="batch-chip-row" role="group" aria-label="批量双色调预设">
                {DUOTONE_PRESETS.map(preset => {
                  const on = duotone.shadow === preset.shadow
                    && duotone.highlight === preset.highlight
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={`batch-chip${on ? ' on' : ''}`}
                      aria-pressed={on}
                      disabled={processing}
                      onClick={() => {
                        setDuotone(current => ({
                          ...current,
                          preset: preset.id,
                          shadow: preset.shadow,
                          highlight: preset.highlight,
                        }))
                        changedSelection()
                      }}
                    >{preset.label}</button>
                  )
                })}
              </div>
              <div className="batch-duotone-colors">
                <label className="batch-preset">
                  <span>暗部</span>
                  <input
                    className="batch-color-input"
                    type="color"
                    aria-label="批量双色调暗部"
                    value={duotone.shadow}
                    disabled={processing}
                    onChange={(e) => {
                      setDuotone(current => ({ ...current, shadow: e.target.value }))
                      changedSelection()
                    }}
                  />
                </label>
                <label className="batch-preset">
                  <span>亮部</span>
                  <input
                    className="batch-color-input"
                    type="color"
                    aria-label="批量双色调亮部"
                    value={duotone.highlight}
                    disabled={processing}
                    onChange={(e) => {
                      setDuotone(current => ({ ...current, highlight: e.target.value }))
                      changedSelection()
                    }}
                  />
                </label>
              </div>
              <Slider
                label="双色调强度"
                value={duotone.intensity}
                min={0}
                max={100}
                changed={duotone.intensity !== DEFAULT_DUOTONE.intensity}
                onChange={(value) => {
                  setDuotone(current => ({ ...current, intensity: value }))
                  changedSelection()
                }}
              />
            </>
          )}
          <p className="batch-hint">
            双色调在换背景之后、加水印之前套上，整批共用一个渐变；强度 0 时保持原样。
          </p>
        </section>

        <section className="batch-section" aria-labelledby="batch-upscale-title">
          <div className="batch-section-head">
            <h2 id="batch-upscale-title">输出增强</h2>
            <span>本机处理，不调用模型</span>
          </div>
          <label className="batch-toggle">
            <input
              type="checkbox"
              checked={upscale}
              disabled={processing}
              onChange={(e) => {
                setUpscale(e.target.checked)
                changedSelection()
              }}
            />
            <span>超清放大</span>
          </label>
          {upscale && (
            <div className="batch-chip-row" role="group" aria-label="批量放大倍数">
              {[2, 4].map(factor => (
                <button
                  key={factor}
                  type="button"
                  className={`batch-chip${upscaleFactor === factor ? ' on' : ''}`}
                  aria-pressed={upscaleFactor === factor}
                  disabled={processing}
                  onClick={() => {
                    setUpscaleFactor(factor)
                    changedSelection()
                  }}
                >{factor}×</button>
              ))}
            </div>
          )}
          <p className="batch-hint">
            在当前导出尺寸上放大 {upscaleFactor}×，目标面积最多 12 MP；超出设备上限或原图已经很大的照片会保留原尺寸，并在结果里单独计数。
          </p>
          <label className="batch-toggle">
            <input
              type="checkbox"
              name="batch-xmp"
              checked={includeXmp}
              disabled={processing}
              onChange={(e) => {
                setIncludeXmp(e.target.checked)
                changedSelection()
              }}
            />
            <span>附带 XMP 调色配方</span>
          </label>
          <p className="batch-hint">
            ZIP 中每张成片旁附一份同名 .xmp，记录这张实际套用的调色参数。
            Lut 不会写进 XMP，需要和 Lut 文件分开保留。
          </p>
        </section>

        <section className="batch-section" aria-labelledby="batch-style-title">
          <div className="batch-section-head">
            <h2 id="batch-style-title">调色</h2>
            <span>整套参数一起套</span>
          </div>
          <label className="batch-preset">
            <span>风格</span>
            <select
              value={selectedPreset.id}
              disabled={processing}
              onChange={(e) => { setPresetId(e.target.value); changedSelection() }}
            >
              {currentParams && (
                <optgroup label="当前">
                  <option value="__current__">当前调色</option>
                </optgroup>
              )}
              <optgroup label="内置">
                {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </optgroup>
              {mine.length > 0 && (
                <optgroup label="我的预设">
                  {mine.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>
          <Slider
            label={`${selectedPreset.label}强度`}
            value={presetAmount}
            min={0}
            max={100}
            changed={presetAmount !== 100}
            onChange={(amount) => {
              setPresetAmount(amount)
              changedSelection()
            }}
          />
          <label className="batch-preset">
            <span>Lut</span>
            <select
              value={lutId === null ? '' : String(lutId)}
              disabled={processing}
              onChange={(e) => {
                setLutId(e.target.value ? Number(e.target.value) : null)
                changedSelection()
              }}
            >
              <option value="">不用</option>
              {lutsApi.luts.map(l => (
                <option key={l.id} value={String(l.id)}>{l.name}</option>
              ))}
            </select>
          </label>
          {lutId !== null && (
            <Slider
              label="Lut 强度"
              value={lutAmount}
              min={0}
              max={100}
              changed={lutAmount !== 100}
              onChange={(amount) => {
                setLutAmount(amount)
                changedSelection()
              }}
            />
          )}
          {lutId !== null && !lutsApi.cube && (
            <p className="batch-hint">正在取这套 Lut，取回来之前不会开始处理。</p>
          )}
          <p className="batch-hint">预设和 Lut 都不会改变照片的裁剪、文字或贴纸；这一轮只套调色。</p>
        </section>

        <section className="batch-section" aria-labelledby="batch-watermark-title">
          <div className="batch-section-head">
            <h2 id="batch-watermark-title">水印</h2>
            <span>文字或 Logo，可平铺</span>
          </div>
          <WatermarkControls
            idPrefix="batch"
            options={watermark}
            logo={logo}
            disabled={processing}
            onChange={updateWatermark}
            onLogo={pickLogo}
          />
        </section>

        <section className="batch-section" aria-labelledby="batch-name-title">
          <div className="batch-section-head">
            <h2 id="batch-name-title">文件命名</h2>
            <div className="batch-section-tools">
              <span>设置会自动记住</span>
              <button
                type="button"
                className="batch-cull"
                disabled={processing}
                title="恢复画幅、方向、自动校正和命名默认值"
                onClick={resetBatchPreferences}
              >恢复默认</button>
            </div>
          </div>
          <label className="batch-preset">
            <span>命名</span>
            <select
              value={nameMode}
              disabled={processing}
              onChange={(e) => {
                setNameMode(e.target.value as 'source' | 'sequence' | 'date')
                changedSelection()
              }}
            >
              <option value="source">原文件名</option>
              <option value="sequence">前缀 + 序号</option>
              <option value="date">前缀 + 拍摄日期 + 序号</option>
            </select>
          </label>
          {(nameMode === 'sequence' || nameMode === 'date') && (
            <label className="batch-preset">
              <span>前缀</span>
              <input
                aria-label="文件名前缀"
                value={namePrefix}
                maxLength={40}
                disabled={processing}
                onChange={(e) => { setNamePrefix(e.target.value); changedSelection() }}
              />
            </label>
          )}
          <p className="batch-hint">
            {nameMode === 'date'
              ? `优先使用 EXIF 拍摄日期，例如「${namePrefix.trim() || 'PinkRose'}-20261021-001.jpg」；没有 EXIF 日期时用文件修改日期，并在结果里报告张数。`
              : `序号固定三位，例如「${namePrefix.trim() || 'PinkRose'}-001.jpg」；非法文件名字符会自动去掉。`}
            原文件名模式会保留「_pinkrose」后缀。
          </p>
        </section>

        <section className="batch-section" aria-labelledby="batch-export-title">
          <div className="batch-section-head">
            <h2 id="batch-export-title">导出</h2>
            <span>所有照片用同一套设置</span>
          </div>
          <ExportSettings
            options={options}
            heicSupported={heicSupported}
            onFormat={format => patchOptions({ format })}
            onQuality={qualityPct => patchOptions({ qualityPct })}
            onLongEdge={longEdge => patchOptions({ longEdge })}
            onMetadata={preserveMetadata => patchOptions({ preserveMetadata })}
            onLocation={preserveLocation => patchOptions({ preserveLocation })}
            onCreator={creator => patchOptions({ creator })}
            onCopyright={copyright => patchOptions({ copyright })}
            onColorSpace={colorSpace => patchOptions({ colorSpace })}
            onAspect={value => {
              setAspect(value)
              changedSelection()
            }}
          />
        </section>

        <section className="batch-run" aria-label="批量处理操作">
          {error && <p className="batch-error" role="alert">{error}</p>}
          {(processing || progress) && (
            <div className="batch-progress" aria-live="polite">
              <div className="batch-progress-copy">
                <span>{processing ? '正在处理' : outcome?.cancelled ? '已经停止' : '这一批已经处理完'}</span>
                <span>{done} / {total}</span>
              </div>
              <progress value={done} max={Math.max(1, total)} aria-label="批量处理进度" />
              {processing && progress?.currentName && (
                <p className="batch-current">{progress.currentName}</p>
              )}
            </div>
          )}

          {outcome && outcome.successes.length > 0 && (
            <div className="batch-result">
              <p>
                {outcome.cancelled ? '已经停止。' : '这一批处理好了。'}
                {`成功 ${outcome.successes.length} 张`
                  + (outcome.failures.length > 0 ? `，失败 ${outcome.failures.length} 张` : '')
                  + ((outcome.portraitSkipped ?? 0) > 0
                    ? `，其中 ${outcome.portraitSkipped} 张没找到人脸，已保留原样`
                    : '')
                  + (portraitMultiFace && (outcome.portraitFaces ?? 0) > 0
                    ? `，共处理了 ${outcome.portraitFaces} 张脸`
                    : '')
                  + ((outcome.smartCropFallbacks ?? 0) > 0
                    ? `，其中 ${outcome.smartCropFallbacks} 张没认出主体，已居中裁切`
                    : '')
                  + ((outcome.upscaleSkipped ?? 0) > 0
                    ? `，其中 ${outcome.upscaleSkipped} 张没有放大，已保留原尺寸`
                    : '')
                  + ((outcome.lensMatched ?? 0) > 0
                    ? `，按 EXIF 套用镜头配置 ${outcome.lensMatched} 张`
                    : '')
                  + ((outcome.lensSkipped ?? 0) > 0
                    ? `，${outcome.lensSkipped} 张没认出镜头、保留原校正值`
                    : '')
                  + ((outcome.rawPreviewCount ?? 0) > 0
                    ? `，${outcome.rawPreviewCount} 张 RAW 使用了相机内嵌 JPEG 预览`
                    : '')
                  + ((outcome.dateFallbackCount ?? 0) > 0
                    ? `，${outcome.dateFallbackCount} 张没有 EXIF 日期，命名改用文件修改日期`
                    : '')
                  + ((outcome.sidecarImported ?? 0) > 0
                    ? `，${outcome.sidecarImported} 张使用了各自的 XMP 调色旁车`
                    : '')
                  + ((outcome.sidecarErrors?.length ?? 0) > 0
                    ? `，${outcome.sidecarErrors!.length} 份 XMP 没读出来并保留统一调色`
                    : '')
                  + '。'}
              </p>
              {(outcome.sidecarErrors?.length ?? 0) > 0 && (
                <p className="batch-hint" role="status">
                  {outcome.sidecarErrors!.join(' ')}
                </p>
              )}
              <ul className="batch-done-list">
                {outcome.successes.map(item => (
                  <li
                    key={item.id}
                    className={`batch-done-row${item.preview ? ' has-preview' : ''}${item.blob ? ' has-download' : ''}`}
                  >
                    {item.preview && <img className="batch-done-thumb" src={item.preview} alt="" />}
                    <span className="batch-done-copy">
                      <span>{item.filename}</span>
                      <span>{item.width}×{item.height} · {fileSize(item.bytes)}</span>
                    </span>
                    {item.blob && (
                      <button
                        type="button"
                        className="batch-done-download"
                        aria-label={`下载 ${item.filename}`}
                        onClick={() => downloadImage(item.blob!, item.filename)}
                      >
                        <Download size={14} strokeWidth={1.5} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {outcome && outcome.failures.length > 0 && (
            <div className="batch-failures">
              <h3>没处理成的</h3>
              <ul>
                {outcome.failures.map(item => (
                  <li key={item.id}>
                    <span>{item.sourceName}</span>
                    <span>{item.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="batch-actions">
            {processing ? (
              <button className="batch-stop" onClick={() => controllerRef.current?.abort()}>
                <Square size={13} strokeWidth={1.5} aria-hidden="true" />
                停止
              </button>
            ) : (
              <Btn
                className="batch-run-button"
                disabled={files.length === 0 || !selectedPreset || culling}
                onClick={() => void run()}
              >
                <Play size={14} strokeWidth={1.5} aria-hidden="true" />
                {outcome ? '再处理一次' : '开始处理'}
              </Btn>
            )}
            {savable > 0 && (
              <button
                className="batch-download"
                disabled={savingWorks || processing}
                onClick={() => void saveToWorks()}
              >
                {savingWorks ? '正在存进作品…' : '存进作品'}
              </button>
            )}
            {outcome?.archive && (
              <>
                <button
                  className="batch-download"
                  onClick={() => downloadImage(outcome.archive!, outcome.archiveName)}
                >
                  <Download size={15} strokeWidth={1.5} aria-hidden="true" />
                  下载 ZIP
                </button>
                {canShareFile(outcome.archive, outcome.archiveName) && (
                  <button
                    className="batch-download"
                    disabled={sharingArchive || processing}
                    onClick={() => void shareArchive()}
                  >
                    <Share2 size={15} strokeWidth={1.5} aria-hidden="true" />
                    {sharingArchive ? '正在分享…' : '分享 ZIP'}
                  </button>
                )}
              </>
            )}
          </div>
          {saveNote && <p className="batch-save-note" role="status">{saveNote}</p>}
          {archiveNote && <p className="batch-save-note" role="status">{archiveNote}</p>}
        </section>
      </div>
      {cropEditing && aspect !== 'original' && (
        <BatchCropDialog
          file={cropEditing.file}
          name={cropEditing.file.name}
          aspect={aspect}
          orientation={orientation}
          initialCrop={crops[cropEditing.id]}
          onCancel={() => setCropEditorId(null)}
          onApply={(crop) => {
            setCrops(prev => ({ ...prev, [cropEditing.id]: crop }))
            setCropEditorId(null)
            changedSelection()
          }}
        />
      )}
    </section>
  )
}
