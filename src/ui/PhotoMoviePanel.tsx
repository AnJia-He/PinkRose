/**
 * **照片电影**（★ 2026-10-20）。
 *
 * 选几张照片 → 每张缓慢推近 / 拉远 / 平移 → 套一个预设 → 配一段音乐 →
 * 导出 MP4。和「照片动图」的区别是**画面在动**，不是一张张硬切；
 * 和「短片调色」共用同一条逐帧渲染与编码链路。
 *
 * ⚠️ 全片合计 20 秒（480 帧 @24fps）。照片越多，每张分到的时间越短，
 *   界面上先把"每张最多几秒"算出来。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Download, Film, Music, Sparkles, X } from 'lucide-react'
import { Btn } from './kit/Btn.tsx'
import { PRESETS } from '../core/presets.ts'
import { ZERO, blendAdjustments } from '../../shared/adjustments.ts'
import {
  VIDEO_ASPECTS, VIDEO_FPS_OPTIONS, VIDEO_MAX_SECONDS, type VideoAspect,
} from '../../shared/video.ts'
import {
  PHOTO_MOTIONS, PHOTO_MOVIE_MAX_PHOTOS, PHOTO_MOVIE_MIN_MS, PHOTO_TRANSITIONS,
  maxPerPhotoMs, photoMovieTimeline, type PhotoMovieMotion, type PhotoMovieTransition,
} from '../movie/plan.ts'
import {
  createDecodedImagePreview, isHeicFile, isRawFile, isTiffFile,
  needsDecodedImagePreview, PHOTO_FILE_ACCEPT,
} from '../image/decode'
import { probePhotoFile } from '../movie/probe.ts'
import { exportPhotoMovie } from '../movie/export.ts'
import { downloadImage } from '../export/save.ts'
import { formatVideoTime } from '../video/plan.ts'

type Photo = { id: string; file: File; url: string; width: number; height: number }

const AUDIO_ACCEPT = '.mp3,.m4a,.aac,.wav,.flac,.ogg,audio/*'

function stamp(): string {
  const now = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
}

export default function PhotoMoviePanel({ onBack }: { onBack: () => void }) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [perPhotoMs, setPerPhotoMs] = useState(2500)
  const [motion, setMotion] = useState<PhotoMovieMotion>('in')
  const [transition, setTransition] = useState<PhotoMovieTransition>('fade')
  const [fps, setFps] = useState<(typeof VIDEO_FPS_OPTIONS)[number]>(24)
  const [aspect, setAspect] = useState<VideoAspect>('source')
  const [presetId, setPresetId] = useState('none')
  const [strength, setStrength] = useState(100)
  const [music, setMusic] = useState<File | null>(null)
  const [musicVolume, setMusicVolume] = useState(60)
  const [phase, setPhase] = useState<
    { kind: 'idle' } | { kind: 'render' | 'upload' | 'encode'; done: number; total: number }
  >({ kind: 'idle' })
  const [result, setResult] = useState<{ url: string; blob: Blob; filename: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const musicRef = useRef<HTMLInputElement | null>(null)
  const idRef = useRef(0)
  const urlsRef = useRef<string[]>([])
  const resultRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const busy = phase.kind !== 'idle'
  const preset = PRESETS.find(p => p.id === presetId) ?? null
  const maxMs = maxPerPhotoMs(photos.length)
  const timeline = useMemo(() => {
    if (photos.length === 0) return null
    try {
      return photoMovieTimeline(photos.length, perPhotoMs, fps, transition)
    } catch {
      return null
    }
  }, [photos.length, perPhotoMs, fps, transition])

  useEffect(() => {
    // 照片数量变了，每张的时长上限也跟着变。
    if (photos.length > 0) {
      setPerPhotoMs(value => Math.max(PHOTO_MOVIE_MIN_MS, Math.min(maxMs, value)))
    }
  }, [maxMs, photos.length])

  useEffect(() => () => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url)
    urlsRef.current = []
    if (resultRef.current) URL.revokeObjectURL(resultRef.current)
    abortRef.current?.abort()
  }, [])

  function clearResult() {
    if (resultRef.current) URL.revokeObjectURL(resultRef.current)
    resultRef.current = null
    setResult(null)
  }

  async function addPhotos(list: FileList | File[]) {
    if (busy) return
    const incoming = Array.from(list).filter(file => file.type.startsWith('image/')
      || isRawFile(file) || isHeicFile(file) || isTiffFile(file))
    if (incoming.length === 0) {
      setError('这些文件不是照片，换一批试试。')
      return
    }
    const room = Math.max(0, PHOTO_MOVIE_MAX_PHOTOS - photos.length)
    if (incoming.length > room) setError(`一次最多 ${PHOTO_MOVIE_MAX_PHOTOS} 张，多出来的这次没收。`)
    const added: Photo[] = []
    for (const file of incoming.slice(0, room)) {
      try {
        const decoded = needsDecodedImagePreview(file)
          ? await createDecodedImagePreview(file)
          : null
        const url = decoded?.url ?? URL.createObjectURL(file)
        const size = decoded
          ? { width: decoded.width, height: decoded.height }
          : await probePhotoFile(file, url)
        urlsRef.current.push(url)
        added.push({
          id: `photo-${Date.now()}-${++idRef.current}`,
          file, url, width: size.width, height: size.height,
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : '这张照片打不开，换一张试试。')
      }
    }
    if (added.length) {
      setPhotos(prev => [...prev, ...added])
      clearResult()
    }
  }

  function removePhoto(id: string) {
    const hit = photos.find(photo => photo.id === id)
    if (hit) {
      URL.revokeObjectURL(hit.url)
      urlsRef.current = urlsRef.current.filter(url => url !== hit.url)
    }
    setPhotos(prev => prev.filter(photo => photo.id !== id))
    clearResult()
  }

  function movePhoto(id: string, dir: -1 | 1) {
    const index = photos.findIndex(photo => photo.id === id)
    const target = index + dir
    if (index < 0 || target < 0 || target >= photos.length) return
    const next = [...photos]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item!)
    setPhotos(next)
    clearResult()
  }

  async function run() {
    if (!timeline || busy || photos.length === 0) return
    clearResult()
    setError(null)
    setPhase({ kind: 'render', done: 0, total: timeline.totalFrames })
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const blob = await exportPhotoMovie({
        photos: photos.map(photo => photo.file),
        perPhotoMs,
        motion,
        transition,
        fps,
        aspect,
        adjustments: preset
          ? blendAdjustments(ZERO, preset.adjustments, strength)
          : ZERO,
        music: music ? { file: music, volume: musicVolume } : null,
        signal: controller.signal,
        onProgress: (done, total, stage) => setPhase({ kind: stage, done, total }),
      })
      const url = URL.createObjectURL(blob)
      resultRef.current = url
      setResult({ url, blob, filename: `PinkRose-movie-${stamp()}.mp4` })
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') {
        setError('这次导出已取消，什么都没留下。')
      } else {
        console.error('照片电影没导出', e)
        setError(e instanceof Error ? e.message : '照片电影没导出，再试一次。')
      }
    } finally {
      abortRef.current = null
      setPhase({ kind: 'idle' })
    }
  }

  return (
    <section className="gallery batch-page movie-page" aria-busy={busy}>
      <header className="gallery-head batch-head">
        <button className="batch-back" onClick={onBack} disabled={busy}>
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          作品
        </button>
        <div className="batch-heading">
          <h1 className="gallery-title">照片电影</h1>
          <p>几张照片配上缓慢推拉和音乐，做成一段可以直接发出去的短片。</p>
        </div>
      </header>

      <div className="batch-body">
        <section className="batch-section" aria-labelledby="movie-photos-title">
          <div className="batch-section-head">
            <h2 id="movie-photos-title">照片</h2>
            <span>{photos.length} / {PHOTO_MOVIE_MAX_PHOTOS}</span>
          </div>
          <div className="batch-drop">
            <input
              ref={inputRef}
              className="batch-file-input"
              type="file"
              accept={PHOTO_FILE_ACCEPT}
              multiple
              aria-label="选择要做成电影的照片"
              onChange={(e) => {
                void addPhotos(e.target.files ?? [])
                e.target.value = ''
              }}
            />
            <Film size={22} strokeWidth={1.5} aria-hidden="true" />
            <div className="batch-drop-copy">
              <strong>{photos.length ? '再加几张' : '把照片选进来'}</strong>
              <span>按选择顺序播放；支持 JPG、PNG、WebP、HEIC 和常见 RAW。</span>
            </div>
            <button className="batch-pick" disabled={busy || photos.length >= PHOTO_MOVIE_MAX_PHOTOS}
              onClick={() => inputRef.current?.click()}>
              {photos.length ? '再加几张' : '选照片'}
            </button>
          </div>
          {photos.length > 0 && (
            <ul className="batch-files" aria-label="已选照片">
              {photos.map((photo, index) => (
                <li key={photo.id} className="batch-file-row video-clip">
                  <span className="video-clip-pick">
                    <span className="video-clip-index">{index + 1}</span>
                    <img className="movie-thumb" src={photo.url} alt="" />
                    <span className="batch-file-name" title={photo.file.name}>{photo.file.name}</span>
                  </span>
                  <button type="button" className="batch-remove" aria-label={`上一张 ${index + 1}`}
                    disabled={busy || index === 0} onClick={() => movePhoto(photo.id, -1)}>
                    <span aria-hidden="true">↑</span>
                  </button>
                  <button type="button" className="batch-remove" aria-label={`下一张 ${index + 1}`}
                    disabled={busy || index === photos.length - 1}
                    onClick={() => movePhoto(photo.id, 1)}>
                    <span aria-hidden="true">↓</span>
                  </button>
                  <button type="button" className="batch-remove" aria-label={`移除 ${photo.file.name}`}
                    disabled={busy}
                    onClick={() => removePhoto(photo.id)}>
                    <X size={15} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="batch-section" aria-labelledby="movie-motion-title">
          <div className="batch-section-head">
            <h2 id="movie-motion-title">镜头</h2>
            <span>{timeline ? `全片 ${formatVideoTime(timeline.totalMs)} · ${timeline.totalFrames} 帧` : '先选照片'}</span>
          </div>
          <label className="batch-preset">
            <span>每张</span>
            <input
              type="range"
              aria-label="每张时长"
              min={PHOTO_MOVIE_MIN_MS}
              max={maxMs}
              step={100}
              value={Math.min(perPhotoMs, maxMs)}
              disabled={busy || photos.length === 0}
              onChange={e => { setPerPhotoMs(Number(e.target.value)); clearResult() }}
            />
            <em className="video-time">{(Math.min(perPhotoMs, maxMs) / 1000).toFixed(1)} 秒</em>
          </label>
          <div className="retouch-modes print-options" role="group" aria-label="镜头运动">
            {PHOTO_MOTIONS.map(item => (
              <button key={item.id} type="button"
                className={`crop-chip${motion === item.id ? ' on' : ''}`}
                aria-pressed={motion === item.id}
                disabled={busy}
                onClick={() => { setMotion(item.id); clearResult() }}>
                {item.label}
              </button>
            ))}
          </div>
          <div className="retouch-modes print-options" role="group" aria-label="转场">
            {PHOTO_TRANSITIONS.map(item => (
              <button key={item.id} type="button"
                className={`crop-chip${transition === item.id ? ' on' : ''}`}
                aria-pressed={transition === item.id}
                disabled={busy}
                onClick={() => { setTransition(item.id); clearResult() }}>
                {item.label}
              </button>
            ))}
          </div>
          <label className="batch-preset">
            <span>帧率</span>
            <select value={fps} disabled={busy}
              onChange={e => { setFps(Number(e.target.value) as typeof fps); clearResult() }}>
              {VIDEO_FPS_OPTIONS.map(value => (
                <option key={value} value={value}>{value} fps</option>
              ))}
            </select>
          </label>
          <div className="retouch-modes print-options" role="group" aria-label="电影画幅">
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
            {photos.length > 0
              ? `每张最多 ${(maxMs / 1000).toFixed(1)} 秒；全片上限 ${VIDEO_MAX_SECONDS} 秒。`
              : `全片上限 ${VIDEO_MAX_SECONDS} 秒；照片越多，每张分到的时间越短。`}
          </p>
        </section>

        <section className="batch-section" aria-labelledby="movie-look-title">
          <div className="batch-section-head">
            <h2 id="movie-look-title">调色</h2>
            <span>{preset ? preset.label : '原片'}</span>
          </div>
          <div className="retouch-modes print-options video-presets" role="group" aria-label="电影预设">
            <button type="button"
              className={`crop-chip${presetId === 'none' ? ' on' : ''}`}
              aria-pressed={presetId === 'none'}
              disabled={busy}
              onClick={() => { setPresetId('none'); clearResult() }}>
              原片
            </button>
            {PRESETS.map(item => (
              <button key={item.id} type="button"
                className={`crop-chip${presetId === item.id ? ' on' : ''}`}
                aria-pressed={presetId === item.id}
                disabled={busy}
                onClick={() => { setPresetId(item.id); clearResult() }}>
                {item.label}
              </button>
            ))}
          </div>
          <label className="batch-preset">
            <span>强度</span>
            <input type="range" aria-label="预设强度" min={0} max={100} step={1}
              value={strength} disabled={!preset || busy}
              onChange={e => { setStrength(Number(e.target.value)); clearResult() }} />
            <em className="video-time">{strength}%</em>
          </label>
        </section>

        <section className="batch-section" aria-labelledby="movie-music-title">
          <div className="batch-section-head">
            <h2 id="movie-music-title">配乐</h2>
            <span>{music ? music.name : '不添加'}</span>
          </div>
          <input
            ref={musicRef}
            className="batch-file-input"
            type="file"
            accept={AUDIO_ACCEPT}
            aria-label="选择电影配乐"
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
              clearResult()
            }}
          />
          <div className="crop-tools print-actions video-music-row">
            <button className="batch-pick" disabled={busy}
              onClick={() => musicRef.current?.click()}>
              <Music size={14} strokeWidth={1.5} aria-hidden="true" />
              {music ? '换一首' : '选音乐'}
            </button>
            {music && (
              <button className="crop-btn" disabled={busy}
                onClick={() => { setMusic(null); clearResult() }}>
                移除
              </button>
            )}
            {music && <span className="batch-hint">会循环到全片长度。</span>}
          </div>
          {music && (
            <label className="batch-preset">
              <span>音量</span>
              <input type="range" aria-label="配乐音量" min={0} max={100} step={1}
                value={musicVolume} disabled={busy}
                onChange={e => { setMusicVolume(Number(e.target.value)); clearResult() }} />
              <em className="video-time">{musicVolume}%</em>
            </label>
          )}
        </section>

        <section className="batch-section" aria-labelledby="movie-out-title">
          <div className="batch-section-head">
            <h2 id="movie-out-title">导出</h2>
            <span>{result ? 'MP4 · 带配乐' : timeline ? `${timeline.totalFrames} 帧` : '—'}</span>
          </div>
          {error && <p className="batch-error" role="alert">{error}</p>}
          {busy && (
            <p className="tool-note" role="status">
              {phase.kind === 'encode'
                ? '正在编码 MP4…'
                : `正在逐帧处理 ${phase.done} / ${phase.total}…`}
            </p>
          )}
          {result && <video className="video-preview" src={result.url} controls playsInline />}
          <div className="crop-tools print-actions">
            <Btn className="crop-done" disabled={!timeline || busy}
              onClick={() => void run()}>
              <Sparkles size={14} strokeWidth={1.5} aria-hidden="true" />
              {busy ? '正在导出…' : '导出 MP4'}
            </Btn>
            {busy ? (
              <button className="crop-btn" onClick={() => abortRef.current?.abort()}>取消</button>
            ) : (
              <button className="crop-btn" disabled={!result}
                onClick={() => { if (result) downloadImage(result.blob, result.filename) }}>
                <Download size={14} strokeWidth={1.5} aria-hidden="true" />
                下载成片
              </button>
            )}
          </div>
          <p className="batch-hint">
            逐帧渲染在本机完成；20 秒 24fps 大约 480 帧，导出时可以随时取消。
          </p>
        </section>
      </div>
    </section>
  )
}
