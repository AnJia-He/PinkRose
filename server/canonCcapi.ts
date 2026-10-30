import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type {
  CameraControlProvider,
  CameraControlStatus,
  CameraSettingDescriptor,
  CameraSettings,
  CameraSettingValue,
} from './cameraBridge.ts'
import { canonCcapiBaseUrl } from './canonCcapiUrl.ts'

/**
 * Canon Camera Control API (CCAPI) provider.
 *
 * Unlike EDSDK, CCAPI is an HTTP interface exposed by many Wi-Fi-capable Canon
 * bodies. The bridge talks to the camera directly, so an iPhone / iPad only
 * needs the normal bridge URL and token. This adapter deliberately implements
 * a conservative subset that is shared by common bodies:
 *
 *   - device status and live view
 *   - still shutter
 *   - ISO / shutter / aperture / exposure / WB / drive / AF / metering
 *   - download the newly captured file back into the bridge watch folder
 *
 * CCAPI is not available until it is enabled on the camera for the first time.
 * A successful fake-server test proves the protocol wiring, not every body's
 * menu names or firmware behaviour; hardware acceptance is still required.
 */

type JsonObject = Record<string, unknown>
type FetchLike = typeof fetch

const DEFAULT_VERSIONS = ['ver130', 'ver110', 'ver100']
const SETTINGS_TTL_MS = 3_000
const VERSIONS_TTL_MS = 30_000
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024
const PHOTO_EXT = /\.(?:avif|cr2|cr3|dng|heic|heif|jpe?g|png|tif|tiff|webp)$/i

const SETTING_LABELS: Record<string, string> = {
  iso: 'ISO',
  tv: '快门',
  av: '光圈',
  exposure: '曝光补偿',
  wb: '白平衡',
  colortemperature: '色温',
  drive: '驱动模式',
  afmethod: '自动对焦方式',
  metering: '测光',
  shootingmodedial: '拍摄模式',
}

const EDITABLE_SETTINGS = new Set(Object.keys(SETTING_LABELS))

type CachedSettings = {
  at: number
  version: string
  values: CameraSettings
  schema: CameraSettingDescriptor[]
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function scalar(value: unknown): CameraSettingValue | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

function optionList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const direct = scalar(item)
    if (direct !== null) {
      out.push(String(direct))
      continue
    }
    const entry = object(item)
    const nested = entry ? scalar(entry.value) : null
    if (nested !== null) out.push(String(nested))
  }
  return [...new Set(out)].slice(0, 512)
}

function abilityOptions(ability: unknown): string[] {
  const direct = optionList(ability)
  if (direct.length > 0) return direct
  const record = object(ability)
  if (!record) return []
  for (const key of ['values', 'list', 'options']) {
    const options = optionList(record[key])
    if (options.length > 0) return options
  }
  return []
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function descriptorFor(
  key: string, entry: JsonObject,
): { value: CameraSettingValue; descriptor: CameraSettingDescriptor } | null {
  const value = scalar(entry.value)
  if (value === null) return null
  const label = SETTING_LABELS[key] ?? key
  const ability = object(entry.ability)
  const min = ability ? finiteNumber(ability.min) : null
  const max = ability ? finiteNumber(ability.max) : null
  const step = ability ? finiteNumber(ability.step) : null
  if (min !== null && max !== null && min <= max) {
    const numericValue = finiteNumber(value)
    if (numericValue !== null) {
      return {
        value: numericValue,
        descriptor: {
          key,
          label,
          type: 'number',
          min,
          max,
          step: step && step > 0 ? step : 1,
        },
      }
    }
  }
  const options = abilityOptions(entry.ability)
  const values = options.length > 0 ? options : [String(value)]
  return {
    value,
    descriptor: {
      key,
      label,
      type: 'select',
      options: values.map(item => ({ value: item, label: item })),
    },
  }
}

function parsePaths(value: unknown): string[] {
  const record = object(value)
  if (!record) return []
  const path = record.path
  if (typeof path === 'string') return [path]
  if (!Array.isArray(path)) return []
  return path.flatMap(item => {
    if (typeof item === 'string') return [item]
    const entry = object(item)
    const href = entry ? scalar(entry.path ?? entry.href) : null
    return href === null ? [] : [String(href)]
  })
}

function isPhotoHref(href: string): boolean {
  try {
    return PHOTO_EXT.test(new URL(href, 'http://camera.local').pathname)
  } catch {
    return PHOTO_EXT.test(href.split('?')[0] ?? '')
  }
}

function safePhotoName(href: string): string {
  let pathname = href.split('?')[0] ?? ''
  try {
    pathname = new URL(href, 'http://camera.local').pathname
  } catch {
    // Keep the already relative path.
  }
  let name = ''
  try {
    name = decodeURIComponent(basename(pathname))
  } catch {
    name = basename(pathname)
  }
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)
    || !PHOTO_EXT.test(extname(name))) {
    throw new Error('相机返回的照片文件名不合法')
  }
  return name
}

async function freeDestination(root: string, name: string): Promise<string> {
  const stem = name.slice(0, Math.max(0, name.length - extname(name).length))
  const ext = extname(name)
  for (let index = 1; index <= 100; index++) {
    const candidate = join(root, index === 1 ? name : `${stem}-${index}${ext}`)
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('相机目录里同名照片太多，先整理一下再拍。')
}

export type CanonCcapiOptions = {
  root: string
  url: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  capturePollMs?: number
  captureWaitMs?: number
}

export function createCanonCcapiCameraProvider(
  options: CanonCcapiOptions,
): CameraControlProvider {
  const root = options.root
  const base = canonCcapiBaseUrl(options.url)
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 6_000
  const capturePollMs = options.capturePollMs ?? 400
  const captureWaitMs = options.captureWaitMs ?? 10_000
  let versions = [...DEFAULT_VERSIONS]
  let versionsAt = 0
  let settingsCache: CachedSettings | null = null
  let liveViewStarted = false
  let queue = Promise.resolve()

  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = /^https?:\/\//i.test(path) ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        accept: 'application/json, image/jpeg, image/png',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`Canon CCAPI returned HTTP ${response.status}`)
    }
    return response
  }

  async function json(path: string, init: RequestInit = {}): Promise<JsonObject> {
    const response = await request(path, init)
    const value: unknown = await response.json()
    const record = object(value)
    if (!record) throw new Error('Canon CCAPI returned malformed JSON')
    return record
  }

  async function readVersions(): Promise<string[]> {
    if (versionsAt > 0 && Date.now() - versionsAt < VERSIONS_TTL_MS) return versions
    versionsAt = Date.now()
    try {
      const rootApi = await json('/ccapi')
      const found = Object.keys(rootApi)
        .filter(key => /^ver\d+$/i.test(key))
        .sort()
        .reverse()
      if (found.length > 0) versions = found
    } catch {
      // Some bodies briefly return 503 while Wi-Fi starts. The versioned
      // endpoints below still give a useful connection result.
    }
    return versions
  }

  async function firstVersionedJson(suffix: string): Promise<{ version: string; data: JsonObject }> {
    let lastError: unknown = null
    for (const version of await readVersions()) {
      try {
        return {
          version,
          data: await json(`/ccapi/${version}/${suffix}`),
        }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('Canon CCAPI 没有可用版本')
  }

  async function loadSettings(force = false): Promise<CachedSettings> {
    if (!force && settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) {
      return settingsCache
    }
    const result = await firstVersionedJson('shooting/settings')
    const values: CameraSettings = {}
    const schema: CameraSettingDescriptor[] = []
    for (const key of EDITABLE_SETTINGS) {
      const entry = object(result.data[key])
      if (!entry) continue
      const parsed = descriptorFor(key, entry)
      if (!parsed) continue
      values[key] = parsed.value
      schema.push(parsed.descriptor)
    }
    try {
      const battery = await firstVersionedJson('devicestatus/battery')
      const level = finiteNumber(battery.data.level)
      if (level !== null) {
        values.battery = Math.max(0, Math.min(100, Math.round(level)))
        schema.push({
          key: 'battery',
          label: '电量',
          type: 'number',
          min: 0,
          max: 100,
          step: 1,
          readOnly: true,
        })
      }
    } catch {
      // Battery is optional; settings are still useful without it.
    }
    settingsCache = {
      at: Date.now(),
      version: result.version,
      values,
      schema,
    }
    return settingsCache
  }

  async function cameraStatus(): Promise<CameraControlStatus> {
    try {
      const info = await firstVersionedJson('deviceinformation')
      let settings: CachedSettings | null = null
      try {
        settings = await loadSettings()
      } catch {
        // A body may expose device information before shooting settings are
        // ready; keep shutter/live-view available and report settings off.
      }
      const modelValue = info.data.productname
        ?? info.data.modelname
        ?? info.data.model
        ?? info.data.devicename
      const model = scalar(modelValue)
      return {
        connected: true,
        model: model === null ? 'Canon Camera' : String(model).slice(0, 120),
        capabilities: {
          liveView: true,
          shutter: true,
          settings: !!settings && settings.schema.length > 0,
          import: true,
        },
        settingsSchema: settings?.schema ?? [],
      }
    } catch {
      return {
        connected: false,
        model: null,
        capabilities: { liveView: false, shutter: false, settings: false },
        settingsSchema: [],
        diagnostic:
          '连不上 Canon CCAPI。先在相机「无线通信设置 → Wi-Fi 设置」里启用'
          + ' Camera Control API，确认电脑和相机在同一网络，并用相机显示的地址重试。',
      }
    }
  }

  async function startLiveView(): Promise<void> {
    if (liveViewStarted) return
    let lastError: unknown = null
    for (const version of await readVersions()) {
      try {
        await json(`/ccapi/${version}/shooting/liveview`, {
          method: 'POST',
          body: JSON.stringify({ liveviewsize: 'medium', cameradisplay: 'off' }),
        })
        liveViewStarted = true
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('Canon CCAPI 没有启动实时取景')
  }

  async function liveViewFrame(): Promise<Uint8Array | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await startLiveView()
      let lastError: unknown = null
      for (const version of await readVersions()) {
        try {
          const response = await request(`/ccapi/${version}/shooting/liveview/flip`)
          const bytes = new Uint8Array(await response.arrayBuffer())
          if (bytes.length < 4) throw new Error('Canon CCAPI 实时取景太短')
          return bytes
        } catch (error) {
          lastError = error
        }
      }
      liveViewStarted = false
      if (attempt > 0) {
        throw lastError ?? new Error('Canon CCAPI 实时取景失败')
      }
    }
    return null
  }

  async function directoryHref(): Promise<string | null> {
    try {
      const result = await firstVersionedJson('devicestatus/currentdirectory')
      return parsePaths(result.data)[0] ?? null
    } catch {
      return null
    }
  }

  async function recentPhotoHrefs(): Promise<string[]> {
    const directory = await directoryHref()
    if (!directory) return []
    try {
      const listing = await json(directory)
      return parsePaths(listing).filter(isPhotoHref)
    } catch {
      return []
    }
  }

  async function shutter(): Promise<void> {
    let lastError: unknown = null
    for (const version of await readVersions()) {
      try {
        await json(`/ccapi/${version}/shooting/control/shutterbutton`, {
          method: 'POST',
          body: JSON.stringify({ af: true }),
        })
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('Canon CCAPI 快门不可用')
  }

  async function downloadPhoto(href: string): Promise<string> {
    const name = safePhotoName(href)
    const response = await request(href)
    const advertised = Number(response.headers.get('content-length') ?? 0)
    if (advertised > MAX_DOWNLOAD_BYTES) {
      throw new Error('相机照片超过 128MB，先降低格式或改用存储卡导入。')
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_DOWNLOAD_BYTES) {
      throw new Error('相机照片为空或超过 128MB')
    }
    await mkdir(root, { recursive: true })
    const destination = await freeDestination(root, name)
    await writeFile(destination, bytes, { flag: 'wx' })
    return basename(destination)
  }

  async function capture(): Promise<{ saved?: string }> {
    const before = new Set(await recentPhotoHrefs())
    await shutter()
    // Without a usable "before" set, an old photo could look new and be
    // imported as if it were just captured. The shot already succeeded, so
    // leave file discovery to the normal folder watcher in this case.
    if (before.size === 0) return {}
    const deadline = Date.now() + captureWaitMs
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, capturePollMs))
      const after = await recentPhotoHrefs()
      const href = after.find(item => !before.has(item))
      if (href) return { saved: await downloadPhoto(href) }
    }
    // The shot still succeeded. Returning no filename lets the normal folder
    // watcher import it when the camera or tether software writes it later.
    return {}
  }

  async function importRecent(limit: number): Promise<{ imported: string[] }> {
    const hrefs = [...new Set(await recentPhotoHrefs())].slice(-limit).reverse()
    const imported: string[] = []
    for (const href of hrefs) {
      let exists = false
      try {
        const name = safePhotoName(href)
        exists = (await stat(join(root, name))).isFile()
      } catch {
        // Missing or malformed means it will be validated by downloadPhoto.
      }
      if (exists) continue
      imported.push(await downloadPhoto(href))
    }
    return { imported }
  }

  async function getSettings(): Promise<CameraSettings> {
    return { ...(await loadSettings(true)).values }
  }

  async function setSettings(patch: CameraSettings): Promise<CameraSettings> {
    const settings = await loadSettings()
    for (const [key, value] of Object.entries(patch)) {
      if (!EDITABLE_SETTINGS.has(key)) continue
      const body = {
        value: typeof value === 'number' ? String(value) : value,
      }
      try {
        await json(`/ccapi/${settings.version}/shooting/settings/${key}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        })
      } catch {
        throw new Error(`相机没有接受「${SETTING_LABELS[key] ?? key}」这个值。`
          + '先在相机菜单里确认当前拍摄模式支持这项设置。')
      }
    }
    settingsCache = null
    return getSettings()
  }

  return {
    status: () => exclusive(cameraStatus),
    liveView: () => exclusive(liveViewFrame),
    capture: () => exclusive(capture),
    importRecent: limit => exclusive(() => importRecent(limit)),
    getSettings: () => exclusive(getSettings),
    setSettings: patch => exclusive(() => setSettings(patch)),
  }
}
