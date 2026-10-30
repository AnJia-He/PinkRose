import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type {
  CameraControlProvider,
  CameraControlStatus,
  CameraSettingDescriptor,
  CameraSettings,
  CameraSettingValue,
} from './cameraBridge.ts'
import { sonyCameraBaseUrl } from './sonyCameraUrl.ts'

/**
 * Sony Camera Remote API provider.
 *
 * The camera exposes a JSON-RPC-like endpoint under `/sony/camera`; remote
 * shooting normally has to start with `startRecMode`. Live view is a binary
 * stream with an 8-byte common header and a 128-byte payload header before
 * each JPEG.
 */

type FetchLike = typeof fetch
type JsonObject = Record<string, unknown>

const SETTINGS_TTL_MS = 2_500
const API_TTL_MS = 30_000
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024
const PHOTO_EXT = /\.(?:avif|arw|cr2|cr3|dng|heic|heif|jpe?g|png|tif|tiff|webp)$/i

const LABELS: Record<string, string> = {
  iso: 'ISO',
  shutter: '快门',
  aperture: '光圈',
  exposureCompensation: '曝光补偿（档位）',
  focusMode: '对焦模式',
  whiteBalance: '白平衡',
}

type SettingsState = {
  values: CameraSettings
  schema: CameraSettingDescriptor[]
  at: number
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.flatMap(item => {
    const one = stringValue(item)
    return one === null ? [] : [one]
  }))].slice(0, 512)
}

function selectedAndCandidates(result: unknown): { current: string | null; candidates: string[] } {
  if (!Array.isArray(result)) return { current: null, candidates: [] }
  return {
    current: stringValue(result[0]),
    candidates: stringList(result[1]),
  }
}

function selectDescriptor(
  key: string,
  current: string | null,
  candidates: string[],
  readOnly = false,
): { value: CameraSettingValue; descriptor: CameraSettingDescriptor } | null {
  if (current === null) return null
  const values = candidates.length > 0 ? candidates : [current]
  return {
    value: current,
    descriptor: {
      key,
      label: LABELS[key] ?? key,
      type: 'select',
      ...(readOnly ? { readOnly: true } : {}),
      options: values.map(item => ({ value: item, label: item })),
    },
  }
}

function isPhotoName(name: string): boolean {
  return PHOTO_EXT.test(extname(name))
}

function safePhotoName(url: string): string {
  let pathname = url.split('?')[0] ?? ''
  try {
    pathname = new URL(url, 'http://sony.local').pathname
  } catch {
    // Keep relative path.
  }
  let name = ''
  try {
    name = decodeURIComponent(basename(pathname))
  } catch {
    name = basename(pathname)
  }
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || !isPhotoName(name)) {
    throw new Error('Sony 相机返回的照片文件名不合法')
  }
  return name
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>, ms: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sony 实时取景读取超时')), ms)
    reader.read().then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
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

export type SonyCameraOptions = {
  root: string
  url: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

export function createSonyCameraProvider(options: SonyCameraOptions): CameraControlProvider {
  const root = options.root
  const base = sonyCameraBaseUrl(options.url)
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 8_000
  let queue = Promise.resolve()
  let apiList: string[] | null = null
  let apiListAt = 0
  let recMode = false
  let settingsCache: SettingsState | null = null
  let liveUrl: string | null = null
  let liveReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let liveController: AbortController | null = null
  let liveBuffer = Buffer.alloc(0)

  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  async function rpc(
    method: string,
    params: unknown[] = [],
    version = '1.0',
    target = 'camera',
  ): Promise<unknown> {
    const response = await fetchImpl(`${base}/sony/${target}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ method, params, id: 1, version }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`Sony Camera API returned HTTP ${response.status}`)
    const body = object(await response.json())
    if (!body) throw new Error('Sony Camera API returned malformed JSON')
    if (body.error !== undefined) throw new Error('Sony Camera API rejected the request')
    return body.result
  }

  async function availableApis(force = false): Promise<string[]> {
    if (!force && apiList && Date.now() - apiListAt < API_TTL_MS) return apiList
    const result = await rpc('getAvailableApiList')
    apiList = Array.isArray(result) ? stringList(result[0]) : []
    apiListAt = Date.now()
    return apiList
  }

  async function ensureRemoteMode(apis: string[]): Promise<void> {
    if (recMode || !apis.includes('startRecMode')) return
    try {
      await rpc('startRecMode')
      recMode = true
      apiList = null
    } catch {
      // Some camera apps are already in remote mode. The next API call will
      // tell whether remote shooting is actually available.
      recMode = true
    }
  }

  async function loadSettings(force = false): Promise<SettingsState> {
    if (!force && settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) {
      return settingsCache
    }
    const apis = await availableApis()
    const values: CameraSettings = {}
    const schema: CameraSettingDescriptor[] = []

    const addSelect = async (
      key: string,
      availableMethod: string,
      currentMethod: string,
      readOnly = false,
    ) => {
      try {
        let current: string | null = null
        let candidates: string[] = []
        if (apis.includes(availableMethod)) {
          const picked = selectedAndCandidates(await rpc(availableMethod))
          current = picked.current
          candidates = picked.candidates
        } else if (apis.includes(currentMethod)) {
          const result = await rpc(currentMethod)
          current = Array.isArray(result) ? stringValue(result[0]) : null
        }
        const made = selectDescriptor(key, current, candidates, readOnly)
        if (made) {
          values[key] = made.value
          schema.push(made.descriptor)
        }
      } catch {
        // API presence can depend on the current exposure mode.
      }
    }

    await addSelect('iso', 'getAvailableIsoSpeedRate', 'getIsoSpeedRate')
    await addSelect('shutter', 'getAvailableShutterSpeed', 'getShutterSpeed')
    await addSelect('aperture', 'getAvailableFNumber', 'getFNumber')
    await addSelect('focusMode', 'getAvailableFocusMode', 'getFocusMode')

    if (apis.includes('getAvailableExposureCompensation')) {
      try {
        const result = await rpc('getAvailableExposureCompensation')
        if (Array.isArray(result) && result.length >= 4) {
          const current = Number(result[0])
          const first = Number(result[1])
          const second = Number(result[2])
          const step = Number(result[3])
          if ([current, first, second, step].every(Number.isFinite)) {
            values.exposureCompensation = current
            schema.push({
              key: 'exposureCompensation',
              label: LABELS.exposureCompensation!,
              type: 'number',
              min: Math.min(first, second),
              max: Math.max(first, second),
              step: step > 0 ? step : 1,
            })
          }
        }
      } catch {
        // Optional setting.
      }
    }

    if (apis.includes('getAvailableWhiteBalance')) {
      try {
        const result = await rpc('getAvailableWhiteBalance')
        if (Array.isArray(result)) {
          const current = object(result[0])
          const mode = current ? stringValue(current.whiteBalanceMode) : null
          const candidates = Array.isArray(result[1])
            ? result[1].flatMap(item => {
              const entry = object(item)
              const name = entry ? stringValue(entry.whiteBalanceMode) : null
              return name === null ? [] : [name]
            })
            : []
          const made = selectDescriptor('whiteBalance', mode, candidates, true)
          if (made) {
            values.whiteBalance = made.value
            schema.push(made.descriptor)
          }
        }
      } catch {
        // Optional setting.
      }
    }

    settingsCache = { values, schema, at: Date.now() }
    return settingsCache
  }

  async function status(): Promise<CameraControlStatus> {
    try {
      const apis = await availableApis(true)
      await ensureRemoteMode(apis)
      if (apiList === null) await availableApis(true)
      let info: unknown = null
      try { info = await rpc('getApplicationInfo') } catch {
        // Application info is optional.
      }
      const infoList = Array.isArray(info) ? info : []
      const nested = Array.isArray(infoList[0]) ? infoList[0] : infoList
      const model = stringValue(nested[0]) ?? 'Sony Camera'
      let canImport = false
      try {
        const contentResult = await rpc(
          'getAvailableApiList', [], '1.0', 'avContent',
        )
        const contentApis = Array.isArray(contentResult)
          ? stringList(contentResult[0])
          : []
        canImport = ['getSchemeList', 'getSourceList', 'getContentList']
          .every(method => contentApis.includes(method))
      } catch {
        // Some models expose content transfer only after changing camera
        // function; the import action itself will retry after switching.
        canImport = true
      }
      let settings: SettingsState | null = null
      try { settings = await loadSettings() } catch {
        // Status and shutter can still work before parameters are ready.
      }
      return {
        connected: true,
        model: model.slice(0, 120),
        capabilities: {
          liveView: apis.includes('startLiveview') || apis.includes('startLiveviewWithSize'),
          shutter: apis.includes('actTakePicture'),
          settings: !!settings && settings.schema.length > 0,
          import: canImport,
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
          '连不上 Sony Camera Remote API。在相机里打开 Wi-Fi 的「遥控拍摄」/'
          + ' Smart Remote Control，让电脑加入相机的 Wi-Fi，再确认相机地址和端口。',
      }
    }
  }

  function resetLiveView(): void {
    try { liveController?.abort() } catch { /* already closed */ }
    try { void liveReader?.cancel() } catch { /* already closed */ }
    liveUrl = null
    liveReader = null
    liveController = null
    liveBuffer = Buffer.alloc(0)
  }

  async function openLiveView(): Promise<void> {
    if (liveReader) return
    const apis = await availableApis()
    if (!liveUrl) {
      if (apis.includes('setLiveviewFrameInfo')) {
        await rpc('setLiveviewFrameInfo', [{ frameInfo: false }]).catch(() => {})
      }
      const result = apis.includes('startLiveview')
        ? await rpc('startLiveview')
        : apis.includes('startLiveviewWithSize')
          ? await rpc('startLiveviewWithSize', ['M'])
          : null
      const urls = Array.isArray(result) ? result.flatMap(item =>
        Array.isArray(item) ? stringList(item) : stringValue(item) === null ? [] : [String(stringValue(item))]) : []
      liveUrl = urls[0] ?? null
      if (!liveUrl) throw new Error('Sony 相机没有返回实时取景地址')
    }
    liveController = new AbortController()
    const response = await fetchImpl(liveUrl, {
      signal: liveController.signal,
    })
    if (!response.ok || !response.body) throw new Error('Sony 实时取景流打不开')
    liveReader = response.body.getReader()
    liveBuffer = Buffer.alloc(0)
  }

  async function fillBuffer(size: number): Promise<void> {
    while (liveBuffer.length < size) {
      if (!liveReader) throw new Error('Sony 实时取景流没有打开')
      const next = await readWithTimeout(liveReader, timeoutMs)
      if (next.done) throw new Error('Sony 实时取景流结束了')
      if (!next.value) throw new Error('Sony 实时取景没有返回数据')
      liveBuffer = Buffer.concat([liveBuffer, Buffer.from(next.value)])
    }
  }

  async function liveView(): Promise<Uint8Array | null> {
    try {
      await openLiveView()
      await fillBuffer(136)
      if (liveBuffer[0] !== 0xff) throw new Error('Sony 实时取景头不对')
      if (liveBuffer.readUInt32BE(8) !== 0x24356879) {
        throw new Error('Sony 实时取景 payload 头不对')
      }
      const size = (liveBuffer[12]! << 16) | (liveBuffer[13]! << 8) | liveBuffer[14]!
      const padding = liveBuffer[15]!
      if (size < 4 || size > 16 * 1024 * 1024) throw new Error('Sony 实时取景帧尺寸不对')
      await fillBuffer(136 + size + padding)
      const frame = liveBuffer.subarray(136, 136 + size)
      liveBuffer = liveBuffer.subarray(136 + size + padding)
      return new Uint8Array(frame)
    } catch (error) {
      resetLiveView()
      throw error
    }
  }

  async function downloadPhoto(url: string): Promise<string> {
    const name = safePhotoName(url)
    let absolute: string
    try {
      absolute = new URL(url, `${base}/`).toString()
    } catch {
      throw new Error('Sony 相机返回的照片地址不合法')
    }
    const response = await fetchImpl(absolute, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Sony 照片下载失败：HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < 4 || bytes.length > MAX_DOWNLOAD_BYTES) {
      throw new Error('Sony 照片为空或超过 128MB')
    }
    await mkdir(root, { recursive: true })
    const destination = await freeDestination(root, name)
    await writeFile(destination, bytes, { flag: 'wx' })
    return basename(destination)
  }

  async function capture(): Promise<{ saved?: string }> {
    const apis = await availableApis()
    await ensureRemoteMode(apis)
    const result = await rpc('actTakePicture')
    const urls: string[] = []
    if (Array.isArray(result)) {
      for (const item of result) {
        if (Array.isArray(item)) urls.push(...stringList(item))
        else {
          const one = stringValue(item)
          if (one !== null) urls.push(one)
        }
      }
    }
    const photo = urls.find(url => {
      try {
        return isPhotoName(safePhotoName(url))
      } catch {
        return false
      }
    })
    if (!photo) return {}
    return { saved: await downloadPhoto(photo) }
  }

  function contentUrl(item: unknown): { url: string; name: string | null } | null {
    const entry = object(item)
    const content = entry ? object(entry.content) : null
    const originals = content && Array.isArray(content.original) ? content.original : []
    const first = object(originals[0])
    const url = first ? stringValue(first.url) : null
    if (!url) return null
    return {
      url,
      name: first ? stringValue(first.fileName) : null,
    }
  }

  async function importRecent(limit: number): Promise<{ imported: string[] }> {
    let changedFunction = false
    try {
      try {
        await rpc('setCameraFunction', ['Contents Transfer'])
        changedFunction = true
      } catch {
        // Some bodies expose avContent without changing camera function.
      }
      let items: unknown[] = []
      const schemeResult = await rpc('getSchemeList', [], '1.0', 'avContent')
      const schemeEntry = Array.isArray(schemeResult) && Array.isArray(schemeResult[0])
        ? object(schemeResult[0][0])
        : null
      const scheme = schemeEntry ? stringValue(schemeEntry.scheme) : null
      if (scheme) {
        const sourceResult = await rpc(
          'getSourceList', [{ scheme }], '1.0', 'avContent',
        )
        const sourceEntry = Array.isArray(sourceResult) && Array.isArray(sourceResult[0])
          ? object(sourceResult[0][0])
          : null
        const source = sourceEntry ? stringValue(sourceEntry.source) : null
        if (source) {
          try {
            const datesResult = await rpc('getContentList', [{
              uri: source,
              stIdx: 0,
              cnt: Math.min(limit, 20),
              type: ['still'],
              view: 'date',
              sort: 'descending',
            }], '1.3', 'avContent')
            const dates = Array.isArray(datesResult) && Array.isArray(datesResult[0])
              ? datesResult[0]
              : []
            for (const rawDate of dates) {
              if (items.length >= limit) break
              const date = object(rawDate)
              const uri = date ? stringValue(date.uri) : null
              if (!uri) continue
              const count = date ? Math.max(1, Number(date.contentCount) || limit) : limit
              const remaining = limit - items.length
              const page = await rpc('getContentList', [{
                uri,
                stIdx: 0,
                cnt: Math.min(count, remaining),
                type: ['still'],
                view: 'date',
                sort: 'descending',
              }], '1.3', 'avContent')
              if (Array.isArray(page) && Array.isArray(page[0])) {
                items.push(...page[0])
              }
            }
          } catch {
            // Fall back to flat view below.
          }
          if (items.length === 0) {
            const flat = await rpc('getContentList', [{
              uri: source,
              stIdx: 0,
              cnt: limit,
              type: ['still'],
              view: 'flat',
              sort: 'descending',
            }], '1.3', 'avContent')
            if (Array.isArray(flat) && Array.isArray(flat[0])) items = flat[0]
          }
        }
      }
      const imported: string[] = []
      for (const item of items.slice(0, limit)) {
        const media = contentUrl(item)
        if (!media) continue
        let name: string
        try {
          name = media.name && isPhotoName(media.name)
            ? media.name
            : safePhotoName(media.url)
          if (!isPhotoName(name) || (await stat(join(root, name)).catch(() => null))) {
            continue
          }
        } catch {
          continue
        }
        imported.push(await downloadPhoto(media.url))
      }
      return { imported }
    } finally {
      if (changedFunction) {
        recMode = false
        apiList = null
        await rpc('setCameraFunction', ['Remote Shooting']).catch(() => {})
      }
    }
  }

  async function getSettings(): Promise<CameraSettings> {
    return { ...(await loadSettings(true)).values }
  }

  async function setSettings(patch: CameraSettings): Promise<CameraSettings> {
    const methodFor: Record<string, { method: string; convert: (value: CameraSettingValue) => unknown }> = {
      iso: { method: 'setIsoSpeedRate', convert: value => String(value) },
      shutter: { method: 'setShutterSpeed', convert: value => String(value) },
      aperture: { method: 'setFNumber', convert: value => String(value) },
      focusMode: { method: 'setFocusMode', convert: value => String(value) },
      exposureCompensation: { method: 'setExposureCompensation', convert: value => Number(value) },
    }
    const apis = await availableApis()
    for (const [key, value] of Object.entries(patch)) {
      const target = methodFor[key]
      if (!target || !apis.includes(target.method)) continue
      try {
        await rpc(target.method, [target.convert(value)])
      } catch {
        throw new Error(`相机没有接受「${LABELS[key] ?? key}」这个值。`
          + '先确认当前拍摄模式允许修改这项设置。')
      }
    }
    settingsCache = null
    return getSettings()
  }

  return {
    status: () => exclusive(status),
    liveView: () => exclusive(liveView),
    capture: () => exclusive(capture),
    importRecent: limit => exclusive(() => importRecent(limit)),
    getSettings: () => exclusive(getSettings),
    setSettings: patch => exclusive(() => setSettings(patch)),
  }
}
