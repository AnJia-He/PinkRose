/**
 * **短片调色工作区**（★ 2026-10-20）。
 *
 * 手机拍的 10 秒短片是修图产品绕不开的场景：婚礼快剪、孩子跑过来的一下、
 * 店里的新品转一圈。这里不做多轨剪辑，只做"修图"这件事——
 * **剪一段或拼几段 → 套一个和照片一模一样的预设 → 连原声导出 MP4**。
 *
 * 和「照片动图」分工：
 *   · 动图 = 几张照片拼成一段动画（GIF / MP4）；
 *   · 短片 = 已经有画面和声音的视频，只改它的颜色和顺序。
 *
 * ★ 2026-10-20 多段：最多 6 段，**全片合计 20 秒**。每段单独拖起点 / 终点，
 *   可以调顺序、删掉；成片画幅按第一段算，其它段同样 cover 裁切。
 *
 * ⚠️ 逐帧渲染很吃 CPU：20 秒 × 24fps = 480 帧。所以界面上**先说清代价**
 *   （帧数、尺寸、大概要等多久），再让人按导出；导出中可以随时取消。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Camera, Download, Film, Scissors, Sparkles, X } from 'lucide-react'
import { Btn } from './kit/Btn.tsx'
import { PRESETS } from '../core/presets.ts'
import { ZERO, blendAdjustments } from '../../shared/adjustments.ts'
import {
  VIDEO_ASPECTS, VIDEO_FPS_OPTIONS, VIDEO_MAX_CLIPS, VIDEO_MAX_SECONDS,
  type VideoAspect,
} from '../../shared/video.ts'
import { exportVideo } from '../video/export.ts'
import {
  formatVideoTime, videoFramePlan, videoOutputSize,
  VIDEO_SPEEDS, type VideoSpeed,
} from '../video/plan.ts'
import { probeVideoFile } from '../video/probe.ts'
import { downloadImage } from '../export/save.ts'
import { bitmapToDataUrl, makeThumbnail } from '../core/thumbnail.ts'
import { createWork, renameWork } from '../api/works.ts'
import { createFrameCanvas, drawVideoCover } from '../video/frames.ts'
import { TonePipeline } from '../render/pipeline'
import {
  CAPTION_COLORS, CAPTION_MAX, CAPTION_MAX_CHARS, captionAt, clampCaption,
  normalizeCaptionText, paintCaption, type CaptionPosition, type CaptionSize,
  type VideoCaption,
} from '../video/captions'

type Meta = { width: number; height: number; durationMs: number }

type Clip = {
  id: string
  file: File
  url: string
  meta: Meta
  startMs: number
  endMs: number
}

const VIDEO_ACCEPT = '.mp4,.mov,.m4v,.webm,.ogv,.avi,.mkv,video/mp4,video/quicktime,video/webm'
const AUDIO_ACCEPT = '.mp3,.m4a,.aac,.wav,.flac,.ogg,audio/*'

function stamp(): string {
  const now = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
}

function looksLikeVideo(file: File): boolean {
  if (file.type.startsWith('video/')) return true
  return /\.(mp4|mov|m4v|webm|ogv|avi|mkv)$/i.test(file.name)
}

function clipSeconds(clip: Clip): number {
  return Math.max(0, clip.endMs - clip.startMs)
}

/** 某一段里的本地时间 → 全片时间（字幕都按全片时间记）。 */
function filmTimeFor(clips: readonly Clip[], clip: Clip, localMs: number): number {
  let offset = 0
  for (const item of clips) {
    if (item.id === clip.id) break
    offset += clipSeconds(item)
  }
  return offset + Math.max(0, Math.min(clipSeconds(clip), localMs - clip.startMs))
}

export default function VideoPanel({
  onBack, initialFiles, onSeedUsed,
}: {
  onBack: () => void
  /** 相机录好 / 别处带进来的短片，挂载时自动加进来。 */
  initialFiles?: File[]
  onSeedUsed?: () => void
}) {
  const [clips, setClips] = useState<Clip[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [fps, setFps] = useState<(typeof VIDEO_FPS_OPTIONS)[number]>(24)
  const [speed, setSpeed] = useState<VideoSpeed>(1)
  const [aspect, setAspect] = useState<VideoAspect>('source')
  const [keepAudio, setKeepAudio] = useState(true)
  const [music, setMusic] = useState<File | null>(null)
  const [musicMode, setMusicMode] = useState<'mix' | 'replace'>('mix')
  const [musicVolume, setMusicVolume] = useState(60)
  const [captions, setCaptions] = useState<VideoCaption[]>([])
  const [captionId, setCaptionId] = useState<string | null>(null)
  const [previewTimeMs, setPreviewTimeMs] = useState(0)
  const [presetId, setPresetId] = useState('none')
  const [strength, setStrength] = useState(100)
  const [beautySmooth, setBeautySmooth] = useState(0)
  const [beautyBrighten, setBeautyBrighten] = useState(0)
  const [beautyRosy, setBeautyRosy] = useState(0)
  const [grabbing, setGrabbing] = useState(false)
  const [grabNote, setGrabNote] = useState<string | null>(null)
  const [phase, setPhase] = useState<
    { kind: 'idle' } | { kind: 'render' | 'upload' | 'encode'; done: number; total: number }
  >({ kind: 'idle' })
  const [result, setResult] = useState<{ url: string; blob: Blob; filename: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const musicInputRef = useRef<HTMLInputElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const resultRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const idRef = useRef(0)
  const urlsRef = useRef<string[]>([])
  const seededRef = useRef(false)

  const busy = phase.kind !== 'idle'
  const preset = PRESETS.find(p => p.id === presetId) ?? null
  const active = clips.find(c => c.id === activeId) ?? clips[0] ?? null
  const totalMs = clips.reduce((sum, clip) => sum + clipSeconds(clip), 0)
  /** 成片时长 = 源片时长 / 速度；面板上的"全片"和上限都按它算。 */
  const outputMs = totalMs / speed
  const totalFrames = clips.reduce((sum, clip) => {
    try {
      return sum + videoFramePlan(
        { startMs: clip.startMs, endMs: clip.endMs }, clip.meta.durationMs, fps, speed,
      ).times.length
    } catch {
      return sum
    }
  }, 0)
  // 成片画幅按第一段算：多段拼接时每一段都 cover 到同一个尺寸。
  const size = clips[0]
    ? videoOutputSize(clips[0].meta.width, clips[0].meta.height, undefined, aspect)
    : null
  const plansValid = clips.every(clip => {
    try {
      videoFramePlan(
        { startMs: clip.startMs, endMs: clip.endMs }, clip.meta.durationMs, fps, speed,
      )
      return true
    } catch {
      return false
    }
  })
  const canExport = clips.length > 0
    && plansValid
    && outputMs >= 500 && outputMs <= VIDEO_MAX_SECONDS * 1000
  const useOriginalAudio = keepAudio && !(music && musicMode === 'replace')
  const activeCaption = active
    ? captionAt(captions, filmTimeFor(clips, active, previewTimeMs))
    : null
  const selectedCaption = captions.find(caption => caption.id === captionId) ?? null
  const composedAdjustments = useMemo(() => {
    const base = preset ? blendAdjustments(ZERO, preset.adjustments, strength) : ZERO
    const add = (value: number, extra: number) => Math.min(100, Math.max(0, value + extra))
    return {
      ...base,
      skinSmooth: add(base.skinSmooth, beautySmooth),
      skinBrighten: add(base.skinBrighten, beautyBrighten),
      skinRosy: add(base.skinRosy, beautyRosy),
    }
  }, [preset, strength, beautySmooth, beautyBrighten, beautyRosy])

  useEffect(() => {
    // 片子剪短 / 删段之后，字幕不能伸到成片外面。
    setCaptions(prev => prev.map(caption => clampCaption(caption, totalMs)))
  }, [totalMs])

  useEffect(() => () => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url)
    urlsRef.current = []
    if (resultRef.current) URL.revokeObjectURL(resultRef.current)
    abortRef.current?.abort()
  }, [])

  useEffect(() => {
    if (seededRef.current || !initialFiles?.length) return
    seededRef.current = true
    void addFiles(initialFiles, { seed: true })
    // 只在第一次拿到种子文件时跑；后续再带进来由调用方重新挂载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFiles])

  function clearResult() {
    if (resultRef.current) URL.revokeObjectURL(resultRef.current)
    resultRef.current = null
    setResult(null)
  }

  async function addFiles(list: FileList | File[], opts: { seed?: boolean } = {}) {
    if (busy) return
    const incoming = Array.from(list)
    if (incoming.length === 0) return
    const room = Math.max(0, VIDEO_MAX_CLIPS - clips.length)
    if (incoming.length > room) {
      setError(`一次最多 ${VIDEO_MAX_CLIPS} 段，多出来的这次没收。`)
    }
    let used = totalMs
    const added: Clip[] = []
    for (const file of incoming.slice(0, room)) {
      if (!looksLikeVideo(file)) {
        setError('这些文件里有不是视频的，换一批试试。')
        continue
      }
      // 预算按**成片**算：0.5× 时源片只能取 10 秒，2× 时能取 40 秒。
      const remainingOut = VIDEO_MAX_SECONDS * 1000 - used / speed
      if (remainingOut < 500) {
        setError(`全片已经到 ${VIDEO_MAX_SECONDS} 秒了，先剪短一段再加。`)
        break
      }
      try {
        // 先用探测函数自己的临时 URL（读完就 revoke），成功后再建预览 URL。
        // 这样开发模式下 effect 的清理 revoke 不会把还在加载的探测打断。
        const meta = await probeVideoFile(file)
        const url = URL.createObjectURL(file)
        urlsRef.current.push(url)
        const endMs = Math.min(meta.durationMs, remainingOut * speed)
        if (endMs < 500) throw new Error('这一段太短了，至少半秒。')
        added.push({
          id: `clip-${Date.now()}-${++idRef.current}`,
          file, url, meta, startMs: 0, endMs,
        })
        used += endMs
      } catch (e) {
        setError(e instanceof Error ? e.message : '这段视频没读出来，换一段试试。')
      }
    }
    if (added.length) {
      setClips(prev => [...prev, ...added])
      setActiveId(prev => prev ?? added[0]!.id)
      clearResult()
      if (opts.seed) onSeedUsed?.()
    }
  }

  function removeClip(id: string) {
    const hit = clips.find(c => c.id === id)
    if (hit) {
      URL.revokeObjectURL(hit.url)
      urlsRef.current = urlsRef.current.filter(url => url !== hit.url)
    }
    const next = clips.filter(c => c.id !== id)
    setClips(next)
    if (activeId === id) setActiveId(next[0]?.id ?? null)
    clearResult()
  }

  function moveClip(id: string, dir: -1 | 1) {
    const index = clips.findIndex(c => c.id === id)
    const target = index + dir
    if (index < 0 || target < 0 || target >= clips.length) return
    const next = [...clips]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item!)
    setClips(next)
    clearResult()
  }

  function trimActive(startMs: number, endMs: number) {
    if (!active) return
    setClips(prev => prev.map(clip => clip.id === active.id
      ? { ...clip, startMs, endMs }
      : clip))
    clearResult()
  }

  function updateStart(value: number) {
    if (!active) return
    trimActive(Math.max(0, Math.min(value, active.endMs - 500)), active.endMs)
  }

  function updateEnd(value: number) {
    if (!active) return
    const others = totalMs - clipSeconds(active)
    const maxEnd = Math.min(
      active.meta.durationMs,
      active.startMs + (VIDEO_MAX_SECONDS * 1000 - others / speed) * speed,
    )
    trimActive(active.startMs, Math.max(active.startMs + 500, Math.min(value, maxEnd)))
  }

  function addCaption() {
    if (clips.length === 0) {
      setError('先选短片，再加字幕。')
      return
    }
    if (captions.length >= CAPTION_MAX) {
      setError(`最多 ${CAPTION_MAX} 条字幕。`)
      return
    }
    const caption: VideoCaption = {
      id: `cap-${Date.now()}-${++idRef.current}`,
      text: '新字幕',
      startMs: 0,
      endMs: Math.min(2000, Math.max(300, totalMs)),
      position: 'bottom',
      size: 'm',
      color: '#ffffff',
    }
    setCaptions(prev => [...prev, clampCaption(caption, totalMs)])
    setCaptionId(caption.id)
    clearResult()
  }

  function updateCaption(id: string, patch: Partial<VideoCaption>) {
    setCaptions(prev => prev.map(caption => caption.id === id
      ? clampCaption({ ...caption, ...patch }, totalMs)
      : caption))
    clearResult()
  }

  function removeCaption(id: string) {
    setCaptions(prev => prev.filter(caption => caption.id !== id))
    if (captionId === id) setCaptionId(null)
    clearResult()
  }

  /** 打字时**不**做空白规整（否则打一个空格就被吃掉）；导出前再规整。 */
  function setCaptionText(id: string, text: string) {
    setCaptions(prev => prev.map(caption => caption.id === id
      ? { ...caption, text: text.slice(0, CAPTION_MAX_CHARS) }
      : caption))
    clearResult()
  }

  async function grabFrame() {
    const video = videoRef.current
    if (!video || !active || !size || busy || grabbing) return
    setGrabbing(true)
    setGrabNote(null)
    setError(null)
    try {
      const sourceCanvas = createFrameCanvas(size)
      drawVideoCover(video, sourceCanvas, size)
      const sourceBitmap = await createImageBitmap(sourceCanvas)
      const outCanvas = document.createElement('canvas')
      const pipe = new TonePipeline(outCanvas)
      let image = ''
      let thumb = ''
      try {
        pipe.setLut(null)
        pipe.setImage({ bitmap: sourceBitmap, width: size.width, height: size.height })
        pipe.resizeToImage()
        pipe.render(composedAdjustments, 0)
        let output: HTMLCanvasElement = outCanvas
        const caption = captionAt(
          captions, filmTimeFor(clips, active, video.currentTime * 1000),
        )
        if (caption) {
          const plate = document.createElement('canvas')
          plate.width = size.width
          plate.height = size.height
          const ctx = plate.getContext('2d')
          if (ctx) {
            ctx.drawImage(outCanvas, 0, 0)
            paintCaption(ctx, caption, size.width, size.height)
            output = plate
          }
        }
        image = bitmapToDataUrl(output, 0.92)
        thumb = makeThumbnail(output)
      } finally {
        sourceBitmap.close()
        pipe.dispose()
      }
      const { id } = await createWork({
        image,
        thumb,
        sourceName: active.file.name,
      })
      const stem = (active.file.name || '短片').replace(/\.[^.]+$/, '') || '短片'
      await renameWork(id, `${stem}-帧.jpg`).catch(() => { /* 名字失败不拖累保存 */ })
      setGrabNote('这一帧已经存进作品。')
    } catch (e) {
      console.error('截帧没存上', e)
      setError('这一帧没存上，再试一次。')
    } finally {
      setGrabbing(false)
    }
  }

  async function run() {
    const video = videoRef.current
    if (!video || !active || clips.length === 0 || busy) return
    if (!canExport) {
      setError(`全片要在 0.5–${VIDEO_MAX_SECONDS} 秒之间，先拖一下起点和终点。`)
      return
    }
    clearResult()
    setError(null)
    setGrabNote(null)
    setPhase({ kind: 'render', done: 0, total: totalFrames })
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const blob = await exportVideo({
        clips: clips.map(clip => ({
          file: clip.file, url: clip.url, startMs: clip.startMs, endMs: clip.endMs, meta: clip.meta,
        })),
        video,
        fps,
        speed,
        aspect,
        keepAudio: useOriginalAudio,
        music: music ? { file: music, mode: musicMode, volume: musicVolume } : null,
        captions: captions.filter(caption => normalizeCaptionText(caption.text)),
        adjustments: composedAdjustments,
        signal: controller.signal,
        onProgress: (done, total, stage) => setPhase({ kind: stage, done, total }),
      })
      const url = URL.createObjectURL(blob)
      resultRef.current = url
      setResult({ url, blob, filename: `PinkRose-video-${stamp()}.mp4` })
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') {
        setError('这次导出已取消，什么都没留下。')
      } else {
        console.error('短片没导出', e)
        setError(e instanceof Error ? e.message : '短片没导出，再试一次。')
      }
    } finally {
      abortRef.current = null
      setPhase({ kind: 'idle' })
      // 导出过程会把预览切到最后一段；导完切回用户刚才看的那一段。
      if (active) {
        video.src = active.url
        video.load()
      }
    }
  }

  function cancel() {
    abortRef.current?.abort()
  }

  return (
    <section className="gallery batch-page video-page" aria-busy={busy}>
      <header className="gallery-head batch-head">
        <button className="batch-back" onClick={onBack} disabled={busy}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          作品
        </button>
        <div className="batch-heading">
          <h1 className="gallery-title">短片调色</h1>
          <p>导入手机拍的短片，剪一段或拼几段，套一个和照片一样的预设，连原声导出 MP4。</p>
        </div>
      </header>

      <div className="batch-body">
        <section className="batch-section" aria-labelledby="video-file-title">
          <div className="batch-section-head">
            <h2 id="video-file-title">短片</h2>
            <span>
              {clips.length} / {VIDEO_MAX_CLIPS} 段
              {size ? ` · ${size.width} × ${size.height}` : ''}
            </span>
          </div>
          <div className="batch-drop video-drop">
            <input
              ref={inputRef}
              className="batch-file-input"
              type="file"
              accept={VIDEO_ACCEPT}
              multiple
              aria-label="选择要调色的短片"
              onChange={(e) => {
                void addFiles(e.target.files ?? [])
                e.target.value = ''
              }}
            />
            <Film size={22} strokeWidth={1.5} aria-hidden="true" />
            <div className="batch-drop-copy">
              <strong>{clips.length ? '再加一段' : '选一段短片'}</strong>
              <span>
                支持 MP4、MOV、M4V、WebM；可以保留原声，最多 {VIDEO_MAX_CLIPS} 段。
              </span>
            </div>
            <button className="batch-pick" disabled={busy || clips.length >= VIDEO_MAX_CLIPS}
              onClick={() => inputRef.current?.click()}>
              {clips.length ? '加一段' : '选视频'}
            </button>
          </div>
          {clips.length > 0 && (
            <ul className="batch-files" aria-label="已选短片">
              {clips.map((clip, index) => (
                <li key={clip.id}
                  className={`batch-file-row video-clip${clip.id === active?.id ? ' on' : ''}`}>
                  <button type="button" className="video-clip-pick"
                    aria-pressed={clip.id === active?.id}
                    disabled={busy}
                    onClick={() => setActiveId(clip.id)}>
                    <span className="video-clip-index">{index + 1}</span>
                    <span className="batch-file-name" title={clip.file.name}>{clip.file.name}</span>
                    <span className="video-time">{formatVideoTime(clipSeconds(clip))}</span>
                  </button>
                  <button type="button" className="batch-remove" aria-label={`上一段 ${index + 1}`}
                    disabled={busy || index === 0}
                    onClick={() => moveClip(clip.id, -1)}>
                    <span aria-hidden="true">↑</span>
                  </button>
                  <button type="button" className="batch-remove" aria-label={`下一段 ${index + 1}`}
                    disabled={busy || index === clips.length - 1}
                    onClick={() => moveClip(clip.id, 1)}>
                    <span aria-hidden="true">↓</span>
                  </button>
                  <button type="button" className="batch-remove" aria-label={`移除 ${clip.file.name}`}
                    disabled={busy || clips.length <= 1}
                    onClick={() => removeClip(clip.id)}>
                    <X size={15} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {active && (
            <div className="video-stage">
              <video
                ref={videoRef}
                key={active.url}
                className="video-preview"
                src={active.url}
                controls
                playsInline
                preload="metadata"
                onTimeUpdate={e => setPreviewTimeMs(e.currentTarget.currentTime * 1000)}
                onSeeked={e => setPreviewTimeMs(e.currentTarget.currentTime * 1000)}
                onError={() => {
                  // Playwright 的 WebKit / 部分 Linux 浏览器没有 H.264 解码器；
                  // 真实 iPhone 支持。这里至少要把"打不开"说出来，别让人对着空面板等。
                  setError('这个浏览器打不开这段视频（可能是编码格式不支持）。换成 H.264 的 MP4 再试。')
                }}
              />
              {activeCaption && (
                <div
                  className={`video-caption-preview ${activeCaption.position} ${activeCaption.size}`}
                  style={{ color: activeCaption.color }}
                >
                  {activeCaption.text}
                </div>
              )}
            </div>
          )}
          <div className="crop-tools print-actions video-grab">
            <button className="crop-btn" disabled={!active || busy || grabbing}
              onClick={() => void grabFrame()}>
              <Camera size={14} strokeWidth={1.5} aria-hidden="true" />
              {grabbing ? '正在存…' : '截一帧存作品'}
            </button>
            {grabNote && <span className="tool-note" role="status">{grabNote}</span>}
          </div>
        </section>

        <section className="batch-section" aria-labelledby="video-trim-title">
          <div className="batch-section-head">
            <h2 id="video-trim-title">剪一段</h2>
            <span>
              全片 {formatVideoTime(outputMs)} / {VIDEO_MAX_SECONDS}.0 秒
              {active ? ` · 第 ${clips.findIndex(c => c.id === active.id) + 1} 段` : ''}
            </span>
          </div>
          {active ? (
            <>
              <label className="batch-preset">
                <span>起点</span>
                <input
                  type="range"
                  aria-label="起点"
                  min={0}
                  max={active.meta.durationMs}
                  step={100}
                  value={active.startMs}
                  disabled={busy}
                  onChange={e => updateStart(Number(e.target.value))}
                />
                <em className="video-time">{formatVideoTime(active.startMs)}</em>
              </label>
              <label className="batch-preset">
                <span>终点</span>
                <input
                  type="range"
                  aria-label="终点"
                  min={0}
                  max={active.meta.durationMs}
                  step={100}
                  value={active.endMs}
                  disabled={busy}
                  onChange={e => updateEnd(Number(e.target.value))}
                />
                <em className="video-time">{formatVideoTime(active.endMs)}</em>
              </label>
            </>
          ) : (
            <p className="gallery-none">先选一段短片，再拖起点和终点。</p>
          )}
          <label className="batch-preset">
            <span>帧率</span>
            <select value={fps} disabled={busy}
              onChange={e => { setFps(Number(e.target.value) as typeof fps); clearResult() }}>
              {VIDEO_FPS_OPTIONS.map(v => (
                <option key={v} value={v}>{v} fps</option>
              ))}
            </select>
          </label>
          <div className="retouch-modes print-options" role="group" aria-label="播放速度">
            {VIDEO_SPEEDS.map(value => (
              <button key={value} type="button"
                className={`crop-chip${speed === value ? ' on' : ''}`}
                aria-pressed={speed === value}
                disabled={busy}
                onClick={() => { setSpeed(value); clearResult() }}>
                {value}×
              </button>
            ))}
          </div>
          <div className="retouch-modes print-options" role="group" aria-label="成片画幅">
            {VIDEO_ASPECTS.map(item => (
              <button key={item.id} type="button"
                className={`crop-chip${aspect === item.id ? ' on' : ''}`}
                aria-pressed={aspect === item.id}
                disabled={busy}
                onClick={() => { setAspect(item.id); clearResult() }}>
                {item.label}
              </button>
            ))}
          </div>
          <p className="batch-hint">
            <Scissors size={13} strokeWidth={1.5} aria-hidden="true" />
            {' '}成片 {size ? `${size.width} × ${size.height}` : '—'}，
            长边不超过 1280；几段加起来最多 {VIDEO_MAX_SECONDS} 秒
            {clips.length > 0 ? `，大约 ${totalFrames} 帧` : ''}。
          </p>
        </section>

        <section className="batch-section" aria-labelledby="video-look-title">
          <div className="batch-section-head">
            <h2 id="video-look-title">调色</h2>
            <span>{preset ? preset.label : '原片'}</span>
          </div>
          <div className="retouch-modes print-options video-presets" role="group" aria-label="短片预设">
            <button type="button"
              className={`crop-chip${presetId === 'none' ? ' on' : ''}`}
              aria-pressed={presetId === 'none'}
              disabled={busy}
              onClick={() => { setPresetId('none'); clearResult() }}>
              原片
            </button>
            {PRESETS.map(p => (
              <button key={p.id} type="button"
                className={`crop-chip${presetId === p.id ? ' on' : ''}`}
                aria-pressed={presetId === p.id}
                disabled={busy}
                onClick={() => { setPresetId(p.id); clearResult() }}>
                {p.label}
              </button>
            ))}
          </div>
          <label className="batch-preset">
            <span>强度</span>
            <input
              type="range"
              aria-label="预设强度"
              min={0}
              max={100}
              step={1}
              value={strength}
              disabled={!preset || busy}
              onChange={e => { setStrength(Number(e.target.value)); clearResult() }}
            />
            <em className="video-time">{strength}%</em>
          </label>
          <p className="batch-hint">
            <Sparkles size={13} strokeWidth={1.5} aria-hidden="true" />
            {' '}和照片用的是同一套调色：暗角、颗粒、虚化这些也会逐帧算进去。
          </p>
        </section>

        <section className="batch-section" aria-labelledby="video-beauty-title">
          <div className="batch-section-head">
            <h2 id="video-beauty-title">人像</h2>
            <span>叠加在预设上</span>
          </div>
          <label className="batch-preset">
            <span>磨皮</span>
            <input type="range" aria-label="磨皮" min={0} max={100} step={1}
              value={beautySmooth} disabled={busy}
              onChange={e => { setBeautySmooth(Number(e.target.value)); clearResult() }} />
            <em className="video-time">{beautySmooth}%</em>
          </label>
          <label className="batch-preset">
            <span>美白</span>
            <input type="range" aria-label="美白" min={0} max={100} step={1}
              value={beautyBrighten} disabled={busy}
              onChange={e => { setBeautyBrighten(Number(e.target.value)); clearResult() }} />
            <em className="video-time">{beautyBrighten}%</em>
          </label>
          <label className="batch-preset">
            <span>红润</span>
            <input type="range" aria-label="红润" min={0} max={100} step={1}
              value={beautyRosy} disabled={busy}
              onChange={e => { setBeautyRosy(Number(e.target.value)); clearResult() }} />
            <em className="video-time">{beautyRosy}%</em>
          </label>
          <p className="batch-hint">
            只作用在肤色区域，逐帧计算；五官边缘和背景不跟着糊。预设里已经带的美颜会叠加。
          </p>
        </section>

        <section className="batch-section" aria-labelledby="video-caption-title">
          <div className="batch-section-head">
            <h2 id="video-caption-title">字幕</h2>
            <span>{captions.length} / {CAPTION_MAX}</span>
          </div>
          <div className="crop-tools print-actions video-caption-tools">
            <button className="batch-pick"
              disabled={busy || clips.length === 0 || captions.length >= CAPTION_MAX}
              onClick={addCaption}>
              加一条字幕
            </button>
            <span className="batch-hint">字幕会直接烧进画面，任何播放器都能看。</span>
          </div>
          {captions.length > 0 && (
            <ul className="batch-files" aria-label="字幕列表">
              {captions.map((caption, index) => (
                <li key={caption.id}
                  className={`batch-file-row video-caption-row${caption.id === captionId ? ' on' : ''}`}>
                  <button type="button" className="video-clip-pick"
                    aria-pressed={caption.id === captionId}
                    disabled={busy}
                    onClick={() => setCaptionId(caption.id)}>
                    <span className="video-clip-index">{index + 1}</span>
                    <span className="batch-file-name">{caption.text || '（空字幕）'}</span>
                    <span className="video-time">
                      {formatVideoTime(caption.startMs)}–{formatVideoTime(caption.endMs)}
                    </span>
                  </button>
                  <button type="button" className="batch-remove" aria-label={`移除字幕 ${index + 1}`}
                    disabled={busy}
                    onClick={() => removeCaption(caption.id)}>
                    <X size={15} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selectedCaption && (
            <>
              <label className="batch-preset">
                <span>文字</span>
                <input
                  className="video-caption-input"
                  aria-label="字幕文字"
                  maxLength={CAPTION_MAX_CHARS}
                  value={selectedCaption.text}
                  disabled={busy}
                  placeholder="输入字幕…"
                  onChange={e => setCaptionText(selectedCaption.id, e.target.value)}
                />
              </label>
              <label className="batch-preset">
                <span>出现</span>
                <input
                  type="range"
                  aria-label="字幕起点"
                  min={0}
                  max={Math.max(300, totalMs)}
                  step={100}
                  value={selectedCaption.startMs}
                  disabled={busy}
                  onChange={e => updateCaption(selectedCaption.id, {
                    startMs: Number(e.target.value),
                  })}
                />
                <em className="video-time">{formatVideoTime(selectedCaption.startMs)}</em>
              </label>
              <label className="batch-preset">
                <span>消失</span>
                <input
                  type="range"
                  aria-label="字幕终点"
                  min={0}
                  max={Math.max(300, totalMs)}
                  step={100}
                  value={selectedCaption.endMs}
                  disabled={busy}
                  onChange={e => updateCaption(selectedCaption.id, {
                    endMs: Number(e.target.value),
                  })}
                />
                <em className="video-time">{formatVideoTime(selectedCaption.endMs)}</em>
              </label>
              <div className="retouch-modes print-options" role="group" aria-label="字幕位置">
                {([['top', '上'], ['center', '中'], ['bottom', '下']] as const).map(([id, label]) => (
                  <button key={id} type="button"
                    className={`crop-chip${selectedCaption.position === id ? ' on' : ''}`}
                    aria-pressed={selectedCaption.position === id}
                    disabled={busy}
                    onClick={() => updateCaption(selectedCaption.id, { position: id as CaptionPosition })}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="retouch-modes print-options" role="group" aria-label="字幕大小">
                {([['s', '小'], ['m', '中'], ['l', '大']] as const).map(([id, label]) => (
                  <button key={`size-${id}`} type="button"
                    className={`crop-chip${selectedCaption.size === id ? ' on' : ''}`}
                    aria-pressed={selectedCaption.size === id}
                    disabled={busy}
                    onClick={() => updateCaption(selectedCaption.id, { size: id as CaptionSize })}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="retouch-modes print-options" role="group" aria-label="字幕颜色">
                {CAPTION_COLORS.map(color => (
                  <button key={color.id} type="button"
                    className={`crop-chip${selectedCaption.color === color.id ? ' on' : ''}`}
                    aria-pressed={selectedCaption.color === color.id}
                    disabled={busy}
                    onClick={() => updateCaption(selectedCaption.id, { color: color.id })}>
                    {color.label}
                  </button>
                ))}
              </div>
            </>
          )}
          {clips.length === 0 && (
            <p className="gallery-none">先选短片，再加字幕。</p>
          )}
        </section>

        <section className="batch-section" aria-labelledby="video-music-title">
          <div className="batch-section-head">
            <h2 id="video-music-title">背景音乐</h2>
            <span>{music ? music.name : '不添加'}</span>
          </div>
          <input
            ref={musicInputRef}
            className="batch-file-input"
            type="file"
            accept={AUDIO_ACCEPT}
            aria-label="选择背景音乐"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null
              e.target.value = ''
              if (!file) return
              if (!file.type.startsWith('audio/')
                && !/\.(mp3|m4a|aac|wav|flac|ogg)$/i.test(file.name)) {
                setError('这不是音频文件，换一首试试。')
                return
              }
              setMusic(file)
              setError(null)
              clearResult()
            }}
          />
          <div className="crop-tools print-actions video-music-row">
            <button className="batch-pick" disabled={busy}
              onClick={() => musicInputRef.current?.click()}>
              {music ? '换一首' : '选音乐'}
            </button>
            {music && (
              <button className="crop-btn" disabled={busy}
                onClick={() => { setMusic(null); clearResult() }}>
                移除
              </button>
            )}
            {music && <span className="batch-hint">会循环到成片长度。</span>}
          </div>
          {music && (
            <>
              <div className="retouch-modes print-options" role="group" aria-label="音乐模式">
                <button type="button"
                  className={`crop-chip${musicMode === 'mix' ? ' on' : ''}`}
                  aria-pressed={musicMode === 'mix'}
                  disabled={busy}
                  onClick={() => { setMusicMode('mix'); clearResult() }}>
                  混合原声
                </button>
                <button type="button"
                  className={`crop-chip${musicMode === 'replace' ? ' on' : ''}`}
                  aria-pressed={musicMode === 'replace'}
                  disabled={busy}
                  onClick={() => { setMusicMode('replace'); clearResult() }}>
                  替换原声
                </button>
              </div>
              <label className="batch-preset">
                <span>音量</span>
                <input
                  type="range"
                  aria-label="音乐音量"
                  min={0}
                  max={100}
                  step={1}
                  value={musicVolume}
                  disabled={busy}
                  onChange={e => { setMusicVolume(Number(e.target.value)); clearResult() }}
                />
                <em className="video-time">{musicVolume}%</em>
              </label>
              <p className="batch-hint">
                混合时保留片中原声并把音乐垫在下面；替换时只用音乐。
              </p>
            </>
          )}
        </section>

        <section className="batch-section" aria-labelledby="video-out-title">
          <div className="batch-section-head">
            <h2 id="video-out-title">导出</h2>
            <span>{result ? 'MP4 · 原声' : clips.length ? `${totalFrames} 帧` : '—'}</span>
          </div>
          {error && <p className="batch-error" role="alert">{error}</p>}
          <label className="batch-toggle">
            <input type="checkbox" checked={keepAudio}
              disabled={busy || (music !== null && musicMode === 'replace')}
              onChange={e => { setKeepAudio(e.target.checked); clearResult() }} />
            <span>保留片中原声</span>
          </label>
          {busy && (
            <p className="tool-note" role="status">
              {phase.kind === 'encode'
                ? '正在编码 MP4（原声一起合进去）…'
                : `正在逐帧处理 ${phase.done} / ${phase.total}…`}
            </p>
          )}
          {result && (
            <video className="video-preview" src={result.url} controls playsInline />
          )}
          <div className="crop-tools print-actions">
            <Btn className="crop-done" disabled={!canExport || busy}
              onClick={() => void run()}>
              <Sparkles size={14} strokeWidth={1.5} aria-hidden="true" />
              {busy ? '正在导出…' : '导出 MP4'}
            </Btn>
            {busy ? (
              <button className="crop-btn" onClick={cancel}>取消</button>
            ) : (
              <button className="crop-btn" disabled={!result}
                onClick={() => {
                  if (result) downloadImage(result.blob, result.filename)
                }}>
                <Download size={14} strokeWidth={1.5} aria-hidden="true" />
                下载成片
              </button>
            )}
          </div>
          <p className="batch-hint">
            逐帧渲染在本机完成，原片和成片都不经过云端；20 秒 24fps 大约要处理 480 帧。
          </p>
        </section>
      </div>
    </section>
  )
}
