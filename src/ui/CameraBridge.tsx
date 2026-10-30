import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, RefreshCw, X } from 'lucide-react'
import { Btn } from './kit/Btn.tsx'
import CameraLiveView from './CameraLiveView.tsx'
import {
  bracketExposureValues, bracketFocusValues, findFocusBracketField,
  type BracketShots, type BracketStep, type FocusBracketSpan,
} from '../core/cameraBrackets.ts'
import type { Appearance } from '../app/appearance.ts'
import {
  buildCameraPairingLink, clearCameraPairingHash,
  normalizeBridgeAddress, readCameraPairingHash,
} from '../app/cameraPairing.ts'
import {
  cameraConnectionKey, cameraConnectionsJson, loadCameraConnections, makeCameraConnection,
  parseCameraConnectionsJson,
  saveCameraConnections, upsertCameraConnection,
  type CameraConnection,
} from '../app/cameraConnections.ts'
import {
  applyPresetToSchema, deleteCameraPreset, loadCameraPresets,
  saveCameraPreset, type CameraPreset,
} from '../core/cameraPresets.ts'

type CameraPhoto = {
  id: string
  name: string
  folder?: string
  size: number
  mtime: number
  type: string
  url: string
  convertUrl?: string | null
  /** 同一张照片的 RAW 原片；主条目通常是对网页更友好的 JPEG。 */
  raw?: CameraPhotoRaw | null
  /** 同目录同名 XMP 调色旁车。 */
  sidecar?: CameraPhotoRaw | null
}

type CameraPhotoRaw = {
  id: string
  name: string
  size: number
  mtime: number
  type: string
  url: string
  convertUrl?: string | null
}

type CameraControl = {
  connected: boolean
  model: string | null
  capabilities: { liveView: boolean; shutter: boolean; settings: boolean; import?: boolean }
  diagnostic?: string
  previewDiagnostic?: string
  settingsSchema?: CameraSettingDescriptor[]
  canConfigure?: boolean
}

type CameraSettingDescriptor = {
  key: string
  label: string
  type: 'number' | 'select'
  readOnly?: boolean
  min?: number
  max?: number
  step?: number
  options?: { value: string; label: string }[]
}

type CameraSettings = Record<string, string | number>

type CameraHealth = {
  converter?: string | null
  converters?: string[]
}

type CameraDiagnosticRow = {
  key: string
  label: string
  ok: boolean
  detail: string
}

type WirelessMode = 'gphoto2' | 'canon-ccapi' | 'sony-camera'

type CaptureSequenceRun = {
  cancelled: boolean
  timer: number | null
  wake: (() => void) | null
}

type Props = {
  open: boolean
  onClose: () => void
  onImport: (file: File, sidecar?: File) => void
  /** 多张照片一次交给批量处理；没有这个口子时仍退回单张导入。 */
  onImportMany?: (files: File[], sidecars?: File[]) => void
  /** 包围曝光整组 → HDR 合成。 */
  onHdrMany?: (files: File[]) => void
  /** 焦点包围整组 → 焦点堆栈。 */
  onFocusMany?: (files: File[]) => void
  appearance?: Appearance
}

const ADDRESS_KEY = 'pinkrose.camera.bridge'
const TOKEN_KEY = 'pinkrose.camera.bridge.token'
const AUTO_IMPORT_KEY = 'pinkrose.camera.bridge.autoImport'
const WIFI_IP_KEY = 'pinkrose.camera.wifi.ip'
const WIFI_PORT_KEY = 'pinkrose.camera.wifi.port'
const WIFI_MODE_KEY = 'pinkrose.camera.wifi.mode'
const DEFAULT_ADDRESS = 'http://127.0.0.1:8788'
const MAX_BATCH_IMPORT = 20

const CONVERTER_LABELS: Record<string, string> = {
  sips: 'sips',
  magick: 'ImageMagick',
  rawtherapee: 'RawTherapee',
  darktable: 'darktable',
  libraw: 'LibRaw',
}

function converterNames(kinds: readonly string[]): string {
  return kinds.map(kind => CONVERTER_LABELS[kind] ?? kind).join(' / ')
}

function savedAddress(): string {
  try { return localStorage.getItem(ADDRESS_KEY) ?? '' } catch { return '' }
}

function rememberAddress(value: string): void {
  try { localStorage.setItem(ADDRESS_KEY, value) } catch {
    // 隐私模式 / 禁用存储：不影响本次连接。
  }
}

function savedToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) ?? '' } catch { return '' }
}

function rememberToken(value: string): void {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // 隐私模式 / 禁用存储：不影响本次连接。
  }
}

function savedAutoImport(): boolean {
  try { return localStorage.getItem(AUTO_IMPORT_KEY) === '1' } catch { return false }
}

function rememberAutoImport(value: boolean): void {
  try {
    if (value) localStorage.setItem(AUTO_IMPORT_KEY, '1')
    else localStorage.removeItem(AUTO_IMPORT_KEY)
  } catch {
    // 隐私模式 / 禁用存储：不影响本次自动导入。
  }
}

function savedWifi(key: string): string {
  try { return localStorage.getItem(key) ?? '' } catch { return '' }
}

function rememberWifi(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // 隐私模式 / 禁用存储：不影响本次连接。
  }
}

function savedWirelessMode(): WirelessMode {
  try {
    const value = localStorage.getItem(WIFI_MODE_KEY)
    return value === 'canon-ccapi' || value === 'sony-camera' ? value : 'gphoto2'
  } catch {
    return 'gphoto2'
  }
}

function rememberWirelessMode(value: WirelessMode): void {
  try { localStorage.setItem(WIFI_MODE_KEY, value) } catch {
    // 隐私模式 / 禁用存储：不影响本次连接。
  }
}

function bridgeHeaders(token: string): Record<string, string> {
  return token ? { 'x-pinkrose-bridge-token': token } : {}
}

function canonCameraUrl(address: string, port: string): string {
  const raw = address.trim()
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error('Canon 相机地址不对。填相机 Wi-Fi 地址，例如 192.168.1.50。')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Canon CCAPI 只支持 http:// 或 https:// 地址。')
  }
  if (url.username || url.password) {
    throw new Error('Canon 相机地址里不要放用户名或密码。')
  }
  if (port.trim()) url.port = port.trim()
  else if (!url.port) url.port = '8080'
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function sonyCameraUrl(address: string, port: string): string {
  const raw = address.trim()
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error('Sony 相机地址不对。填相机 Wi-Fi 地址，例如 192.168.1.70。')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Sony Camera Remote API 只支持 http:// 或 https:// 地址。')
  }
  if (url.username || url.password) {
    throw new Error('Sony 相机地址里不要放用户名或密码。')
  }
  if (port.trim()) url.port = port.trim()
  else if (!url.port) url.port = '10000'
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/sony$/i, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

/**
 * 给 `<img src>` / 下载地址也带上令牌。图片标签不能自定义请求头，
 * 所以文件类 URL 用查询参数；其余 fetch 同时带请求头和查询参数。
 */
function bridgeUrl(base: string, path: string, token: string): string {
  const url = new URL(path, `${base}/`)
  if (token) url.searchParams.set('token', token)
  return url.toString()
}

function bridgeErrorText(error: unknown, address: string): string {
  if (typeof location !== 'undefined' && location.protocol === 'https:'
    && address.startsWith('http://')) {
    return '网页是 HTTPS，浏览器会拦住本机 HTTP 相机桥。请用本地版打开，或给相机桥配 HTTPS 后再试。'
  }
  if (error instanceof Error && error.message.includes('访问令牌')) {
    return `连接不上相机桥：${error.message} 对照电脑终端里那串访问令牌，重新填一次。`
  }
  const detail = error instanceof Error ? `（${error.message}）` : ''
  return `连接不上相机桥${detail}。先在本机运行 npm run camera:bridge，并确认地址和端口一致。`
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function timeText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * 本机相机文件夹桥（★ 2026-10-18）。
 *
 * 不直接连厂商 SDK：Canon / Sony / Nikon / Capture One 的 tether 软件
 * 先把照片落盘，本机桥把列表交给网页；USB 直连时再通过适配器
 * （当前是 gphoto2）提供实时取景、快门和相机参数。
 */
export default function CameraBridge({
  open, onClose, onImport, onImportMany, onHdrMany, onFocusMany, appearance = 'dark',
}: Props) {
  const [address, setAddress] = useState(DEFAULT_ADDRESS)
  const [token, setToken] = useState('')
  const [base, setBase] = useState<string | null>(null)
  const [photos, setPhotos] = useState<CameraPhoto[]>([])
  const [control, setControl] = useState<CameraControl | null>(null)
  const [converters, setConverters] = useState<string[]>([])
  const [settings, setSettings] = useState<CameraSettings | null>(null)
  const [liveTick, setLiveTick] = useState(0)
  const [shutterBusy, setShutterBusy] = useState(false)
  const [intervalBusy, setIntervalBusy] = useState(false)
  const [intervalCount, setIntervalCount] = useState(3)
  const [intervalSeconds, setIntervalSeconds] = useState(5)
  const [intervalProgress, setIntervalProgress] = useState<{ done: number; total: number } | null>(null)
  const [bracketBusy, setBracketBusy] = useState(false)
  const [bracketShots, setBracketShots] = useState<BracketShots>(3)
  const [bracketStep, setBracketStep] = useState<BracketStep>(1)
  const [bracketProgress, setBracketProgress] = useState<{ done: number; total: number } | null>(null)
  const [bracketFresh, setBracketFresh] = useState<CameraPhoto[]>([])
  const [focusBusy, setFocusBusy] = useState(false)
  const [focusShots, setFocusShots] = useState<BracketShots>(3)
  const [focusSpan, setFocusSpan] = useState<FocusBracketSpan>(10)
  const [focusProgress, setFocusProgress] = useState<{ done: number; total: number } | null>(null)
  const [focusFresh, setFocusFresh] = useState<CameraPhoto[]>([])
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [wifiIp, setWifiIp] = useState(() => savedWifi(WIFI_IP_KEY))
  const [wifiPort, setWifiPort] = useState(() => savedWifi(WIFI_PORT_KEY))
  const [wifiMode, setWifiMode] = useState<WirelessMode>(savedWirelessMode)
  const [wifiBusy, setWifiBusy] = useState(false)
  const [wifiMsg, setWifiMsg] = useState<string | null>(null)
  const [connections, setConnections] = useState<CameraConnection[]>(loadCameraConnections)
  const [connectionName, setConnectionName] = useState('')
  const [presets, setPresets] = useState<CameraPreset[]>(() => loadCameraPresets())
  const [presetId, setPresetId] = useState('')
  const [presetName, setPresetName] = useState('')
  const [presetNote, setPresetNote] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [diagnosticBusy, setDiagnosticBusy] = useState(false)
  const [diagnostic, setDiagnostic] = useState<CameraDiagnosticRow[] | null>(null)
  const [importing, setImporting] = useState<string | null>(null)
  const [autoImport, setAutoImport] = useState(savedAutoImport)
  const [error, setError] = useState<string | null>(null)
  const [pairMsg, setPairMsg] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const connectionFileRef = useRef<HTMLInputElement | null>(null)
  const mountedRef = useRef(true)
  const importingRef = useRef(false)
  const autoImportRef = useRef(autoImport)
  const seenPhotosRef = useRef<Set<string>>(new Set())
  const sequenceBusyRef = useRef(false)
  const intervalRunRef = useRef<CaptureSequenceRun | null>(null)
  const bracketRunRef = useRef<CaptureSequenceRun | null>(null)
  const focusRunRef = useRef<CaptureSequenceRun | null>(null)
  const sequenceFreshRef = useRef<CameraPhoto[]>([])
  const connectRef = useRef<(value?: string, token?: string) => Promise<void>>(async () => {})
  const onCloseRef = useRef(onClose)
  const onImportRef = useRef(onImport)
  const onImportManyRef = useRef(onImportMany)
  const onHdrManyRef = useRef(onHdrMany)
  const onFocusManyRef = useRef(onFocusMany)

  useEffect(() => {
    onImportRef.current = onImport
    onImportManyRef.current = onImportMany
    onHdrManyRef.current = onHdrMany
    onFocusManyRef.current = onFocusMany
  }, [onImport, onImportMany, onHdrMany, onFocusMany])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const connect = useCallback(async (value = address, tokenValue = token) => {
    const next = normalizeBridgeAddress(value)
    if (!next) {
      setError('相机桥地址不对。示例：http://127.0.0.1:8788')
      return
    }
    const nextToken = tokenValue.trim()
    setConnecting(true)
    setError(null)
    try {
      const health = await fetch(bridgeUrl(next, '/api/camera/health', nextToken), {
        cache: 'no-store',
        headers: bridgeHeaders(nextToken),
      })
      if (health.status === 401) throw new Error('访问令牌不对，或相机桥重启后换了令牌。')
      if (!health.ok) throw new Error(`HTTP ${health.status}`)
      const healthBody = await health.json().catch(() => null) as CameraHealth | null
      const list = await fetch(bridgeUrl(next, '/api/camera/photos', nextToken), {
        cache: 'no-store',
        headers: bridgeHeaders(nextToken),
      })
      if (!list.ok) throw new Error(`HTTP ${list.status}`)
      const body = await list.json() as { photos?: CameraPhoto[] }
      const nextControl = await fetch(bridgeUrl(next, '/api/camera/control', nextToken), {
        cache: 'no-store',
        headers: bridgeHeaders(nextToken),
      })
        .then(async res => res.ok ? await res.json() as CameraControl : null)
        .catch(() => null)
      const nextSettings = nextControl?.capabilities.settings
        ? await fetch(bridgeUrl(next, '/api/camera/settings', nextToken), {
          cache: 'no-store',
          headers: bridgeHeaders(nextToken),
        })
          .then(async res => res.ok
            ? (await res.json() as { settings?: CameraSettings }).settings ?? null
            : null)
          .catch(() => null)
        : null
      if (!mountedRef.current) return
      setBase(next)
      setAddress(next)
      setToken(nextToken)
      setPhotos(Array.isArray(body.photos) ? body.photos : [])
      seenPhotosRef.current = new Set(
        (Array.isArray(body.photos) ? body.photos : []).map(photo => photo.id),
      )
      setControl(nextControl)
      setSettings(nextSettings)
      setConverters(
        Array.isArray(healthBody?.converters)
          ? healthBody.converters.filter(kind => typeof kind === 'string')
          : healthBody?.converter ? [healthBody.converter] : [],
      )
      rememberAddress(next)
      rememberToken(nextToken)
    } catch (e) {
      console.error('相机桥连接失败', e)
      if (!mountedRef.current) return
      setBase(null)
      setPhotos([])
      setControl(null)
      setSettings(null)
      setConverters([])
      setError(bridgeErrorText(e, next))
    } finally {
      if (mountedRef.current) setConnecting(false)
    }
  }, [address, token])
  connectRef.current = connect
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stopSequences()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    const saved = savedAddress()
    const pairing = typeof location !== 'undefined'
      ? readCameraPairingHash(location.hash)
      : null
    if (pairing) {
      setAddress(pairing.address)
      setToken(pairing.token)
      clearCameraPairingHash()
      void connectRef.current(pairing.address, pairing.token)
      return () => {
        stopSequences()
        window.removeEventListener('keydown', onKey)
        document.body.style.overflow = previous
      }
    }
    if (saved) {
      const savedKey = savedToken()
      setAddress(saved)
      setToken(savedKey)
      void connectRef.current(saved, savedKey)
    }
    return () => {
      stopSequences()
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open])

  async function copyPairingLink() {
    if (typeof location === 'undefined') return
    const link = buildCameraPairingLink({
      appUrl: location.href,
      bridgeAddress: address,
      token,
    })
    if (!link) {
      setPairMsg('先填好桥接地址和访问令牌，再复制配对链接。')
      return
    }
    try {
      await navigator.clipboard.writeText(link)
      setPairMsg('配对链接已复制（含访问令牌，别公开）。在 iPad / iPhone 打开后点「相机桥」会自动填好。')
    } catch {
      setPairMsg('这台浏览器没让复制。手动把地址和令牌填过去吧。')
    }
  }

  useEffect(() => {
    if (!open || !base) return
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch(bridgeUrl(base, '/api/camera/photos', token), {
          cache: 'no-store',
          headers: bridgeHeaders(token),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json() as { photos?: CameraPhoto[] }
        if (alive) {
          const list = Array.isArray(body.photos) ? body.photos : []
          setPhotos(list)
          setError(null)
          const fresh = list.filter(photo => !seenPhotosRef.current.has(photo.id))
          for (const photo of list) seenPhotosRef.current.add(photo.id)
          autoImportFresh(fresh)
        }
        const controlRes = await fetch(
          bridgeUrl(base, '/api/camera/control', token),
          { cache: 'no-store', headers: bridgeHeaders(token) },
        ).catch(() => null)
        if (controlRes?.ok) {
          const nextControl = await controlRes.json().catch(() => null) as CameraControl | null
          if (alive && nextControl) setControl(nextControl)
        }
      } catch (e) {
        if (alive) setError(bridgeErrorText(e, base))
      }
    }
    const timer = setInterval(() => void tick(), 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [open, base, token])

  useEffect(() => {
    if (!open || !base || !control?.capabilities.liveView) return
    const timer = setInterval(() => setLiveTick(t => t + 1), 1000)
    return () => clearInterval(timer)
  }, [open, base, control?.capabilities.liveView])

  async function fileFor(photo: CameraPhoto, convert = false): Promise<File> {
    if (!base) throw new Error('相机桥还没连上')
    const target = convert && photo.convertUrl ? photo.convertUrl : photo.url
    const url = bridgeUrl(base, target, token)
    const res = await fetch(url, { cache: 'no-store', headers: bridgeHeaders(token) })
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null
      throw new Error(body?.error ?? `HTTP ${res.status}`)
    }
    const blob = await res.blob()
    const type = convert ? 'image/jpeg' : (photo.type || blob.type || 'application/octet-stream')
    const name = convert
      ? photo.name.replace(/\.[^.]+$/, '') + '.jpg'
      : photo.name
    return new File([blob], name, { type })
  }

  async function sidecarFor(photo: CameraPhoto): Promise<File | undefined> {
    if (!base || !photo.sidecar) return undefined
    const res = await fetch(
      bridgeUrl(base, photo.sidecar.url, token),
      { cache: 'no-store', headers: bridgeHeaders(token) },
    )
    if (!res.ok) {
      throw new Error(`XMP 旁车「${photo.sidecar.name}」没取回来`)
    }
    const blob = await res.blob()
    return new File([blob], photo.sidecar.name, { type: 'application/rdf+xml' })
  }

  async function filesFor(
    list: CameraPhoto[],
    onProgress?: (index: number, total: number) => void,
  ): Promise<{ files: File[]; sidecars: File[] }> {
    const files: File[] = []
    const sidecars: File[] = []
    for (let i = 0; i < list.length; i++) {
      onProgress?.(i + 1, list.length)
      const photo = list[i]!
      files.push(await fileFor(photo, !!photo.convertUrl))
      const sidecar = await sidecarFor(photo)
      if (sidecar) sidecars.push(sidecar)
    }
    return { files, sidecars }
  }

  async function importPhoto(photo: CameraPhoto, convert = false) {
    if (!base || importingRef.current) return
    importingRef.current = true
    setImporting(photo.id)
    setError(null)
    try {
      const file = await fileFor(photo, convert)
      const sidecar = await sidecarFor(photo)
      if (sidecar) onImportRef.current(file, sidecar)
      else onImportRef.current(file)
    } catch (e) {
      console.error('相机照片导入失败', e)
      setError(e instanceof Error && !e.message.startsWith('HTTP')
        ? e.message
        : '这张照片没取回来。确认相机桥还开着，再试一次。')
    } finally {
      importingRef.current = false
      if (mountedRef.current) setImporting(null)
    }
  }

  /**
   * 多张照片一起取回并交给批量处理。只取前 20 张（批量页的上限），
   * 单张失败就整批不交 —— 宁可说清楚，也不让用户拿着一半的照片去处理。
   */
  async function importMany(list: CameraPhoto[]) {
    if (!base || importingRef.current || !onImportManyRef.current) return
    if (list.length === 0) return
    importingRef.current = true
    setImporting(`many:0/${Math.min(list.length, MAX_BATCH_IMPORT)}`)
    setError(null)
    try {
      const picked = list.slice(0, MAX_BATCH_IMPORT)
      const downloaded = await filesFor(
        picked,
        (index, total) => setImporting(`many:${index}/${total}`),
      )
      if (downloaded.sidecars.length > 0) {
        onImportManyRef.current(downloaded.files, downloaded.sidecars)
      } else {
        onImportManyRef.current(downloaded.files)
      }
      if (list.length > MAX_BATCH_IMPORT) {
        setError(`一次最多导入 ${MAX_BATCH_IMPORT} 张；剩下的照片还在相机桥里，可以再导一次。`)
      }
    } catch (e) {
      console.error('相机照片批量导入失败', e)
      setError(e instanceof Error && !e.message.startsWith('HTTP')
        ? e.message
        : '有一张照片没取回来，整批先没有导入。确认相机桥还开着，再试一次。')
    } finally {
      importingRef.current = false
      if (mountedRef.current) setImporting(null)
    }
  }

  async function importFromCamera() {
    if (!base || importingRef.current) return
    importingRef.current = true
    setImporting('camera')
    setError(null)
    try {
      const res = await fetch(bridgeUrl(base, '/api/camera/import', token), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...bridgeHeaders(token),
          'x-pinkrose-camera': '1',
        },
        body: JSON.stringify({ limit: MAX_BATCH_IMPORT }),
      })
      const body = await res.json().catch(() => null) as {
        result?: { imported?: string[] }
        error?: string
      } | null
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      const imported = new Set(
        Array.isArray(body?.result?.imported)
          ? body.result.imported.filter(name => typeof name === 'string')
          : [],
      )
      const listRes = await fetch(bridgeUrl(base, '/api/camera/photos', token), {
        cache: 'no-store',
        headers: bridgeHeaders(token),
      })
      if (!listRes.ok) throw new Error('相机照片列表没刷新')
      const listBody = await listRes.json() as { photos?: CameraPhoto[] }
      const next = Array.isArray(listBody.photos) ? listBody.photos : []
      setPhotos(next)
      for (const photo of next) seenPhotosRef.current.add(photo.id)
      const picked = next.filter(photo => imported.has(photo.name))
      if (picked.length === 0) {
        setError('相机里没有新的照片可导入。')
        return
      }
      if (picked.length > 1 && onImportManyRef.current) {
        const downloaded = await filesFor(
          picked,
          (index, total) => setImporting(`camera:${index}/${total}`),
        )
        if (downloaded.sidecars.length > 0) {
          onImportManyRef.current(downloaded.files, downloaded.sidecars)
        } else {
          onImportManyRef.current(downloaded.files)
        }
      } else {
        const photo = picked[0]!
        const file = await fileFor(photo, !!photo.convertUrl)
        const sidecar = await sidecarFor(photo)
        if (sidecar) onImportRef.current(file, sidecar)
        else onImportRef.current(file)
        if (picked.length > 1) {
          setError(`这次先打开了第一张；还有 ${picked.length - 1} 张可在列表里再导入。`)
        }
      }
    } catch (e) {
      console.error('从相机导入照片失败', e)
      setError(e instanceof Error && !e.message.startsWith('HTTP')
        ? e.message
        : '相机照片没导进来。确认相机还连着、存储卡里也有照片，再试一次。')
    } finally {
      importingRef.current = false
      if (mountedRef.current) setImporting(null)
    }
  }

  async function importBracketHdr() {
    if (!base || importingRef.current || !onHdrManyRef.current || bracketFresh.length < 2) return
    importingRef.current = true
    setImporting(`hdr:0/${Math.min(bracketFresh.length, 5)}`)
    setError(null)
    try {
      const picked = bracketFresh.slice(0, 5)
      const files: File[] = []
      for (let i = 0; i < picked.length; i++) {
        setImporting(`hdr:${i + 1}/${picked.length}`)
        files.push(await fileFor(picked[i]!, !!picked[i]!.convertUrl))
      }
      onHdrManyRef.current(files)
      setBracketFresh([])
    } catch (e) {
      console.error('包围曝光送 HDR 失败', e)
      setError(e instanceof Error && !e.message.startsWith('HTTP')
        ? e.message
        : '这组包围曝光没取回来。确认相机桥还开着，再试一次。')
    } finally {
      importingRef.current = false
      if (mountedRef.current) setImporting(null)
    }
  }

  async function importFocusStack() {
    if (!base || importingRef.current || !onFocusManyRef.current || focusFresh.length < 2) return
    importingRef.current = true
    setImporting(`focus:0/${Math.min(focusFresh.length, 5)}`)
    setError(null)
    try {
      const picked = focusFresh.slice(0, Math.min(5, focusFresh.length))
      const files: File[] = []
      for (let i = 0; i < picked.length; i++) {
        setImporting(`focus:${i + 1}/${picked.length}`)
        files.push(await fileFor(picked[i]!, !!picked[i]!.convertUrl))
      }
      onFocusManyRef.current(files)
      setFocusFresh([])
    } catch (e) {
      console.error('焦点包围送焦点堆栈失败', e)
      setError(e instanceof Error && !e.message.startsWith('HTTP')
        ? e.message
        : '这组焦点包围没取回来。确认相机桥还开着，再试一次。')
    } finally {
      importingRef.current = false
      if (mountedRef.current) setImporting(null)
    }
  }

  /** 新照片到了：一张直接进编辑器；多张有批量入口时进批量处理。 */
  function autoImportFresh(fresh: CameraPhoto[]) {
    if (fresh.length === 0) return
    if (sequenceBusyRef.current) {
      // 序列进行中先把新照片收住；是否自动导入由序列结束后再决定。
      sequenceFreshRef.current.push(...fresh)
      return
    }
    if (!autoImportRef.current || importingRef.current) return
    const ranked = [...fresh].sort((a, b) => b.mtime - a.mtime)
    if (ranked.length > 1 && onImportManyRef.current) {
      void importMany(ranked)
    } else {
      void importPhoto(ranked[0]!, !!ranked[0]!.convertUrl)
    }
  }

  async function captureOnce(): Promise<void> {
    if (!base) throw new Error('相机桥还没连上')
    const res = await fetch(bridgeUrl(base, '/api/camera/shutter', token), {
      method: 'POST',
      headers: { ...bridgeHeaders(token), 'x-pinkrose-camera': '1' },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null
      throw new Error(body?.error ?? `HTTP ${res.status}`)
    }
    const list = await fetch(bridgeUrl(base, '/api/camera/photos', token), {
      cache: 'no-store',
      headers: bridgeHeaders(token),
    })
    if (!list.ok) return
    const body = await list.json() as { photos?: CameraPhoto[] }
    const next = Array.isArray(body.photos) ? body.photos : []
    const fresh = next.filter(photo => !seenPhotosRef.current.has(photo.id))
    for (const photo of next) seenPhotosRef.current.add(photo.id)
    setPhotos(next)
    autoImportFresh(fresh)
  }

  async function shoot() {
    if (!base || shutterBusy || intervalBusy || bracketBusy || focusBusy) return
    setShutterBusy(true)
    setError(null)
    try {
      await captureOnce()
    } catch (e) {
      console.error('相机快门失败', e)
      setError(e instanceof Error && !e.message.startsWith('HTTP')
        ? e.message
        : '快门没按成。确认相机还连着，再试一次。')
    } finally {
      if (mountedRef.current) setShutterBusy(false)
    }
  }

  function stopInterval() {
    const run = intervalRunRef.current
    if (!run) return
    run.cancelled = true
    if (run.timer !== null) window.clearTimeout(run.timer)
    run.timer = null
    run.wake?.()
    run.wake = null
  }

  function stopBracket() {
    const run = bracketRunRef.current
    if (!run) return
    run.cancelled = true
  }

  function stopFocus() {
    const run = focusRunRef.current
    if (!run) return
    run.cancelled = true
  }

  function stopSequences() {
    stopInterval()
    stopBracket()
    stopFocus()
  }

  function intervalWait(ms: number, run: CaptureSequenceRun): Promise<void> {
    return new Promise(resolve => {
      run.wake = () => {
        run.wake = null
        resolve()
      }
      run.timer = window.setTimeout(() => {
        run.timer = null
        run.wake = null
        resolve()
      }, ms)
    })
  }

  async function runInterval() {
    if (!base || shutterBusy || intervalBusy || bracketBusy || focusBusy) return
    const total = Math.max(2, Math.min(20, Math.round(intervalCount)))
    const seconds = Math.max(1, Math.min(60, Math.round(intervalSeconds)))
    const run: CaptureSequenceRun = { cancelled: false, timer: null, wake: null }
    intervalRunRef.current = run
    sequenceBusyRef.current = true
    sequenceFreshRef.current = []
    setIntervalBusy(true)
    setIntervalProgress({ done: 0, total })
    setError(null)
    let failure = ''
    try {
      for (let i = 0; i < total && !run.cancelled; i++) {
        await captureOnce()
        if (!mountedRef.current) return
        setIntervalProgress({ done: i + 1, total })
        if (i < total - 1 && !run.cancelled) await intervalWait(seconds * 1000, run)
      }
    } catch (e) {
      console.error('间隔拍摄失败', e)
      failure = e instanceof Error && !e.message.startsWith('HTTP')
        ? e.message
        : '间隔拍摄中断了。确认相机还连着，再试一次。'
    } finally {
      intervalRunRef.current = null
      sequenceBusyRef.current = false
      const fresh = [...new Map(sequenceFreshRef.current.map(photo => [photo.id, photo])).values()]
      sequenceFreshRef.current = []
      if (mountedRef.current) {
        setIntervalBusy(false)
        setIntervalProgress(null)
        if (failure) setError(failure)
        else if (run.cancelled) setError('间隔拍摄已停止；已经拍到的照片仍在列表里。')
      }
      if (fresh.length > 0) autoImportFresh(fresh)
    }
  }

  async function applyCameraSettings(patch: CameraSettings): Promise<void> {
    if (!base) throw new Error('相机桥还没连上')
    const res = await fetch(bridgeUrl(base, '/api/camera/settings', token), {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-pinkrose-camera': '1',
        ...bridgeHeaders(token),
      },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null
      throw new Error(body?.error ?? `HTTP ${res.status}`)
    }
    const body = await res.json().catch(() => null) as { settings?: CameraSettings } | null
    if (body?.settings) setSettings(body.settings)
  }

  async function applyExposureCompensation(value: number): Promise<void> {
    await applyCameraSettings({ exposureCompensation: value })
  }

  async function runBracket() {
    if (!base || !settings || shutterBusy || intervalBusy || bracketBusy || focusBusy) return
    const field = control?.settingsSchema?.find(item => item.key === 'exposureCompensation')
    if (!field || field.readOnly) {
      setError('这台相机没有提供可写的曝光补偿，暂时做不了包围曝光。')
      return
    }
    const original = settings.exposureCompensation
    const baseValue = Number(original)
    const values = bracketExposureValues(baseValue, bracketShots, bracketStep, field)
    if (!values) {
      setError('当前曝光补偿范围不够拍完这组包围曝光。换小一点的步长，或先调整相机的曝光补偿范围。')
      return
    }
    const run: CaptureSequenceRun = { cancelled: false, timer: null, wake: null }
    bracketRunRef.current = run
    sequenceBusyRef.current = true
    sequenceFreshRef.current = []
    setBracketFresh([])
    setBracketBusy(true)
    setBracketProgress({ done: 0, total: values.length })
    setError(null)
    let failure = ''
    try {
      for (let i = 0; i < values.length && !run.cancelled; i++) {
        await applyExposureCompensation(values[i]!)
        if (run.cancelled) break
        await captureOnce()
        if (!mountedRef.current) return
        setBracketProgress({ done: i + 1, total: values.length })
      }
    } catch (e) {
      console.error('包围曝光失败', e)
      failure = e instanceof Error && !e.message.startsWith('HTTP')
        ? e.message
        : '包围曝光中断了。确认相机还连着，再试一次。'
    } finally {
      try {
        await applyExposureCompensation(baseValue)
      } catch (e) {
        console.error('恢复相机曝光补偿失败', e)
        if (!failure) failure = '包围曝光拍完了，但相机曝光补偿没恢复；请在参数区手动改回原值。'
      }
      bracketRunRef.current = null
      sequenceBusyRef.current = false
      const fresh = [...new Map(sequenceFreshRef.current.map(photo => [photo.id, photo])).values()]
      sequenceFreshRef.current = []
      if (mountedRef.current) {
        setBracketBusy(false)
        setBracketProgress(null)
        if (failure) setError(failure)
        else if (run.cancelled) setError('包围曝光已停止；已经拍到的照片仍在列表里，曝光补偿已经恢复。')
      }
      if (fresh.length >= 2 && onHdrManyRef.current) {
        if (mountedRef.current) setBracketFresh(fresh)
      } else if (fresh.length > 0) {
        autoImportFresh(fresh)
      }
    }
  }

  async function runFocusBracket() {
    if (!base || !settings || !focusField || shutterBusy || intervalBusy || bracketBusy || focusBusy) {
      return
    }
    const original = settings[focusField.key]
    const baseValue = Number(original)
    if (!Number.isFinite(baseValue)) {
      setError('这台相机没有给出可读的焦点位置，暂时做不了焦点包围。')
      return
    }
    const values = bracketFocusValues(baseValue, focusShots, focusSpan, focusField)
    if (!values) {
      setError('当前焦点范围不够拍完这组焦点包围。换小一点的范围，或先把焦点放到中间。')
      return
    }
    const run: CaptureSequenceRun = { cancelled: false, timer: null, wake: null }
    focusRunRef.current = run
    sequenceBusyRef.current = true
    sequenceFreshRef.current = []
    setFocusFresh([])
    setFocusBusy(true)
    setFocusProgress({ done: 0, total: values.length })
    setError(null)
    let failure = ''
    try {
      for (let i = 0; i < values.length && !run.cancelled; i++) {
        await applyCameraSettings({ [focusField.key]: values[i]! })
        if (run.cancelled) break
        await captureOnce()
        if (!mountedRef.current) return
        setFocusProgress({ done: i + 1, total: values.length })
      }
    } catch (e) {
      console.error('焦点包围失败', e)
      failure = e instanceof Error && !e.message.startsWith('HTTP')
        ? e.message
        : '焦点包围中断了。确认相机还连着，再试一次。'
    } finally {
      try {
        await applyCameraSettings({ [focusField.key]: original })
      } catch (e) {
        console.error('恢复相机焦点失败', e)
        if (!failure) failure = '焦点包围拍完了，但相机焦点没恢复；请在参数区手动改回原值。'
      }
      focusRunRef.current = null
      sequenceBusyRef.current = false
      const fresh = [...new Map(sequenceFreshRef.current.map(photo => [photo.id, photo])).values()]
      sequenceFreshRef.current = []
      if (mountedRef.current) {
        setFocusBusy(false)
        setFocusProgress(null)
        if (failure) setError(failure)
        else if (run.cancelled) setError('焦点包围已停止；已经拍到的照片仍在列表里，焦点已经恢复。')
      }
      if (fresh.length >= 2 && onFocusManyRef.current) {
        if (mountedRef.current) setFocusFresh(fresh)
      } else if (fresh.length > 0) {
        autoImportFresh(fresh)
      }
    }
  }

  async function configureWireless(saved?: Pick<CameraConnection, 'kind' | 'address' | 'port'>) {
    if (!base || wifiBusy) return
    const mode = saved?.kind ?? wifiMode
    const ip = (saved?.address ?? wifiIp).trim()
    if (!ip) {
      setWifiMsg('相机 IP 不对。填相机在 Wi-Fi 里的地址，例如 192.168.1.50。')
      return
    }
    const port = (saved?.port ?? wifiPort).trim()
    if (mode === 'gphoto2' && (/[\s/\\]/.test(ip) || ip.includes('://'))) {
      setWifiMsg('相机 IP 不对。填相机在 Wi-Fi 里的地址，例如 192.168.1.50。')
      return
    }
    if (mode === 'gphoto2' && port) {
      const numeric = Number(port)
      if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 65535) {
        setWifiMsg('相机端口需要 1~65535；不确定就留空。')
        return
      }
    }
    let target: Record<string, string>
    try {
      target = mode === 'canon-ccapi'
        ? { kind: mode, url: canonCameraUrl(ip, port) }
        : mode === 'sony-camera'
          ? { kind: mode, url: sonyCameraUrl(ip, port) }
          : { kind: mode, ip, port }
    } catch (e) {
      setWifiMsg(e instanceof Error ? e.message : '相机地址不对。')
      return
    }
    setWifiBusy(true)
    setWifiMsg(null)
    setError(null)
    try {
      const res = await fetch(bridgeUrl(base, '/api/camera/provider', token), {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-pinkrose-camera': '1',
          ...bridgeHeaders(token),
        },
        body: JSON.stringify(target),
      })
      const body = await res.json().catch(() => null) as {
        control?: CameraControl
        error?: string
      } | null
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      const next = body?.control ?? null
      setControl(next)
      rememberWifi(WIFI_IP_KEY, ip)
      rememberWifi(WIFI_PORT_KEY, port)
      rememberWirelessMode(mode)
      if (next?.connected) {
        setWifiMsg(`已连接${
          mode === 'canon-ccapi'
            ? ' Canon CCAPI'
            : mode === 'sony-camera'
              ? ' Sony Camera Remote'
              : '无线相机'
        }${
          next.model ? ` · ${next.model}` : ''
        }；桥重启后会自动恢复。`)
      } else {
        setWifiMsg(mode === 'canon-ccapi'
          ? '配置已保存，但还没连上 Canon。先在相机里启用 Camera Control API，并确认电脑和相机在同一网络。'
          : mode === 'sony-camera'
            ? '配置已保存，但还没连上 Sony。先在相机里打开 Wi-Fi 遥控拍摄，并确认电脑已加入相机的 Wi-Fi。'
          : '配置已保存，但还没检测到相机。确认 PC Remote 已开启、IP 正确，电脑也装好了 gphoto2；桥重启后会自动重试。')
      }
      if (next?.capabilities.settings) {
        const settingsRes = await fetch(bridgeUrl(base, '/api/camera/settings', token), {
          cache: 'no-store',
          headers: bridgeHeaders(token),
        })
        if (settingsRes.ok) {
          const data = await settingsRes.json() as { settings?: CameraSettings }
          setSettings(data.settings ?? null)
        }
      } else {
        setSettings(null)
      }
      setLiveTick(t => t + 1)
    } catch (e) {
      console.error('无线相机配置失败', e)
      setError(e instanceof Error && !e.message.startsWith('HTTP')
        ? e.message
        : '无线相机没接上。确认相机和电脑在同一 Wi-Fi，再试一次。')
    } finally {
      if (mountedRef.current) setWifiBusy(false)
    }
  }

  function saveCurrentConnection() {
    try {
      const next = makeCameraConnection({
        kind: wifiMode,
        address: wifiIp,
        port: wifiPort,
        label: connectionName,
      })
      const list = upsertCameraConnection(connections, next)
      saveCameraConnections(list)
      setConnections(list)
      setConnectionName('')
      setWifiMsg(`已记住「${next.label}」，下次从这里一键连接。`)
    } catch (e) {
      setWifiMsg(e instanceof Error ? e.message : '这组相机配置还不完整。')
    }
  }

  function connectSavedConnection(profile: CameraConnection) {
    setWifiMode(profile.kind)
    setWifiIp(profile.address)
    setWifiPort(profile.port)
    setWifiMsg(null)
    void configureWireless(profile)
  }

  function forgetConnection(id: string) {
    const list = connections.filter(profile => profile.id !== id)
    saveCameraConnections(list)
    setConnections(list)
    setWifiMsg('已从这台浏览器删除这组相机配置；相机桥当前连接不变。')
  }

  function exportConnections() {
    if (connections.length === 0) {
      setWifiMsg('还没有保存过相机配置。')
      return
    }
    const blob = new Blob([cameraConnectionsJson(connections)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'PinkRose-相机连接配置.json'
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    setWifiMsg(`已导出 ${connections.length} 组相机配置；文件里不含访问令牌。`)
  }

  async function importConnections(file: File | null) {
    if (!file) return
    try {
      const parsed = parseCameraConnectionsJson(await file.text())
      let merged = connections
      for (const profile of parsed.connections) {
        merged = upsertCameraConnection(merged, profile)
      }
      saveCameraConnections(merged)
      setConnections(merged)
      setWifiMsg(
        `已导入 ${parsed.connections.length} 组相机配置` +
        `${parsed.skipped ? `，跳过 ${parsed.skipped} 条重复或无效记录` : ''}；` +
        '文件里的配置不会自动连接，访问令牌仍需单独填写。',
      )
    } catch (e) {
      setWifiMsg(e instanceof Error ? e.message : '相机配置没导入。')
    }
  }

  /** 只读体检：不按快门、不改参数，逐项说明接真机时到底卡在哪。 */
  async function runCameraDiagnostics() {
    if (!base || diagnosticBusy) return
    setDiagnosticBusy(true)
    setDiagnostic(null)
    try {
      const [healthRes, controlRes, photosRes] = await Promise.all([
        fetch(bridgeUrl(base, '/api/camera/health', token), {
          cache: 'no-store', headers: bridgeHeaders(token),
        }),
        fetch(bridgeUrl(base, '/api/camera/control', token), {
          cache: 'no-store', headers: bridgeHeaders(token),
        }),
        fetch(bridgeUrl(base, '/api/camera/photos', token), {
          cache: 'no-store', headers: bridgeHeaders(token),
        }),
      ])
      const health = healthRes.ok
        ? await healthRes.json().catch(() => null) as CameraHealth | null
        : null
      const nextControl = controlRes.ok
        ? await controlRes.json().catch(() => null) as CameraControl | null
        : null
      const photosBody = photosRes.ok
        ? await photosRes.json().catch(() => null) as { photos?: CameraPhoto[] } | null
        : null
      const converters = health?.converters ?? []
      const canSettings = !!nextControl?.capabilities.settings
      const canShoot = !!nextControl?.capabilities.shutter
      const canImport = !!nextControl?.capabilities.import
      setDiagnostic([
        {
          key: 'bridge',
          label: '相机桥',
          ok: healthRes.ok,
          detail: healthRes.ok ? '服务可访问，令牌通过。' : `服务返回 HTTP ${healthRes.status}。`,
        },
        {
          key: 'camera',
          label: '相机连接',
          ok: !!nextControl?.connected,
          detail: nextControl?.connected
            ? nextControl.model || '相机已连接。'
            : '未检测到机身；检查相机模式、Wi-Fi / USB 和连接配置。',
        },
        {
          key: 'live',
          label: '实时取景',
          ok: !!nextControl?.capabilities.liveView,
          detail: nextControl?.capabilities.liveView
            ? '当前适配器声明支持实时取景。'
            : '当前机型或连接方式没有开放实时取景。',
        },
        {
          key: 'control',
          label: '拍摄与参数',
          ok: canShoot,
          detail: canShoot
            ? canSettings ? '支持快门和可写参数。' : '支持快门；参数只读。'
            : '当前适配器没有开放快门控制。',
        },
        {
          key: 'import',
          label: '照片列表',
          ok: photosRes.ok && canImport,
          detail: photosRes.ok
            ? `照片列表可读，当前 ${photosBody?.photos?.length ?? 0} 项；${canImport ? '支持存储卡导入。' : '适配器未声明存储卡导入。'}`
            : `照片列表返回 HTTP ${photosRes.status}。`,
        },
        {
          key: 'convert',
          label: 'RAW / HEIC 转换',
          ok: converters.length > 0,
          detail: converters.length > 0
            ? `本机可用：${converterNames(converters)}。`
            : '没有检测到 RAW / HEIC 转换器；原片仍可导入，但浏览器能否解码取决于格式。',
        },
      ])
    } catch (e) {
      console.error('相机诊断失败', e)
      setDiagnostic([{
        key: 'bridge',
        label: '相机桥',
        ok: false,
        detail: '连不上相机桥；确认地址、端口、访问令牌和网络。',
      }])
    } finally {
      if (mountedRef.current) setDiagnosticBusy(false)
    }
  }

  async function sendSettings(next: CameraSettings) {
    if (!base || settingsBusy) return
    setSettingsBusy(true)
    setError(null)
    try {
      const writable = Object.fromEntries(
        Object.entries(next).filter(([key]) =>
          !control?.settingsSchema?.find(item => item.key === key)?.readOnly),
      )
      const res = await fetch(bridgeUrl(base, '/api/camera/settings', token), {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-pinkrose-camera': '1',
          ...bridgeHeaders(token),
        },
        body: JSON.stringify(writable),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const body = await res.json() as { settings?: CameraSettings }
      if (body.settings) setSettings(body.settings)
    } catch (e) {
      console.error('相机参数应用失败', e)
      setError(e instanceof Error && !e.message.startsWith('HTTP')
        ? e.message
        : '参数没应用上。确认相机支持这些设置，再试一次。')
    } finally {
      if (mountedRef.current) setSettingsBusy(false)
    }
  }

  async function applySettings() {
    if (!settings) return
    await sendSettings(settings)
  }

  async function applyPreset() {
    if (!settings || !control?.settingsSchema || !presetId) return
    const preset = presets.find(item => item.id === presetId)
    if (!preset) return
    const patch = applyPresetToSchema(preset, control.settingsSchema, settings)
    const count = Object.keys(patch).length
    if (count === 0) {
      setPresetNote('这套预设里的参数，当前相机都不支持。')
      return
    }
    const next = { ...settings, ...patch }
    setSettings(next)
    setPresetNote(`已套用 ${count} 项参数。`)
    await sendSettings(next)
  }

  function savePreset() {
    if (!settings) return
    const finalName = presetName.trim() || `${control?.model || '相机'} 参数`
    const model = control?.model ?? ''
    const next = saveCameraPreset(finalName, model, settings)
    setPresets(next)
    const created = next.find(item => item.name === finalName && item.model === model)
    setPresetId(created?.id ?? '')
    setPresetName('')
    setPresetNote('已保存在这台设备；换相机时只应用当前相机支持的项。')
  }

  function removePreset() {
    if (!presetId) return
    setPresets(deleteCameraPreset(presetId))
    setPresetId('')
    setPresetNote('预设已删除。')
  }

  const exposureField = control?.settingsSchema
    ?.find(item => item.key === 'exposureCompensation')
  const bracketReady = !!exposureField && !exposureField.readOnly
    && settings?.exposureCompensation !== undefined
  const focusField = findFocusBracketField(control?.settingsSchema ?? [])
  const focusReady = !!focusField && settings?.[focusField.key] !== undefined

  if (!open) return null
  return createPortal(
    <div className="camera-dialog" data-theme={appearance}
         role="dialog" aria-modal="true" aria-labelledby="camera-bridge-title">
      <div className="camera-panel bridge-panel">
        <header className="camera-head">
          <div>
            <h2 id="camera-bridge-title">相机桥</h2>
            <p>从本机 tether 文件夹导入；可控相机可实时取景、调参数和按快门，照片不经过云端。</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="camera-close"
            aria-label="关闭相机桥"
            onClick={() => { stopSequences(); onClose() }}
          >
            <X size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </header>

        <div className="bridge-body">
          <div className="bridge-connect">
            <label className="bridge-address">
              <span>桥接地址</span>
              <input
                aria-label="相机桥地址"
                value={address}
                spellCheck={false}
                onChange={e => { setAddress(e.target.value); setError(null) }}
                onKeyDown={e => { if (e.key === 'Enter') void connect() }}
              />
            </label>
            <label className="bridge-address bridge-token">
              <span>访问令牌</span>
              <input
                aria-label="相机桥访问令牌"
                type="password"
                value={token}
                spellCheck={false}
                autoComplete="off"
                placeholder="本机连接可留空"
                onChange={e => { setToken(e.target.value); setError(null) }}
                onKeyDown={e => { if (e.key === 'Enter') void connect() }}
              />
            </label>
            <Btn className="bridge-connect-btn" disabled={connecting} onClick={() => void connect()}>
              <RefreshCw size={14} strokeWidth={1.5} aria-hidden="true" />
              {connecting ? '连接中…' : '连接'}
            </Btn>
            {token.trim() && (
              <button
                type="button"
                className="crop-chip bridge-pair"
                onClick={() => void copyPairingLink()}
              >复制配对链接</button>
            )}
          </div>
          {pairMsg && <p className="bridge-hint" role="status">{pairMsg}</p>}
          <p className="bridge-hint">
            先在本机运行 <code>npm run camera:bridge</code>，再把 EOS Utility / Imaging Edge /
            Camera Control Pro / Capture One 的保存目录指向它提示的文件夹。USB 直连相机时，
            改用 <code>npm run camera:bridge -- --gphoto2</code>（需先安装 gphoto2）。
            用 iPad / iPhone 连电脑上的桥时，在电脑上运行
            <code>npm run camera:bridge -- --host 0.0.0.0</code>，把终端显示的局域网地址和
            访问令牌填到上面；两台设备需在同一 Wi-Fi，令牌只保存在这台浏览器里。
            RAW / HEIC / TIFF 有转换器时默认导入 JPG；需要相机原始文件时点「原图」。
          </p>

          {error && (
            <p className="camera-error" role="alert">
              {error}
              <button type="button" onClick={() => void connect()}>再试一次</button>
            </p>
          )}

          {base && control?.canConfigure && (
            <div className="bridge-wireless">
              <div className="bridge-settings-head">
                <span>无线相机</span>
                <label className="bridge-mode">
                  <span>连接方式</span>
                  <select
                    aria-label="无线相机连接方式"
                    value={wifiMode}
                    onChange={event => {
                      setWifiMode(event.target.value as WirelessMode)
                      setWifiMsg(null)
                    }}
                  >
                    <option value="gphoto2">PTP/IP（gphoto2）</option>
                    <option value="canon-ccapi">Canon CCAPI</option>
                    <option value="sony-camera">Sony Camera Remote</option>
                  </select>
                </label>
              </div>
              <div className="bridge-wireless-row">
                <label className="bridge-address">
                  <span>{wifiMode === 'canon-ccapi'
                    ? 'Canon 相机地址'
                    : wifiMode === 'sony-camera'
                      ? 'Sony 相机地址'
                      : '相机 Wi-Fi IP'}</span>
                  <input
                    aria-label={wifiMode === 'canon-ccapi'
                      ? 'Canon CCAPI 地址'
                      : wifiMode === 'sony-camera'
                        ? 'Sony Camera Remote 地址'
                        : '相机 Wi-Fi IP'}
                    value={wifiIp}
                    inputMode="decimal"
                    spellCheck={false}
                    placeholder="192.168.1.50"
                    onChange={event => { setWifiIp(event.target.value); setWifiMsg(null) }}
                    onKeyDown={event => { if (event.key === 'Enter') void configureWireless() }}
                  />
                </label>
                <label className="bridge-address bridge-wifi-port">
                  <span>端口</span>
                  <input
                    aria-label="相机端口"
                    value={wifiPort}
                    inputMode="numeric"
                    spellCheck={false}
                    placeholder={wifiMode === 'canon-ccapi'
                      ? '8080'
                      : wifiMode === 'sony-camera'
                        ? '10000'
                        : '15740'}
                    onChange={event => { setWifiPort(event.target.value); setWifiMsg(null) }}
                    onKeyDown={event => { if (event.key === 'Enter') void configureWireless() }}
                  />
                </label>
                <button
                  type="button"
                  className="bridge-import"
                  disabled={wifiBusy}
                  onClick={() => void configureWireless()}
                >
                  {wifiBusy ? '连接中…' : '连接无线相机'}
                </button>
              </div>
              <div className="bridge-connection-save">
                <label className="bridge-address">
                  <span>名称</span>
                  <input
                    aria-label="相机连接名称"
                    value={connectionName}
                    maxLength={80}
                    spellCheck={false}
                    placeholder="可选，例如 影棚 A7C"
                    onChange={event => setConnectionName(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') saveCurrentConnection()
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="crop-chip"
                  onClick={saveCurrentConnection}
                >保存当前</button>
              </div>
              <div className="bridge-connections" aria-label="已保存的相机连接">
                <div className="bridge-connections-head">
                  <span className="bridge-connections-title">
                    已保存{connections.length ? ` · ${connections.length}` : ''}
                  </span>
                  <div className="bridge-connections-transfer">
                    <button
                      type="button"
                      className="crop-chip"
                      aria-label="导出相机连接配置"
                      disabled={connections.length === 0}
                      onClick={exportConnections}
                    >导出配置</button>
                    <button
                      type="button"
                      className="crop-chip"
                      aria-label="导入相机连接配置"
                      onClick={() => connectionFileRef.current?.click()}
                    >导入配置</button>
                    <input
                      ref={connectionFileRef}
                      type="file"
                      accept=".json,application/json"
                      hidden
                      onChange={event => {
                        void importConnections(event.target.files?.[0] ?? null)
                        event.currentTarget.value = ''
                      }}
                    />
                  </div>
                </div>
                {connections.length > 0 && (
                  <div className="bridge-connections-list">
                    {connections.map(profile => {
                      const active = cameraConnectionKey(profile) === cameraConnectionKey({
                        kind: wifiMode,
                        address: wifiIp,
                        port: wifiPort,
                      })
                      return (
                        <div
                          className={`bridge-connection${active ? ' on' : ''}`}
                          key={profile.id}
                        >
                          <button
                            type="button"
                            className="bridge-connection-open"
                            aria-label={`连接 ${profile.label}`}
                            title={profile.label}
                            disabled={wifiBusy}
                            onClick={() => connectSavedConnection(profile)}
                          >{profile.label}</button>
                          <button
                            type="button"
                            className="bridge-connection-delete"
                            aria-label={`删除 ${profile.label}`}
                            title="只删除这组连接配置，不影响当前相机"
                            onClick={() => forgetConnection(profile.id)}
                          ><X size={13} strokeWidth={1.5} aria-hidden="true" /></button>
                        </div>
                      )
                    })}
                  </div>
                )}
                <p className="bridge-hint">
                  配置文件只含名称、连接方式、地址和端口，不含访问令牌；导入后不会自动连接。
                </p>
              </div>
              <p className="bridge-hint" role="status">
                {wifiMsg ?? (wifiMode === 'canon-ccapi'
                  ? '先在 Canon 相机「无线通信设置 → Wi-Fi 设置」启用 Camera Control API；电脑和相机需在同一网络。'
                  : wifiMode === 'sony-camera'
                    ? '先在 Sony 相机打开 Wi-Fi「遥控拍摄」/ Smart Remote Control；电脑需加入相机提供的 Wi-Fi。'
                  : '相机需开启 PC Remote / PTP 模式并与电脑同一 Wi-Fi；端口不确定就留空。')}
              </p>
            </div>
          )}

          {base && (
            <div className="bridge-status" role="status">
              <span>
                已连接{control?.model
                  ? ` · ${control.model}`
                  : control && !control.connected ? ' · 未检测到相机' : ''} · {photos.length} 张
              </span>
              <span>每 2 秒自动刷新</span>
            </div>
          )}
          {base && (
            <div className="bridge-diagnostics-bar">
              <button
                type="button"
                className="bridge-import"
                disabled={diagnosticBusy}
                onClick={() => void runCameraDiagnostics()}
              >{diagnosticBusy ? '检测中…' : '检查相机'}</button>
              <span>只读检测，不会按快门，也不会改相机参数。</span>
            </div>
          )}
          {diagnostic && (
            <div className="bridge-diagnostics" aria-label="相机检测结果">
              <div className="bridge-diagnostics-head">
                <span>相机检测结果</span>
                <span>{diagnostic.every(row => row.ok) ? '全部通过' : '有项目需要处理'}</span>
              </div>
              <ul>
                {diagnostic.map(row => (
                  <li className={row.ok ? 'ok' : 'bad'} key={row.key}>
                    <span className="bridge-diagnostic-dot" aria-hidden="true" />
                    <strong>{row.label}</strong>
                    <span>{row.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {base && control?.capabilities.import && (
            <div className="bridge-batch">
              <span>从相机存储卡导入最近 {MAX_BATCH_IMPORT} 张，不按快门也不会重复下载</span>
              <button
                type="button"
                className="bridge-import"
                disabled={!!importing || shutterBusy || intervalBusy || bracketBusy || focusBusy}
                onClick={() => void importFromCamera()}
              >
                {importing?.startsWith('camera:') ? `导入中 ${importing.slice(7)}…`
                  : importing === 'camera' ? '正在读取相机…'
                    : '从相机导入'}
              </button>
            </div>
          )}
          {base && (() => {
            const raw = converters.filter(kind =>
              kind === 'rawtherapee' || kind === 'darktable' || kind === 'libraw')
            const raster = converters.filter(kind =>
              kind === 'sips' || kind === 'magick')
            return (
              <p className="bridge-hint bridge-converters" aria-label="RAW 转换能力">
                {raw.length > 0
                  ? `完整 RAW：${converterNames(raw)}`
                  : '完整 RAW：未找到转换器，RAW 仅使用相机内嵌预览'}
                {' · '}
                {raster.length > 0
                  ? `HEIC / TIFF：${converterNames(raster)}`
                  : 'HEIC / TIFF：由浏览器直接解码'}
                {raw.length === 0
                  ? '。安装 RawTherapee、darktable 或 LibRaw 后可完整解档。'
                  : ''}
              </p>
            )
          })()}
          {base && control && !control.connected && control.diagnostic && (
            <p className="bridge-hint" role="status">{control.diagnostic}</p>
          )}
          {base && (
            <label className="bridge-auto">
              <input
                type="checkbox"
                aria-label="自动导入新照片"
                checked={autoImport}
                onChange={(e) => {
                  autoImportRef.current = e.target.checked
                  setAutoImport(e.target.checked)
                  rememberAutoImport(e.target.checked)
                }}
              />
              <span>自动导入新照片</span>
            </label>
          )}
          {base && photos.length > 1 && onImportMany && (
            <div className="bridge-batch">
              <span>把当前列表一次送进批量处理（最多 {MAX_BATCH_IMPORT} 张）</span>
              <button
                type="button"
                className="bridge-import"
                disabled={!!importing}
                onClick={() => void importMany(photos)}
              >
                {importing?.startsWith('many') ? '导入中…' : '导入全部'}
              </button>
            </div>
          )}

          {base && control?.capabilities.liveView && (
            <div className="bridge-live">
              <CameraLiveView
                src={bridgeUrl(base, `/api/camera/liveview?t=${liveTick}`, token)}
              />
              {control.previewDiagnostic && (
                <p className="bridge-hint" role="status">{control.previewDiagnostic}</p>
              )}
              {control.capabilities.shutter && (
                <button
                  type="button"
                  className="bridge-shutter"
                  disabled={shutterBusy || intervalBusy || bracketBusy || focusBusy}
                  onClick={() => void shoot()}
                >
                  {shutterBusy ? '拍摄中…' : '拍一张'}
                </button>
              )}
            </div>
          )}

          {base && control?.capabilities.shutter && (
            <div className="bridge-interval" aria-label="间隔拍摄">
              <label>
                <span>张数</span>
                <input
                  type="number"
                  aria-label="间隔拍摄张数"
                  min={2}
                  max={20}
                  value={intervalCount}
                  disabled={intervalBusy || bracketBusy || focusBusy}
                  onChange={e => setIntervalCount(Math.max(2, Math.min(20, Number(e.target.value) || 2)))}
                />
              </label>
              <label>
                <span>间隔</span>
                <input
                  type="number"
                  aria-label="间隔拍摄秒数"
                  min={1}
                  max={60}
                  value={intervalSeconds}
                  disabled={intervalBusy || bracketBusy || focusBusy}
                  onChange={e => setIntervalSeconds(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
                />
                <span>秒</span>
              </label>
              <button
                type="button"
                className={`crop-chip${intervalBusy ? ' on' : ''}`}
                disabled={!intervalBusy && (shutterBusy || bracketBusy || focusBusy)}
                onClick={() => intervalBusy ? stopInterval() : void runInterval()}
              >
                {intervalBusy
                  ? `停止 ${intervalProgress?.done ?? 0}/${intervalProgress?.total ?? intervalCount}`
                  : '间隔拍摄'}
              </button>
              {intervalProgress && (
                <span className="bridge-interval-status" role="status">
                  已拍 {intervalProgress.done}/{intervalProgress.total}
                </span>
              )}
            </div>
          )}

          {base && control?.capabilities.shutter && bracketReady && (
            <div className="bridge-interval bridge-bracket" aria-label="包围曝光">
              <label>
                <span>张数</span>
                <select
                  aria-label="包围曝光张数"
                  value={bracketShots}
                  disabled={bracketBusy || intervalBusy || focusBusy}
                  onChange={e => setBracketShots(Number(e.target.value) === 5 ? 5 : 3)}
                >
                  <option value={3}>3 张</option>
                  <option value={5}>5 张</option>
                </select>
              </label>
              <label>
                <span>步长</span>
                <select
                  aria-label="包围曝光步长"
                  value={bracketStep}
                  disabled={bracketBusy || intervalBusy || focusBusy}
                  onChange={e => setBracketStep(Number(e.target.value) as BracketStep)}
                >
                  <option value={0.3}>0.3 EV</option>
                  <option value={0.7}>0.7 EV</option>
                  <option value={1}>1 EV</option>
                </select>
              </label>
              <button
                type="button"
                className={`crop-chip${bracketBusy ? ' on' : ''}`}
                disabled={!bracketBusy && (shutterBusy || intervalBusy || focusBusy)}
                onClick={() => bracketBusy ? stopBracket() : void runBracket()}
              >
                {bracketBusy
                  ? `停止包围 ${bracketProgress?.done ?? 0}/${bracketProgress?.total ?? bracketShots}`
                  : '包围曝光'}
              </button>
              {bracketProgress && (
                <span className="bridge-interval-status" role="status">
                  已拍 {bracketProgress.done}/{bracketProgress.total}
                </span>
              )}
            </div>
          )}
          {base && bracketFresh.length >= 2 && onHdrMany && (
            <div className="bridge-interval bridge-hdr" aria-label="包围曝光送 HDR">
              <span className="bridge-interval-status" role="status">
                已保留 {bracketFresh.length} 张包围曝光
              </span>
              <button
                type="button"
                className="crop-chip"
                disabled={!!importing || bracketBusy || focusBusy}
                onClick={() => void importBracketHdr()}
              >
                {importing?.startsWith('hdr:') ? importing : '用这组做 HDR'}
              </button>
            </div>
          )}

          {base && control?.capabilities.shutter && focusReady && focusField && (
            <div className="bridge-interval bridge-focus" aria-label="焦点包围">
              <label>
                <span>张数</span>
                <select
                  aria-label="焦点包围张数"
                  value={focusShots}
                  disabled={focusBusy || bracketBusy || intervalBusy}
                  onChange={e => setFocusShots(Number(e.target.value) === 5 ? 5 : 3)}
                >
                  <option value={3}>3 张</option>
                  <option value={5}>5 张</option>
                </select>
              </label>
              <label>
                <span>范围</span>
                <select
                  aria-label="焦点包围范围"
                  value={focusSpan}
                  disabled={focusBusy || bracketBusy || intervalBusy}
                  onChange={e => setFocusSpan(Number(e.target.value) as FocusBracketSpan)}
                >
                  <option value={5}>窄 5%</option>
                  <option value={10}>中 10%</option>
                  <option value={20}>宽 20%</option>
                </select>
              </label>
              <button
                type="button"
                className={`crop-chip${focusBusy ? ' on' : ''}`}
                disabled={!focusBusy && (shutterBusy || intervalBusy || bracketBusy)}
                onClick={() => focusBusy ? stopFocus() : void runFocusBracket()}
              >
                {focusBusy
                  ? `停止焦点 ${focusProgress?.done ?? 0}/${focusProgress?.total ?? focusShots}`
                  : '焦点包围'}
              </button>
              {focusProgress && (
                <span className="bridge-interval-status" role="status">
                  已拍 {focusProgress.done}/{focusProgress.total}
                </span>
              )}
            </div>
          )}
          {base && focusFresh.length >= 2 && onFocusMany && (
            <div className="bridge-interval bridge-focus-stack" aria-label="焦点包围送焦点堆栈">
              <span className="bridge-interval-status" role="status">
                已保留 {focusFresh.length} 张焦点包围
              </span>
              <button
                type="button"
                className="crop-chip"
                disabled={!!importing || focusBusy}
                onClick={() => void importFocusStack()}
              >
                {importing?.startsWith('focus:') ? importing : '用这组做焦点堆栈'}
              </button>
            </div>
          )}

          {base && control?.capabilities.settings && control.settingsSchema?.length && settings && (
            <div className="bridge-settings">
              <div className="bridge-settings-head">
                <span>相机参数</span>
                <span>由当前相机适配器提供</span>
              </div>
              <div className="bridge-settings-grid">
                {control.settingsSchema.map(item => (
                  <label key={item.key} className="bridge-setting">
                    <span>{item.label}</span>
                    {item.type === 'select' ? (
                      <select
                        aria-label={item.label}
                        value={String(settings[item.key] ?? '')}
                        disabled={item.readOnly}
                        onChange={e => setSettings(s => s
                          ? { ...s, [item.key]: e.target.value }
                          : s)}
                      >
                        {item.options?.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        aria-label={item.label}
                        type="number"
                        min={item.min}
                        max={item.max}
                        step={item.step}
                        value={Number(settings[item.key] ?? 0)}
                        disabled={item.readOnly}
                        onChange={e => setSettings(s => s
                          ? { ...s, [item.key]: Number(e.target.value) }
                          : s)}
                      />
                    )}
                  </label>
                ))}
              </div>
              <button
                type="button"
                className="bridge-settings-apply"
                disabled={settingsBusy}
                onClick={() => void applySettings()}
              >
                {settingsBusy ? '应用中…' : '应用参数'}
              </button>
              <div className="bridge-presets">
                <div className="bridge-presets-head">
                  <span>拍摄预设</span>
                  <span>只在本机保存</span>
                </div>
                <div className="bridge-presets-row">
                  <input
                    type="text"
                    aria-label="拍摄参数预设名称"
                    value={presetName}
                    maxLength={40}
                    placeholder={`${control.model || '相机'} 参数`}
                    onChange={event => { setPresetName(event.target.value); setPresetNote(null) }}
                  />
                  <button type="button" className="crop-chip" onClick={savePreset}>
                    存为我的参数
                  </button>
                </div>
                {presets.length > 0 && (
                  <div className="bridge-presets-row">
                    <select
                      aria-label="拍摄参数预设"
                      value={presetId}
                      onChange={event => { setPresetId(event.target.value); setPresetNote(null) }}
                    >
                      <option value="">选一套预设</option>
                      {presets.map(preset => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}{preset.model ? ` · ${preset.model}` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="crop-chip"
                      disabled={!presetId || settingsBusy}
                      onClick={() => void applyPreset()}
                    >套用预设</button>
                    <button
                      type="button"
                      className="crop-chip"
                      disabled={!presetId || settingsBusy}
                      onClick={removePreset}
                    >删除预设</button>
                  </div>
                )}
                {presetNote && <p className="bridge-hint">{presetNote}</p>}
              </div>
            </div>
          )}

          {photos.length > 0 ? (
            <ul className="bridge-list" aria-label="相机里的照片">
              {photos.map(photo => (
                <li key={photo.id} className="bridge-photo">
                  <span className="bridge-thumb" aria-hidden="true">
                    <img
                      src={bridgeUrl(base!, photo.url, token)}
                      alt=""
                      onError={e => { e.currentTarget.style.display = 'none' }}
                    />
                    <span>{photo.name.split('.').pop()?.toUpperCase()}</span>
                  </span>
                  <span className="bridge-photo-copy">
                    <strong title={photo.folder ? `${photo.folder}/${photo.name}` : photo.name}>
                      {photo.name}
                    </strong>
                    {photo.raw && <span className="bridge-pair">JPG + RAW</span>}
                    {photo.sidecar && <span className="bridge-pair">XMP</span>}
                    <span>
                      {photo.folder ? `${photo.folder} · ` : ''}
                      {sizeText(photo.size)}
                      {photo.raw ? ` · RAW ${sizeText(photo.raw.size)}` : ''}
                      {timeText(photo.mtime) ? ` · ${timeText(photo.mtime)}` : ''}
                    </span>
                  </span>
                  <span className="bridge-actions">
                    {photo.raw && (
                      <button
                        type="button"
                        className="bridge-original"
                        disabled={!!importing}
                        title="导入同名 RAW 原片；浏览器可能无法直接解码"
                        onClick={() => void importPhoto(photo.raw!, false)}
                      >
                        RAW
                      </button>
                    )}
                    {photo.convertUrl && (
                      <button
                        type="button"
                        className="bridge-original"
                        disabled={!!importing}
                        title="导入相机原始文件；浏览器可能无法直接解码 RAW / HEIC"
                        onClick={() => void importPhoto(photo, false)}
                      >
                        原图
                      </button>
                    )}
                    <button
                      type="button"
                      className="bridge-import"
                      disabled={!!importing}
                      onClick={() => void importPhoto(photo, !!photo.convertUrl)}
                    >
                      {importing === photo.id
                        ? (photo.convertUrl ? '转 JPG 中…' : '取回中…')
                        : (photo.convertUrl ? '导入 JPG' : '导入')}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="bridge-empty">
              <FolderOpen size={22} strokeWidth={1.5} aria-hidden="true" />
              <p>{base ? '还没有照片。相机一落盘，这里会自动出现。' : '连接后，这里会列出相机刚拍的照片。'}</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
