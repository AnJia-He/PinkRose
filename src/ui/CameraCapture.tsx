import {
  useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Camera, Crop, FlipHorizontal, Grid3X3, Mic, RefreshCw, Video, X, Zap,
} from 'lucide-react'
import { Btn } from './kit/Btn.tsx'
import type { Appearance } from '../app/appearance.ts'
import { downloadFile } from '../export/save.ts'
import { VIDEO_MAX_SECONDS } from '../../shared/video.ts'

type Facing = 'environment' | 'user'
type CameraDevice = { deviceId: string; label: string }
type Burst = 1 | 3 | 5
export type CameraFrame = 'native' | '1:1' | '4:5' | '3:4' | '16:9' | '9:16'
type Shot = { file: File; url: string }
type CameraRange = { min: number; max: number; step: number }
type TakePhotoCapture = { takePhoto: () => Promise<Blob> }
type ImageCaptureCtor = new (track: MediaStreamTrack) => TakePhotoCapture
type GuideBox = { left: number; top: number; width: number; height: number }

type Props = {
  open: boolean
  onClose: () => void
  onCapture: (file: File) => void
  /** 连拍结果整组交给批量处理。没有这个口子时仍只能选一张。 */
  onCaptureMany?: (files: File[]) => void
  /** 录好的短视频交给短片调色；没有这个口子时只提供下载。 */
  onRecorded?: (file: File) => void
  appearance?: Appearance
}

const COUNTDOWNS = [0, 3, 5, 10] as const
const CAMERA_FRAMES: readonly { id: CameraFrame; label: string }[] = [
  { id: 'native', label: '原始' },
  { id: '1:1', label: '1:1' },
  { id: '4:5', label: '4:5' },
  { id: '3:4', label: '3:4' },
  { id: '16:9', label: '16:9' },
  { id: '9:16', label: '9:16' },
]
const DEVICE_KEY = 'pinkrose.camera.device'
const FRAME_KEY = 'pinkrose.camera.frame'

function savedDevice(): string {
  try { return localStorage.getItem(DEVICE_KEY) ?? '' } catch { return '' }
}

function rememberDevice(deviceId: string): void {
  try {
    if (deviceId) localStorage.setItem(DEVICE_KEY, deviceId)
    else localStorage.removeItem(DEVICE_KEY)
  } catch {
    // 隐私模式 / 禁用存储：不影响本次拍摄。
  }
}

function savedFrame(): CameraFrame {
  try {
    const value = localStorage.getItem(FRAME_KEY)
    return CAMERA_FRAMES.some(frame => frame.id === value) ? value as CameraFrame : 'native'
  } catch {
    return 'native'
  }
}

function rememberFrame(frame: CameraFrame): void {
  try {
    if (frame === 'native') localStorage.removeItem(FRAME_KEY)
    else localStorage.setItem(FRAME_KEY, frame)
  } catch {
    // 隐私模式 / 禁用存储：不影响本次拍摄。
  }
}

function errorText(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '相机权限被拒绝了。到浏览器的相机权限里允许，再试一次。'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return '没找到可用的相机。接上 USB 相机或换一个摄像头，再试一次。'
  }
  if (name === 'NotReadableError') {
    return '相机被别的应用占用了。先关掉其他相机应用，再试一次。'
  }
  return '相机没打开。检查一下浏览器权限，或者先用系统拍照。'
}

function fileStamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}

export function cameraFrameAspect(frame: CameraFrame): number | null {
  switch (frame) {
    case '1:1': return 1
    case '4:5': return 4 / 5
    case '3:4': return 3 / 4
    case '16:9': return 16 / 9
    case '9:16': return 9 / 16
    default: return null
  }
}

/** 居中等比裁切；尺寸至少保留 1px，原生画幅不改。 */
export function cameraFrameRect(
  width: number,
  height: number,
  frame: CameraFrame,
): { x: number; y: number; w: number; h: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('相机画面尺寸无效')
  }
  const w = Math.round(width)
  const h = Math.round(height)
  const target = cameraFrameAspect(frame)
  if (!target) return { x: 0, y: 0, w, h }
  const source = w / h
  if (source > target) {
    const cw = Math.max(1, Math.min(w, Math.round(h * target)))
    return { x: Math.floor((w - cw) / 2), y: 0, w: cw, h }
  }
  const ch = Math.max(1, Math.min(h, Math.round(w / target)))
  return { x: 0, y: Math.floor((h - ch) / 2), w, h: ch }
}

/**
 * 全分辨率静态照只在实际需要时重绘：原生画幅且不镜像时保留浏览器给的
 * 原始 Blob，不无谓压缩一次；选了画幅或镜像才裁切 / 翻转后重编成 JPEG。
 */
async function frameCameraBlob(
  source: Blob,
  frame: CameraFrame,
  mirror: boolean,
): Promise<Blob> {
  if (frame === 'native' && !mirror) return source
  const bitmap = await createImageBitmap(source)
  try {
    const rect = cameraFrameRect(bitmap.width, bitmap.height, frame)
    const canvas = document.createElement('canvas')
    canvas.width = rect.w
    canvas.height = rect.h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('拿不到相机画布')
    if (mirror) {
      ctx.translate(canvas.width, 0)
      ctx.scale(-1, 1)
    }
    ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
    const out = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', 0.95)
    })
    if (!out) throw new Error('相机图编不出来')
    return out
  } finally {
    bitmap.close()
  }
}

function cameraLabel(label: string, index: number): string {
  return label.trim() || `相机 ${index + 1}`
}

function cameraRange(value: unknown): CameraRange | null {
  if (!value || typeof value !== 'object') return null
  const r = value as { min?: unknown; max?: unknown; step?: unknown }
  if (typeof r.min !== 'number' || typeof r.max !== 'number'
    || !Number.isFinite(r.min) || !Number.isFinite(r.max) || r.max <= r.min) return null
  return {
    min: r.min,
    max: r.max,
    step: typeof r.step === 'number' && r.step > 0 ? r.step : 0.1,
  }
}

function inRange(value: unknown, range: CameraRange): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : range.min
  return Math.max(range.min, Math.min(range.max, n))
}

/**
 * 实时相机取景（★ 2026-10-18，用户补充：后续要能接入真实拍摄的相机）。
 *
 * 走浏览器标准的 `getUserMedia`：内置摄像头、USB/UVC 相机、采集卡等
 * **浏览器能看见**的相机都能在设备下拉里选到。真正的单反遥控 / 厂商 SDK
 * 不在纯 Web 能力里，需要另做一个原生桥；这里先把"实时取景 + 快门"做好。
 *
 * ⚠️ `getUserMedia` 只在 HTTPS 或 localhost 下可用；手机用局域网 IP 打开时
 *   浏览器会直接禁用相机，所以失败提示必须给出系统拍照的退路。
 * ⚠️ 关窗 / 卸载必须停掉所有 track，否则相机指示灯会一直亮。
 */
export default function CameraCapture({
  open, onClose, onCapture, onCaptureMany, onRecorded, appearance = 'dark',
}: Props) {
  const [devices, setDevices] = useState<CameraDevice[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [facing, setFacing] = useState<Facing>('environment')
  const [mirror, setMirror] = useState(false)
  const [grid, setGrid] = useState(true)
  const [frame, setFrame] = useState<CameraFrame>(savedFrame)
  const [countdown, setCountdown] = useState<0 | 3 | 5 | 10>(0)
  const [burst, setBurst] = useState<Burst>(1)
  const [shots, setShots] = useState<Shot[]>([])
  const [remaining, setRemaining] = useState<number | null>(null)
  const [ready, setReady] = useState(false)
  const [guide, setGuide] = useState<GuideBox | null>(null)
  const [busy, setBusy] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [torchAvailable, setTorchAvailable] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordMs, setRecordMs] = useState(0)
  const [recorded, setRecorded] = useState<{ url: string; file: File } | null>(null)
  const [recordError, setRecordError] = useState<string | null>(null)
  const [recordNote, setRecordNote] = useState<string | null>(null)
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null)
  const [focusNote, setFocusNote] = useState<string | null>(null)
  const [recordAudio, setRecordAudio] = useState(true)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordChunksRef = useRef<Blob[]>([])
  const recordTimerRef = useRef<number | null>(null)
  const recordDrawRef = useRef<number | null>(null)
  const recordCanvasRef = useRef<MediaStream | null>(null)
  const recordStartRef = useRef(0)
  const countdownCancelRef = useRef(false)
  const recordedUrlRef = useRef<string | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const [zoomCaps, setZoomCaps] = useState<{ min: number; max: number; step: number } | null>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  const [exposureCaps, setExposureCaps] = useState<CameraRange | null>(null)
  const [exposure, setExposure] = useState<number | null>(null)
  const [focusCaps, setFocusCaps] = useState<CameraRange | null>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const [flash, setFlash] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const pinchRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchStartRef = useRef<{ distance: number; zoom: number } | null>(null)
  const tapRef = useRef<{
    pointerId: number; x: number; y: number; moved: boolean
  } | null>(null)
  const zoomApplyTimerRef = useRef<number | null>(null)
  const focusTimerRef = useRef<number | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const shotsRef = useRef<Shot[]>([])
  const openRef = useRef(open)
  const mountedRef = useRef(true)

  openRef.current = open
  shotsRef.current = shots

  const clearShots = useCallback(() => {
    for (const shot of shotsRef.current) URL.revokeObjectURL(shot.url)
    shotsRef.current = []
    setShots([])
  }, [])

  const stopRecordedCanvas = useCallback(() => {
    if (recordDrawRef.current !== null) {
      cancelAnimationFrame(recordDrawRef.current)
      recordDrawRef.current = null
    }
    const held = recordCanvasRef.current
    recordCanvasRef.current = null
    for (const track of held?.getTracks() ?? []) track.stop()
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const recorder = recorderRef.current
      recorderRef.current = null
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      stopMic()
      if (recordTimerRef.current !== null) {
        clearInterval(recordTimerRef.current)
        recordTimerRef.current = null
      }
      stopRecordedCanvas()
      if (recordedUrlRef.current) {
        URL.revokeObjectURL(recordedUrlRef.current)
        recordedUrlRef.current = null
      }
      const stream = streamRef.current
      streamRef.current = null
      for (const track of stream?.getTracks() ?? []) track.stop()
      clearShots()
    }
  }, [clearShots, stopRecordedCanvas])

  const stopStream = useCallback(() => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    stopMic()
    if (recordTimerRef.current !== null) {
      clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
    if (zoomApplyTimerRef.current !== null) {
      clearTimeout(zoomApplyTimerRef.current)
      zoomApplyTimerRef.current = null
    }
    if (focusTimerRef.current !== null) {
      clearTimeout(focusTimerRef.current)
      focusTimerRef.current = null
    }
    pinchRef.current.clear()
    pinchStartRef.current = null
    tapRef.current = null
    stopRecordedCanvas()
    setRecording(false)
    const stream = streamRef.current
    streamRef.current = null
    for (const track of stream?.getTracks() ?? []) track.stop()
    if (videoRef.current) videoRef.current.srcObject = null
    setReady(false)
    setTorchAvailable(false)
    setTorchOn(false)
    setZoomCaps(null)
    setZoom(null)
    setExposureCaps(null)
    setExposure(null)
    setFocusCaps(null)
    setFocus(null)
    setFocusPoint(null)
    setFocusNote(null)
  }, [stopRecordedCanvas])

  const startStream = useCallback(async (nextDeviceId?: string, nextFacing?: Facing) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('实时相机需要 HTTPS 或 localhost。手机用局域网地址打开时请换 HTTPS，或先用系统拍照。')
      return
    }
    setBusy(true)
    setError(null)
    stopStream()
    const wantDevice = nextDeviceId ?? (deviceId || savedDevice())
    const wantFacing = nextFacing ?? facing
    try {
      const videoConstraints: MediaTrackConstraints = wantDevice
        ? { deviceId: { exact: wantDevice }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: { ideal: wantFacing }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints })
      if (!mountedRef.current || !openRef.current) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      streamRef.current = stream
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        await video.play().catch(() => {})
        await new Promise<void>(resolve => {
          if (video.videoWidth > 0) { resolve(); return }
          const done = () => {
            video.removeEventListener('loadedmetadata', done)
            resolve()
          }
          video.addEventListener('loadedmetadata', done)
          setTimeout(done, 1500)
        })
      }
      const track = stream.getVideoTracks()[0]
      const caps = track?.getCapabilities?.() as (
        MediaTrackCapabilities
        & {
          torch?: boolean
          zoom?: { min: number; max: number; step?: number }
          exposureCompensation?: unknown
          focusDistance?: unknown
        }
      ) | undefined
      setTorchAvailable(!!caps?.torch)
      const settings = track?.getSettings?.() as (
        MediaTrackSettings
        & { zoom?: number; exposureCompensation?: number; focusDistance?: number }
      ) | undefined
      if (settings?.deviceId && !nextDeviceId) setDeviceId(settings.deviceId)
      const z = caps?.zoom
      if (z && Number.isFinite(z.min) && Number.isFinite(z.max) && z.max > z.min) {
        const step = z.step && z.step > 0 ? z.step : 0.1
        setZoomCaps({ min: z.min, max: z.max, step })
        const current = (settings as MediaTrackSettings & { zoom?: number } | undefined)?.zoom
        setZoom(typeof current === 'number' ? current : z.min)
      } else {
        setZoomCaps(null)
        setZoom(null)
      }
      const exp = cameraRange(caps?.exposureCompensation)
      if (exp) {
        setExposureCaps(exp)
        setExposure(inRange(settings?.exposureCompensation, exp))
      } else {
        setExposureCaps(null)
        setExposure(null)
      }
      const focusRange = cameraRange(caps?.focusDistance)
      if (focusRange) {
        setFocusCaps(focusRange)
        setFocus(inRange(settings?.focusDistance, focusRange))
      } else {
        setFocusCaps(null)
        setFocus(null)
      }
      const listed = await navigator.mediaDevices.enumerateDevices()
      if (mountedRef.current) {
        setDevices(listed
          .filter(d => d.kind === 'videoinput')
          .map((d, i) => ({ deviceId: d.deviceId, label: cameraLabel(d.label, i) })))
      }
      setReady(video ? video.videoWidth > 0 : false)
      if (video && video.videoWidth <= 0) {
        setError('相机已连上，但还没有取到画面。稍等一下再按拍照，或换一个相机。')
      }
    } catch (e) {
      const name = e instanceof DOMException ? e.name : ''
      if (wantDevice && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
        rememberDevice('')
        if (mountedRef.current) {
          setBusy(false)
          void startStream(undefined, facing)
        }
        return
      }
      if (mountedRef.current) {
        setError(errorText(e))
        setReady(false)
      }
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [deviceId, facing, stopStream])

  useEffect(() => {
    const md = navigator.mediaDevices
    if (!open || !md?.addEventListener) return
    let alive = true
    const refresh = async () => {
      try {
        const listed = await md.enumerateDevices()
        if (!alive) return
        const cams = listed
          .filter(d => d.kind === 'videoinput')
          .map((d, i) => ({ deviceId: d.deviceId, label: cameraLabel(d.label, i) }))
        setDevices(cams)
        if (deviceId && !cams.some(c => c.deviceId === deviceId)) {
          rememberDevice('')
          setError('相机已断开。接回后会自动重连；也可以重新选择设备。')
          void startStream(undefined, facing)
        }
      } catch {
        // 枚举失败不打断正在跑的取景。
      }
    }
    md.addEventListener('devicechange', refresh)
    return () => {
      alive = false
      md.removeEventListener('devicechange', refresh)
    }
  }, [open, deviceId, facing, startStream])

  useEffect(() => {
    if (!open) {
      stopStream()
      setDevices([])
      setError(null)
      setRemaining(null)
      setGuide(null)
      setRecordNote(null)
      clearShots()
      return
    }
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    void startStream()
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
      stopStream()
    }
    // 只在开/关时启动；换相机的重启由按钮手动触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open || !ready || frame === 'native') {
      setGuide(null)
      return
    }
    const stage = stageRef.current
    const video = videoRef.current
    if (!stage || !video) return

    const update = () => {
      const stageW = stage.clientWidth
      const stageH = stage.clientHeight
      const videoW = video.videoWidth
      const videoH = video.videoHeight
      if (stageW <= 0 || stageH <= 0 || videoW <= 0 || videoH <= 0) return
      const scale = Math.min(stageW / videoW, stageH / videoH)
      const contentW = videoW * scale
      const contentH = videoH * scale
      const contentLeft = (stageW - contentW) / 2
      const contentTop = (stageH - contentH) / 2
      const crop = cameraFrameRect(
        Math.max(1, Math.round(contentW)),
        Math.max(1, Math.round(contentH)),
        frame,
      )
      setGuide({
        left: contentLeft + crop.x,
        top: contentTop + crop.y,
        width: crop.w,
        height: crop.h,
      })
    }

    update()
    video.addEventListener('loadedmetadata', update)
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(update)
      : null
    observer?.observe(stage)
    if (!observer) window.addEventListener('resize', update)
    return () => {
      video.removeEventListener('loadedmetadata', update)
      observer?.disconnect()
      if (!observer) window.removeEventListener('resize', update)
    }
  }, [open, ready, frame])

  async function snapFile(index = 0): Promise<File | null> {
    const video = videoRef.current
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setError('相机还没准备好，再等一下。')
      return null
    }
    setFlash(true)
    setTimeout(() => { if (mountedRef.current) setFlash(false) }, 180)

    const track = streamRef.current?.getVideoTracks()[0]
    const Ctor = (globalThis as typeof globalThis & { ImageCapture?: ImageCaptureCtor }).ImageCapture
    if (track && Ctor) {
      try {
        const capture = new Ctor(track)
        const shot = await capture.takePhoto()
        if (shot.size > 0) {
          const blob = await frameCameraBlob(shot, frame, mirror)
          const ext = blob.type === 'image/png' ? 'png' : 'jpg'
          const suffix = burst > 1 ? `-${index + 1}` : ''
          return new File(
            [blob],
            `camera-${fileStamp()}${suffix}.${ext}`,
            { type: blob.type || 'image/jpeg' },
          )
        }
      } catch (e) {
        // 有些浏览器暴露 ImageCapture 但设备不支持 takePhoto；静默回退到预览帧。
        console.warn('全分辨率拍照不可用，改用预览帧', e)
      }
    }

    const w = video.videoWidth
    const h = video.videoHeight
    const rect = cameraFrameRect(w, h, frame)
    const canvas = document.createElement('canvas')
    canvas.width = rect.w
    canvas.height = rect.h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setError('这一下没取到画面，再试一次。')
      return null
    }
    if (mirror) {
      ctx.translate(canvas.width, 0)
      ctx.scale(-1, 1)
    }
    ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', 0.95)
    })
    if (!blob) {
      setError('这一下没取到画面，再试一次。')
      return null
    }
    const suffix = burst > 1 ? `-${index + 1}` : ''
    return new File([blob], `camera-${fileStamp()}${suffix}.jpg`, { type: 'image/jpeg' })
  }

  async function beginCapture() {
    if (!ready || busy || capturing) return
    countdownCancelRef.current = false
    setCapturing(true)
    setError(null)
    clearShots()
    try {
      if (countdown > 0) {
        for (let n = countdown; n > 0; n--) {
          if (!openRef.current || countdownCancelRef.current) return
          setRemaining(n)
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        if (countdownCancelRef.current) return
        setRemaining(null)
      }
      if (burst === 1) {
        const file = await snapFile()
        if (file) onCapture(file)
      } else {
        const taken: Shot[] = []
        for (let i = 0; i < burst; i++) {
          if (!openRef.current) return
          const file = await snapFile(i)
          if (!file) break
          const shot = { file, url: URL.createObjectURL(file) }
          taken.push(shot)
          setShots([...taken])
          if (i < burst - 1) {
            await new Promise(resolve => setTimeout(resolve, 220))
          }
        }
      }
    } finally {
      countdownCancelRef.current = false
      if (mountedRef.current) setCapturing(false)
    }
  }

  function cancelCountdown() {
    if (!capturing || remaining === null) return
    countdownCancelRef.current = true
    setRemaining(null)
  }

  function clearRecorded() {
    if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
    recordedUrlRef.current = null
    setRecorded(null)
    setRecordMs(0)
  }

  /**
   * 浏览器支持的录像容器里挑一个。
   *
   * ⚠️ **WebM 排在 MP4 前面**：Chromium 对 `video/mp4;codecs=h264` 的
   * `isTypeSupported` 会回答 true，但实际录出来是 **VP9 装在 MP4 里** ——
   * 连它自己都播不了（2026-10-20 实测：ffprobe 认 vp9/mp4，`<video>` 直接 error）。
   * Safari 不支持 WebM，自然落到 MP4（那才是真的 H.264）。
   */
  function recorderMime(): string | null {
    if (typeof MediaRecorder === 'undefined') return null
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4;codecs=h264',
      'video/mp4',
    ]
    return candidates.find(type => {
      try { return MediaRecorder.isTypeSupported(type) } catch { return false }
    }) ?? null
  }

  function stopMic() {
    const mic = micStreamRef.current
    micStreamRef.current = null
    for (const track of mic?.getTracks() ?? []) track.stop()
  }

  async function startRecording() {
    const stream = streamRef.current
    if (!ready || !stream || recording) return
    const mime = recorderMime()
    if (!mime) {
      setRecordError('这台浏览器不支持录像；先用系统相机拍视频，再回来导入。')
      return
    }
    stopRecordedCanvas()
    let recordStream: MediaStream = stream
    setRecordNote(null)
    if (frame !== 'native' || mirror) {
      const sourceVideo = videoRef.current
      const canvasSupported = typeof document.createElement('canvas').captureStream === 'function'
      if (!sourceVideo || !canvasSupported) {
        setRecordNote('这个浏览器不能把画幅套到录像；本次录像保留相机原始构图。')
      } else {
        try {
          const target = cameraFrameRect(sourceVideo.videoWidth, sourceVideo.videoHeight, frame)
          const canvas = document.createElement('canvas')
          canvas.width = target.w
          canvas.height = target.h
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('拿不到录像画布')
          if (mirror) {
            ctx.translate(canvas.width, 0)
            ctx.scale(-1, 1)
          }
          const paint = () => {
            if (!openRef.current) return
            ctx.drawImage(
              sourceVideo,
              target.x, target.y, target.w, target.h,
              0, 0, target.w, target.h,
            )
            recordDrawRef.current = requestAnimationFrame(paint)
          }
          paint()
          const canvasStream = canvas.captureStream(30)
          recordCanvasRef.current = canvasStream
          recordStream = new MediaStream(canvasStream.getVideoTracks())
        } catch (error) {
          console.warn('录像画布不可用，改用相机原始画面', error)
          stopRecordedCanvas()
          recordStream = stream
          setRecordNote('这个浏览器不能把画幅套到录像；本次录像保留相机原始构图。')
        }
      }
    }
    if (recordAudio) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
        micStreamRef.current = mic
        recordStream = new MediaStream([
          ...recordStream.getVideoTracks(),
          ...mic.getAudioTracks(),
        ])
      } catch {
        setRecordError('没拿到麦克风权限，这段录像只录画面。')
      }
    }
    if (!streamRef.current || !openRef.current) {
      stopMic()
      return
    }
    try {
      const recorder = new MediaRecorder(recordStream, {
        mimeType: mime,
        videoBitsPerSecond: 6_000_000,
      })
      recordChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        if (!mountedRef.current) return
        stopMic()
        const type = mime.split(';')[0]!
        const ext = type === 'video/mp4' ? 'mp4' : 'webm'
        stopRecordedCanvas()
        const blob = new Blob(recordChunksRef.current, { type })
        recordChunksRef.current = []
        if (blob.size === 0) {
          setRecordError('这段录像没存下来，再试一次。')
          setRecording(false)
          return
        }
        const file = new File([blob], `PinkRose-camera-${fileStamp()}.${ext}`, { type })
        const url = URL.createObjectURL(blob)
        if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current)
        recordedUrlRef.current = url
        setRecorded({ url, file })
        setRecording(false)
        if (recordTimerRef.current !== null) {
          clearInterval(recordTimerRef.current)
          recordTimerRef.current = null
        }
      }
      clearRecorded()
      setRecordError(null)
      recorder.start(250)
      recorderRef.current = recorder
      recordStartRef.current = Date.now()
      setRecordMs(0)
      setRecording(true)
      recordTimerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - recordStartRef.current
        setRecordMs(elapsed)
        if (elapsed >= VIDEO_MAX_SECONDS * 1000) stopRecording()
      }, 200)
    } catch (e) {
      console.error('录像没开起来', e)
      stopRecordedCanvas()
      setRecordError('录像没开起来；这台设备可能不支持浏览器录像。')
      setRecording(false)
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    if (recordTimerRef.current !== null) {
      clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
  }

  function useRecorded() {
    if (!recorded) return
    const file = recorded.file
    clearRecorded()
    onRecorded?.(file)
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    const next = !torchOn
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      setTorchOn(next)
    } catch {
      setTorchAvailable(false)
    }
  }

  async function applyZoom(value: number) {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      await track.applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] })
      setZoom(value)
    } catch {
      setZoomCaps(null)
    }
  }

  function queuePinchZoom(value: number) {
    if (!zoomCaps) return
    const next = Math.max(zoomCaps.min, Math.min(zoomCaps.max, value))
    setZoom(next)
    if (zoomApplyTimerRef.current !== null) clearTimeout(zoomApplyTimerRef.current)
    zoomApplyTimerRef.current = window.setTimeout(() => {
      zoomApplyTimerRef.current = null
      void applyZoom(next)
    }, 40)
  }

  function pointerDistance(): number | null {
    const points = [...pinchRef.current.values()]
    if (points.length !== 2) return null
    return Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y)
  }

  function onCameraPointerDown(e: ReactPointerEvent<HTMLVideoElement>) {
    if (recording) return
    if (!tapRef.current) {
      tapRef.current = {
        pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false,
      }
    }
    if (zoomCaps && e.pointerType !== 'mouse') {
      pinchRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pinchRef.current.size === 2) {
        tapRef.current = null
        const distance = pointerDistance()
        if (distance && distance > 0) {
          pinchStartRef.current = { distance, zoom: zoom ?? zoomCaps.min }
          e.currentTarget.setPointerCapture?.(e.pointerId)
        }
      }
    }
  }

  function onCameraPointerMove(e: ReactPointerEvent<HTMLVideoElement>) {
    const tap = tapRef.current
    if (tap?.pointerId === e.pointerId
      && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) {
      tap.moved = true
      tapRef.current = null
    }
    if (zoomCaps && pinchRef.current.has(e.pointerId)) {
      pinchRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const start = pinchStartRef.current
      const distance = pointerDistance()
      if (start && distance) {
        e.preventDefault()
        queuePinchZoom(start.zoom * distance / start.distance)
      }
    }
  }

  function onCameraPointerEnd(e: ReactPointerEvent<HTMLVideoElement>) {
    const tap = tapRef.current
    if (tap?.pointerId === e.pointerId && !tap.moved && !pinchStartRef.current) {
      void focusAtPoint(e.clientX, e.clientY)
    }
    if (tap?.pointerId === e.pointerId) tapRef.current = null
    pinchRef.current.delete(e.pointerId)
    if (pinchRef.current.size < 2) pinchStartRef.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    }
  }

  async function focusAtPoint(clientX: number, clientY: number) {
    const video = videoRef.current
    const stage = stageRef.current
    const track = streamRef.current?.getVideoTracks()[0]
    if (!video || !stage || !track || video.videoWidth <= 0 || video.videoHeight <= 0) return
    const rect = video.getBoundingClientRect()
    const stageRect = stage.getBoundingClientRect()
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight)
    const contentWidth = video.videoWidth * scale
    const contentHeight = video.videoHeight * scale
    const contentLeft = rect.left + (rect.width - contentWidth) / 2
    const contentTop = rect.top + (rect.height - contentHeight) / 2
    let nx = (clientX - contentLeft) / contentWidth
    const ny = (clientY - contentTop) / contentHeight
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return
    if (mirror) nx = 1 - nx

    try {
      await track.applyConstraints({
        advanced: [{
          pointsOfInterest: [{ x: nx, y: ny }],
          focusMode: 'single-shot',
        } as MediaTrackConstraintSet],
      })
      const settings = track.getSettings() as MediaTrackSettings & {
        focusDistance?: number
      }
      if (typeof settings.focusDistance === 'number') setFocus(settings.focusDistance)
      setFocusNote(null)
      setFocusPoint({
        x: clientX - stageRect.left,
        y: clientY - stageRect.top,
      })
      if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current)
      focusTimerRef.current = window.setTimeout(() => {
        focusTimerRef.current = null
        if (mountedRef.current) setFocusPoint(null)
      }, 1100)
    } catch {
      setFocusPoint(null)
      setFocusNote('这个相机不支持点按对焦，请用下方「对焦」滑杆。')
    }
  }

  async function applyExposure(value: number) {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      await track.applyConstraints({
        advanced: [{ exposureCompensation: value } as MediaTrackConstraintSet],
      })
      setExposure(value)
    } catch {
      setExposureCaps(null)
    }
  }

  async function applyFocus(value: number) {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      await track.applyConstraints({
        advanced: [{ focusDistance: value } as MediaTrackConstraintSet],
      })
      setFocus(value)
    } catch {
      setFocusCaps(null)
    }
  }

  function switchFacing() {
    const next: Facing = facing === 'environment' ? 'user' : 'environment'
    setFacing(next)
    setMirror(next === 'user')
    setDeviceId('')
    rememberDevice('')
    void startStream(undefined, next)
  }

  if (!open || typeof document === 'undefined') return null

  const targetAspect = cameraFrameAspect(frame)

  return createPortal(
    <div className="camera-dialog" data-theme={appearance}
         role="dialog" aria-modal="true" aria-labelledby="camera-title">
      <div className="camera-panel">
        <header className="camera-head">
          <div>
            <h2 id="camera-title">实时相机</h2>
            <p>内置 / USB / UVC 相机都能选；按快门优先取全分辨率静态照，不支持时用预览帧。</p>
          </div>
          <button ref={closeRef} type="button" className="camera-close"
                  aria-label="关闭相机" onClick={onClose}>
            <X size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </header>

        <div ref={stageRef} className="camera-stage">
          <video
            ref={videoRef}
            className={`camera-video${mirror ? ' mirror' : ''}${zoomCaps ? ' zoomable' : ''}`}
            autoPlay playsInline muted aria-label="相机预览"
            onPointerDown={onCameraPointerDown}
            onPointerMove={onCameraPointerMove}
            onPointerUp={onCameraPointerEnd}
            onPointerCancel={onCameraPointerEnd}
          />
          {targetAspect && guide ? (
            <div className="camera-frame-guide" style={guide}
                 aria-label={`取景画幅 ${frame}`}>
              {grid && (
                <div className="camera-grid" aria-hidden="true">
                  <i /><i /><i /><i />
                </div>
              )}
              <span>{CAMERA_FRAMES.find(item => item.id === frame)?.label}</span>
            </div>
          ) : grid && (
            <div className="camera-grid" aria-hidden="true">
              <i /><i /><i /><i />
            </div>
          )}
          {flash && <div className="camera-flash" aria-hidden="true" />}
          {focusPoint && (
            <div
              className="camera-focus-point"
              style={{ left: focusPoint.x, top: focusPoint.y }}
              aria-hidden="true"
            />
          )}
          {remaining !== null && <div className="camera-count" aria-live="polite">{remaining}</div>}
          {recording && (
            <div className="camera-rec-badge" aria-live="polite">
              ● {Math.floor(recordMs / 60000)}:{String(Math.floor(recordMs / 1000) % 60).padStart(2, '0')}
              {' / '}
              {VIDEO_MAX_SECONDS}s
            </div>
          )}
          {!ready && (
            <div className="camera-state" aria-live="polite">
              {busy ? '正在打开相机…' : error ?? '正在准备相机…'}
            </div>
          )}
        </div>

        <div className="camera-controls">
          {devices.length > 0 && (
            <label className="camera-device">
              <span>相机</span>
              <select
                value={deviceId}
                aria-label="选择相机"
                disabled={busy || capturing}
                onChange={e => {
                  setDeviceId(e.target.value)
                  rememberDevice(e.target.value)
                  void startStream(e.target.value)
                }}
              >
                {devices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
            </label>
          )}
          <div className="camera-toggles" role="group" aria-label="取景工具">
            <button type="button" className={`crop-chip${mirror ? ' on' : ''}`}
                    aria-pressed={mirror} onClick={() => setMirror(v => !v)}>
              <FlipHorizontal size={14} strokeWidth={1.5} aria-hidden="true" />镜像
            </button>
            <button type="button" className={`crop-chip${grid ? ' on' : ''}`}
                    aria-pressed={grid} onClick={() => setGrid(v => !v)}>
              <Grid3X3 size={14} strokeWidth={1.5} aria-hidden="true" />网格
            </button>
            <span className="camera-timer-label" aria-hidden="true">
              <Crop size={14} strokeWidth={1.5} />画幅
            </span>
            {CAMERA_FRAMES.map(item => (
              <button key={item.id} type="button"
                      className={`crop-chip${frame === item.id ? ' on' : ''}`}
                      aria-pressed={frame === item.id}
                      disabled={capturing || recording}
                      onClick={() => {
                        setFrame(item.id)
                        rememberFrame(item.id)
                      }}>
                {item.label}
              </button>
            ))}
            <button type="button" className="crop-chip" onClick={switchFacing} disabled={busy}>
              <RefreshCw size={14} strokeWidth={1.5} aria-hidden="true" />前 / 后
            </button>
            <button type="button" className={`crop-chip${recordAudio ? ' on' : ''}`}
                    aria-pressed={recordAudio}
                    aria-label="录制声音"
                    disabled={recording}
                    onClick={() => setRecordAudio(v => !v)}>
              <Mic size={14} strokeWidth={1.5} aria-hidden="true" />声音
            </button>
            {torchAvailable && (
              <button type="button" className={`crop-chip${torchOn ? ' on' : ''}`}
                      aria-pressed={torchOn} onClick={() => void toggleTorch()}>
                <Zap size={14} strokeWidth={1.5} aria-hidden="true" />补光
              </button>
            )}
            <span className="camera-timer-label" aria-hidden="true">
              <Camera size={14} strokeWidth={1.5} />连拍
            </span>
            {([1, 3, 5] as const).map(n => (
              <button key={n} type="button"
                      className={`crop-chip${burst === n ? ' on' : ''}`}
                      aria-pressed={burst === n}
                      disabled={capturing || shots.length > 0}
                      onClick={() => setBurst(n)}>
                {n === 1 ? '单张' : `${n} 张`}
              </button>
            ))}
            <span className="camera-timer-label" aria-hidden="true">
              <Video size={14} strokeWidth={1.5} />倒计时
            </span>
            {COUNTDOWNS.map(n => (
              <button key={n} type="button"
                      className={`crop-chip${countdown === n ? ' on' : ''}`}
                      aria-pressed={countdown === n}
                      onClick={() => setCountdown(n)}>
                {n === 0 ? '即时' : `${n} 秒`}
              </button>
            ))}
          </div>
          {zoomCaps && (
            <label className="camera-zoom">
              <span>变焦</span>
              <input
                type="range"
                min={zoomCaps.min}
                max={zoomCaps.max}
                step={zoomCaps.step}
                value={zoom ?? zoomCaps.min}
                disabled={busy || capturing}
                aria-label="相机变焦"
                onChange={e => void applyZoom(Number(e.target.value))}
              />
              <span>{(zoom ?? zoomCaps.min).toFixed(1)}×</span>
            </label>
          )}
          {exposureCaps && (
            <label className="camera-zoom">
              <span>曝光</span>
              <input
                type="range"
                min={exposureCaps.min}
                max={exposureCaps.max}
                step={exposureCaps.step}
                value={exposure ?? exposureCaps.min}
                disabled={busy || capturing}
                aria-label="相机曝光补偿"
                onChange={e => void applyExposure(Number(e.target.value))}
              />
              <span>{(() => {
                const v = exposure ?? exposureCaps.min
                return `${v > 0 ? '+' : ''}${v.toFixed(2)}`
              })()}</span>
            </label>
          )}
          {focusCaps && (
            <label className="camera-zoom">
              <span>对焦</span>
              <input
                type="range"
                min={focusCaps.min}
                max={focusCaps.max}
                step={focusCaps.step}
                value={focus ?? focusCaps.min}
                disabled={busy || capturing}
                aria-label="相机对焦"
                onChange={e => void applyFocus(Number(e.target.value))}
              />
              <span>{(focus ?? focusCaps.min).toFixed(2)}m</span>
            </label>
          )}
          {error && (
            <p className="camera-error" role="alert">
              {error}
              <button type="button" onClick={() => void startStream(deviceId || undefined)}>
                再试一次
              </button>
            </p>
          )}
          {shots.length > 0 && (
            <div className="camera-review" aria-label="连拍结果">
              <div className="camera-review-head">
                <strong>选一张用</strong>
                <div className="camera-review-actions">
                  {onCaptureMany && shots.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        const files = shots.map(shot => shot.file)
                        clearShots()
                        onCaptureMany(files)
                      }}
                    >全部送入批量</button>
                  )}
                  <button type="button" onClick={clearShots}>重拍</button>
                </div>
              </div>
              <div className="camera-shots">
                {shots.map((shot, index) => (
                  <button key={shot.url} type="button" className="camera-shot"
                          aria-label={`用第 ${index + 1} 张`}
                          onClick={() => {
                            clearShots()
                            onCapture(shot.file)
                          }}>
                    <img src={shot.url} alt="" />
                    <span>{index + 1}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {recorded && (
            <div className="camera-review" aria-label="录像结果">
              <div className="camera-review-head">
                <strong>录好了</strong>
                <div className="camera-review-actions">
                  <button type="button" onClick={clearRecorded}>重录</button>
                </div>
              </div>
              <video className="camera-recorded" src={recorded.url} controls playsInline />
              <div className="camera-review-actions">
                {onRecorded && (
                  <Btn className="crop-done" onClick={useRecorded}>
                    用短片调色打开
                  </Btn>
                )}
                <button type="button"
                  onClick={() => downloadFile(recorded.file, recorded.file.name)}>
                  下载
                </button>
              </div>
            </div>
          )}
          {recordNote && <p className="camera-note" role="status">{recordNote}</p>}
          {focusNote && <p className="camera-note" role="status">{focusNote}</p>}
          {recordError && <p className="camera-error" role="alert">{recordError}</p>}
          <div className="camera-actions">
            {capturing && remaining !== null && (
              <button
                type="button"
                className="camera-record-btn"
                aria-label="取消倒计时"
                onClick={cancelCountdown}
              >取消倒计时</button>
            )}
            <Btn className={`camera-record-btn${recording ? ' on' : ''}`}
                 disabled={!ready || busy || capturing || shots.length > 0 || !!recorded}
                 onClick={() => { if (recording) stopRecording(); else startRecording() }}>
              <Video size={16} strokeWidth={1.5} aria-hidden="true" />
              {recording ? '停止录像' : '录像'}
            </Btn>
            <Btn className="camera-shutter"
                 disabled={!ready || busy || capturing || recording || shots.length > 0 || !!recorded}
                 onClick={() => void beginCapture()}>
              <Camera size={16} strokeWidth={1.5} aria-hidden="true" />
              {capturing ? (remaining !== null ? `${remaining}…` : '正在拍…') : '拍照'}
            </Btn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
