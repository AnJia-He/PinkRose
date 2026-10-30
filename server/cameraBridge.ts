import { createReadStream } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Dirent } from 'node:fs'
import {
  copyFile, mkdir, readdir, readFile, realpath, rename, stat, unlink,
} from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import {
  imageFileFormat, RAW_EXTENSIONS,
  type ImageFileFormat,
} from '../shared/imageFormats.ts'
import {
  convertImageFile, detectImageConverter, detectImageConverters,
  imageConverterArgs, isJpegBytes,
  type ImageConverter,
} from './imageConverter.ts'
import {
  parseCameraControlConfig, savePersistedCameraControl,
  type CameraControlConfig,
} from './cameraRuntimeConfig.ts'

/**
 * 本机相机文件夹桥（★ 2026-10-18）。
 *
 * 目标不是替代厂商 SDK，而是先把**任何能落盘的相机工作流**接进网页：
 * Canon EOS Utility、Sony Imaging Edge、Nikon Camera Control Pro、Capture One
 * 等 tether 软件都可以把照片保存到一个目录；这里只读地列出这个目录，
 * 网页端轮询后把新照片导入现有修图链路。
 *
 * 只监听 127.0.0.1；照片目录接口只读，不接收任意文件写入。只有配置了
 * 可控相机适配器时才开放快门 / 参数，并要求 `x-pinkrose-camera` 标记。
 */

const PHOTO_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.avif',
  '.heic', '.heif', '.tif', '.tiff',
  ...RAW_EXTENSIONS,
])

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.dng': 'image/x-adobe-dng',
  '.cr2': 'image/x-canon-cr2',
  '.cr3': 'image/x-canon-cr3',
  '.nef': 'image/x-nikon-nef',
  '.nrw': 'image/x-nikon-nrw',
  '.arw': 'image/x-sony-arw',
  '.srf': 'image/x-sony-srf',
  '.sr2': 'image/x-sony-sr2',
  '.raf': 'image/x-fuji-raf',
  '.orf': 'image/x-olympus-orf',
  '.rw2': 'image/x-panasonic-rw2',
  '.rwl': 'image/x-leica-rwl',
  '.raw': 'image/x-raw',
  '.pef': 'image/x-pentax-pef',
  '.srw': 'image/x-samsung-srw',
  '.x3f': 'image/x-sigma-x3f',
  '.3fr': 'image/x-hasselblad-3fr',
  '.fff': 'image/x-hasselblad-fff',
  '.iiq': 'image/x-phaseone-iiq',
  '.mos': 'image/x-leaf-mos',
  '.mrw': 'image/x-minolta-mrw',
  '.dcr': 'image/x-kodak-dcr',
  '.kdc': 'image/x-kodak-kdc',
  '.erf': 'image/x-epson-erf',
  '.mef': 'image/x-mamiya-mef',
  '.gpr': 'image/x-gopro-gpr',
  '.xmp': 'application/rdf+xml',
}

export type CameraPhotoFile = {
  id: string
  name: string
  /** 相对桥目录的父目录；根目录照片没有这一项。 */
  folder?: string
  size: number
  mtime: number
  type: string
  /** 同名的 RAW 原片；存在时当前条目是可直接预览的 JPEG。 */
  raw?: CameraPhotoOriginal | null
  /** 同目录同名 XMP 调色旁车。 */
  sidecar?: CameraPhotoOriginal | null
}

export type CameraPhotoOriginal = {
  id: string
  name: string
  size: number
  mtime: number
  type: string
}

export type CameraBridgeOptions = {
  root: string
  allowedOrigins?: readonly string[]
  /**
   * 跨设备访问令牌。为空时保持原来的本机模式（只听 127.0.0.1 时不需要）；
   * 一旦配置，所有读取照片 / 控制相机的请求都要带同一个令牌。
   */
  token?: string | null
  /** 列表最多返回多少张；默认 50。 */
  maxPhotos?: number
  /** 有转换器时，RAW / HEIC / TIFF 可以额外提供 JPG 版本。 */
  converter?: CameraConverter | null
  /** 多个转换器按文件格式分工；优先于单个 `converter`。 */
  converters?: readonly CameraConverter[] | null
  /** 转换缓存目录；默认放在系统临时目录。 */
  cacheDir?: string
  /** 可选的相机控制适配器；文件夹桥本身不需要它。 */
  control?: CameraControlProvider | null
  /**
   * 网页运行时切换可控相机。只有明确传入时才开放
   * `PUT /api/camera/provider`；自定义适配器启动的桥默认不开放。
   */
  configureControl?: (config: CameraControlConfig) => Promise<CameraControlProvider | null>
}

export type CameraConverter = ImageConverter

export type CameraCapabilities = {
  liveView: boolean
  shutter: boolean
  settings: boolean
  /** 相机是否支持把存储卡里最近的照片直接拉到桥目录。 */
  import?: boolean
}

export type CameraControlStatus = {
  connected: boolean
  model: string | null
  capabilities: CameraCapabilities
  /** 连接失败时给用户看的中文原因和下一步；不包含原始命令输出。 */
  diagnostic?: string
  /** 相机仍连着、但最近一次实时取景失败时的中文原因。 */
  previewDiagnostic?: string
  /** 可控参数的标准描述；网页按它动态渲染控件。 */
  settingsSchema?: CameraSettingDescriptor[]
}

export type CameraSettingDescriptor = {
  key: string
  label: string
  type: 'number' | 'select'
  /** 只读状态（电量 / 镜头等），网页只展示，不回写。 */
  readOnly?: boolean
  min?: number
  max?: number
  step?: number
  options?: { value: string; label: string }[]
}

export type CameraSettingValue = string | number
export type CameraSettings = Record<string, CameraSettingValue>

export type CameraControlProvider = {
  status: () => Promise<CameraControlStatus>
  liveView?: () => Promise<Uint8Array | null>
  capture?: () => Promise<{ saved?: string } | void>
  importRecent?: (limit: number) => Promise<{ imported: string[] }>
  getSettings?: () => Promise<CameraSettings>
  setSettings?: (patch: CameraSettings) => Promise<CameraSettings>
}

const CONVERT_EXTS = new Set([
  '.heic', '.heif', '.tif', '.tiff',
  ...RAW_EXTENSIONS,
])

const RAW_EXTS = new Set<string>(RAW_EXTENSIONS)

const JPEG_EXTS = new Set(['.jpg', '.jpeg'])

export const cameraConverterArgs = imageConverterArgs

/** 找本机可用的转换器；找不到就返回 null，不把相机桥本身拖垮。 */
export const detectCameraConverter = detectImageConverter
export const detectCameraConverters = detectImageConverters

/**
 * 开发 / 演示用的相机适配器：用一张本地图当实时取景，按快门时把它复制到
 * 相机目录。真实厂商 SDK 适配器实现同一个 `CameraControlProvider` 即可。
 */
export function createMockCameraProvider(
  source: string, root: string,
): CameraControlProvider {
  let settings: CameraSettings = {
    iso: 400, shutter: '1/125', aperture: 5.6, exposureCompensation: 0,
  }
  return {
    status: async () => ({
      connected: true,
      model: 'Mock Camera',
      capabilities: { liveView: true, shutter: true, settings: true },
      settingsSchema: [
        { key: 'iso', label: 'ISO', type: 'number', min: 100, max: 6400, step: 100 },
        {
          key: 'shutter', label: '快门', type: 'select',
          options: [
            { value: '1/60', label: '1/60' },
            { value: '1/125', label: '1/125' },
            { value: '1/250', label: '1/250' },
            { value: '1/500', label: '1/500' },
          ],
        },
        {
          key: 'aperture', label: '光圈', type: 'select',
          options: [
            { value: '2.8', label: 'f/2.8' },
            { value: '4', label: 'f/4' },
            { value: '5.6', label: 'f/5.6' },
            { value: '8', label: 'f/8' },
          ],
        },
        {
          key: 'exposureCompensation', label: '曝光补偿',
          type: 'number', min: -3, max: 3, step: 0.3,
        },
      ],
    }),
    liveView: () => readFile(source),
    capture: async () => {
      const name = `capture-${Date.now()}.jpg`
      await copyFile(source, join(root, name))
      return { saved: name }
    },
    getSettings: async () => ({ ...settings }),
    setSettings: async patch => {
      settings = { ...settings, ...patch }
      return { ...settings }
    },
  }
}

function contentType(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

function isPhoto(name: string): boolean {
  return PHOTO_EXTS.has(extname(name).toLowerCase())
}

function isSidecar(name: string): boolean {
  return extname(name).toLowerCase() === '.xmp'
}

function isConvertible(name: string): boolean {
  return CONVERT_EXTS.has(extname(name).toLowerCase())
}

function converterFormat(name: string): ImageFileFormat | null {
  return imageFileFormat(name)
}

function converterSupports(converter: CameraConverter, format: ImageFileFormat): boolean {
  return !converter.formats || converter.formats.includes(format)
}

function convertersFor(
  name: string, converters: readonly CameraConverter[],
): CameraConverter[] {
  const format = converterFormat(name)
  return format ? converters.filter(converter => converterSupports(converter, format)) : []
}

/** 校验 id 不逃出 root；返回真实路径，失败返回 null。 */
async function safePhotoPath(root: string, id: string): Promise<string | null> {
  const full = resolve(root, id)
  if (full !== root && !full.startsWith(root + sep)) return null
  const realRoot = await realpath(root).catch(() => root)
  const realFull = await realpath(full).catch(() => null)
  if (!realFull || (realFull !== realRoot && !realFull.startsWith(realRoot + sep))) return null
  return realFull
}

async function walk(
  root: string,
  rel: string,
  depth: number,
  out: CameraPhotoFile[],
  budget: { dirs: number; entries: number },
): Promise<void> {
  if (budget.dirs >= 256 || budget.entries >= 5_000) return
  budget.dirs++
  let entries: Dirent[]
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true })
  } catch (error) {
    // 根目录读不了要显式报错；某个相机软件生成的临时 / 权限目录读不了时，
    // 不该让整次「导入全部」失败。
    if (!rel) throw error
    return
  }
  for (const entry of entries) {
    if (budget.entries >= 5_000) return
    budget.entries++
    if (entry.name.startsWith('.')) continue
    const next = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      // 常见 tether 结构是「年份 / 月份 / 日期」或「场次 / 相机」；最多三层。
      // 总量另有 256 个目录 / 5000 个条目预算，避免误扫整个磁盘。
      if (depth < 3) await walk(root, next, depth + 1, out, budget)
      continue
    }
    if (!entry.isFile() || (!isPhoto(entry.name) && !isSidecar(entry.name))) continue
    const info = await stat(join(root, next)).catch(() => null)
    if (!info?.isFile()) continue
    out.push({
      id: next,
      name: entry.name,
      ...(rel ? { folder: rel } : {}),
      size: info.size,
      mtime: info.mtimeMs,
      type: contentType(entry.name),
    })
  }
}

/** 只读列目录；按修改时间从新到旧。 */
export async function listCameraPhotos(
  root: string, maxPhotos = 50,
): Promise<CameraPhotoFile[]> {
  const files: CameraPhotoFile[] = []
  await walk(resolve(root), '', 0, files, { dirs: 0, entries: 0 })

  /**
   * RAW+JPEG 配对（★ 2026-10-20）：很多相机同时写 `IMG_0001.CR3` 和
   * `IMG_0001.JPG`。对网页来说这是同一张照片的两份表示，直接把两条都列出来
   * 会让「导入全部」重复导两次。这里以 JPEG 为主条目，把 RAW 挂在 `raw` 上；
   * 只有 RAW 时保持原样，仍走转换器 / 原图那两条路。
   */
  const groups = new Map<string, {
    jpeg?: CameraPhotoFile
    raw?: CameraPhotoFile
    sidecar?: CameraPhotoFile
    others: CameraPhotoFile[]
  }>()
  for (const file of files) {
    const ext = extname(file.name).toLowerCase()
    const slash = file.id.lastIndexOf('/')
    const dir = file.id.slice(0, slash + 1)
    const stem = file.id.slice(dir.length).replace(/\.[^.]+$/, '').toLowerCase()
    const key = `${dir}${stem}`
    const group = groups.get(key) ?? { others: [] }
    if (RAW_EXTS.has(ext)) {
      if (!group.raw || file.mtime > group.raw.mtime) group.raw = file
    } else if (JPEG_EXTS.has(ext)) {
      if (!group.jpeg || file.mtime > group.jpeg.mtime) group.jpeg = file
    } else if (isSidecar(file.name)) {
      if (!group.sidecar || file.mtime > group.sidecar.mtime) group.sidecar = file
    } else {
      group.others.push(file)
    }
    groups.set(key, group)
  }

  const out: CameraPhotoFile[] = []
  for (const group of groups.values()) {
    const sidecar = group.sidecar
      ? {
          id: group.sidecar.id,
          name: group.sidecar.name,
          size: group.sidecar.size,
          mtime: group.sidecar.mtime,
          type: group.sidecar.type,
        }
      : null
    if (group.jpeg && group.raw) {
      out.push({
        ...group.jpeg,
        raw: {
          id: group.raw.id,
          name: group.raw.name,
          size: group.raw.size,
          mtime: group.raw.mtime,
          type: group.raw.type,
        },
        sidecar,
      })
    } else {
      if (group.jpeg) out.push({ ...group.jpeg, sidecar })
      if (group.raw) out.push({ ...group.raw, sidecar })
    }
    out.push(...group.others)
  }
  out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
  return out.slice(0, Math.max(1, Math.min(200, Math.floor(maxPhotos))))
}

/** 把一张 RAW / HEIC / TIFF 转成缓存里的 JPG；同一源文件只转一次。 */
export async function convertCameraPhotoToJpeg(
  converterOrConverters: CameraConverter | readonly CameraConverter[],
  input: string,
  cacheDir: string,
): Promise<string> {
  const converters = Array.isArray(converterOrConverters)
    ? converterOrConverters
    : [converterOrConverters]
  const applicable = convertersFor(input, converters)
  await mkdir(cacheDir, { recursive: true })
  const info = await stat(input)
  const key = createHash('sha1')
    .update(`${applicable.map(item => item.kind).join('+')}:${input}:${info.size}:${info.mtimeMs}`)
    .digest('hex')
  const cached = join(cacheDir, `${key}.jpg`)
  const cachedInfo = await stat(cached).catch(() => null)
  if (cachedInfo?.isFile() && cachedInfo.mtimeMs >= info.mtimeMs) return cached

  const tmp = join(cacheDir, `${key}.${process.pid}.${Date.now()}.tmp.jpg`)
  try {
    for (const converter of applicable) {
      await unlink(tmp).catch(() => {})
      try {
        await convertImageFile(converter, input, tmp, 120_000)
        const bytes = await readFile(tmp).catch(() => null)
        if (!bytes || !isJpegBytes(bytes)) continue
        await rename(tmp, cached)
        return cached
      } catch {
        // 继续试下一个支持此格式的转换器。
      }
    }
    throw new Error('没有转换器能输出有效 JPEG')
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

function setCors(
  req: IncomingMessage, res: ServerResponse, allowed: readonly string[],
  tokenRequired: boolean,
): void {
  const origin = req.headers.origin
  if (tokenRequired && origin) {
    // 跨设备时网页可能从 http://192.168.x.x:5173 打开。令牌是这里的认证边界，
    // 所以可以回显请求来源；没有令牌的请求在下面统一 401。
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  } else if (!tokenRequired && origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'content-type, x-pinkrose-camera, x-pinkrose-bridge-token',
  )
}

/** 固定长度摘要比较，避免令牌比较泄露长度或前几位。 */
function tokenMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
  })
  res.end(data)
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limit) throw new Error('请求体太大')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是对象')
  }
  return parsed as Record<string, unknown>
}

/**
 * 建一个本机 HTTP 服务。照片接口只读；可控相机额外开放快门 / 参数。
 * 调用方负责 `listen` / `close`；测试可以直接拿它绑随机端口。
 */
export function createCameraBridgeServer(options: CameraBridgeOptions) {
  const root = resolve(options.root)
  const allowed = options.allowedOrigins ?? [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ]
  const maxPhotos = options.maxPhotos ?? 50
  const converters = options.converters
    ?? (options.converter ? [options.converter] : [])
  const cacheDir = options.cacheDir ?? join(tmpdir(), 'pinkrose-camera-bridge')
  let control = options.control ?? null
  const configureControl = options.configureControl ?? null
  const token = options.token?.trim() || null

  const controlStatus = async (): Promise<CameraControlStatus & { canConfigure: boolean }> => {
    let status: CameraControlStatus
    try {
      status = control
        ? await control.status()
        : {
          connected: false,
          model: null,
          capabilities: { liveView: false, shutter: false, settings: false },
        }
    } catch (error) {
      console.error('相机状态读取失败', error)
      status = {
        connected: false,
        model: null,
        capabilities: { liveView: false, shutter: false, settings: false },
        diagnostic: '相机状态暂时读不到。确认相机还开着、连接没有断开，再点一次连接或稍后重试。',
      }
    }
    return { ...status, canConfigure: !!configureControl }
  }

  return createServer(async (req, res) => {
    setCors(req, res, allowed, !!token)
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      if (token) {
        const raw = req.headers['x-pinkrose-bridge-token']
        const header = Array.isArray(raw) ? raw[0] ?? '' : raw ?? ''
        const given = header || url.searchParams.get('token') || ''
        if (!given || !tokenMatches(given, token)) {
          json(res, 401, { ok: false, error: '相机桥访问令牌不对' })
          return
        }
      }
      if (url.pathname === '/api/camera/shutter') {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: '快门要用 POST' })
          return
        }
        if (!control?.capture) {
          json(res, 501, { ok: false, error: '这个桥没有接可控相机' })
          return
        }
        if (req.headers['x-pinkrose-camera'] !== '1') {
          json(res, 403, { ok: false, error: '缺少相机控制标记' })
          return
        }
        try {
          const result = await control.capture()
          json(res, 200, { ok: true, result: result ?? null })
        } catch (error) {
          console.error('相机快门失败', error)
          json(res, 422, {
            ok: false,
            error: '快门没按成。确认相机还连着、没有被其它软件占用，再试一次。',
          })
        }
        return
      }
      if (url.pathname === '/api/camera/import') {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: '从相机导入要用 POST' })
          return
        }
        if (!control?.importRecent) {
          json(res, 501, { ok: false, error: '这个相机适配器不能直接导入相机照片' })
          return
        }
        if (req.headers['x-pinkrose-camera'] !== '1') {
          json(res, 403, { ok: false, error: '缺少相机控制标记' })
          return
        }
        let body: Record<string, unknown> = {}
        try {
          body = await readJson(req)
        } catch {
          // An empty body means the default limit.
        }
        const requested = Number(body.limit)
        const limit = Number.isFinite(requested) ? Math.trunc(requested) : 20
        if (limit < 1 || limit > 100) {
          json(res, 400, { ok: false, error: '一次从相机导入 1~100 张。' })
          return
        }
        try {
          const result = await control.importRecent(limit)
          json(res, 200, { ok: true, result })
        } catch (error) {
          console.error('相机照片导入失败', error)
          json(res, 422, {
            ok: false,
            error: '相机照片没导进来。确认相机还连着，存储卡里也有照片，再试一次。',
          })
        }
        return
      }
      if (url.pathname === '/api/camera/provider') {
        if (req.method !== 'PUT') {
          json(res, 405, { ok: false, error: '相机配置要用 PUT' })
          return
        }
        if (!configureControl) {
          json(res, 501, { ok: false, error: '这个桥启动时已经固定了相机适配器，不能在网页里重配' })
          return
        }
        if (req.headers['x-pinkrose-camera'] !== '1') {
          json(res, 403, { ok: false, error: '缺少相机控制标记' })
          return
        }
        let body: Record<string, unknown>
        try {
          body = await readJson(req)
        } catch (error) {
          json(res, 400, { ok: false, error: error instanceof Error ? error.message : '配置格式不对' })
          return
        }
        let config: CameraControlConfig
        try {
          config = parseCameraControlConfig(body)
        } catch (error) {
          json(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : '相机配置不对',
          })
          return
        }
        try {
          control = await configureControl(config)
          await savePersistedCameraControl(root, config)
          json(res, 200, { ok: true, persisted: true, control: await controlStatus() })
        } catch (error) {
          json(res, 422, {
            ok: false,
            error: error instanceof Error ? error.message : '相机适配器没切过去',
          })
        }
        return
      }
      if (url.pathname === '/api/camera/settings') {
        if (req.method !== 'GET' && req.method !== 'PUT') {
          json(res, 405, { ok: false, error: '参数要用 GET / PUT' })
          return
        }
        if (!control?.getSettings || !control.setSettings) {
          json(res, 501, { ok: false, error: '这个桥没有相机参数控制' })
          return
        }
        if (req.method === 'GET') {
          try {
            json(res, 200, { settings: await control.getSettings() })
          } catch (error) {
            console.error('相机参数读取失败', error)
            json(res, 422, {
              ok: false,
              error: '相机参数暂时读不到。确认相机还连着，再试一次。',
            })
          }
          return
        }
        if (req.headers['x-pinkrose-camera'] !== '1') {
          json(res, 403, { ok: false, error: '缺少相机控制标记' })
          return
        }
        let body: Record<string, unknown>
        try {
          body = await readJson(req)
        } catch (error) {
          json(res, 400, { ok: false, error: error instanceof Error ? error.message : '参数格式不对' })
          return
        }
        const patch: CameraSettings = {}
        for (const [key, value] of Object.entries(body)) {
          if (typeof value === 'string' || typeof value === 'number') patch[key] = value
        }
        try {
          json(res, 200, { settings: await control.setSettings(patch) })
        } catch (error) {
          console.error('相机参数写入失败', error)
          json(res, 422, {
            ok: false,
            error: '参数没应用上。确认相机支持这些设置，再试一次。',
          })
        }
        return
      }
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: '只用 GET' })
        return
      }
      if (url.pathname === '/api/camera/health') {
        const photos = await listCameraPhotos(root, maxPhotos)
        json(res, 200, {
          ok: true,
          name: 'PinkRose Camera Bridge',
          root,
          count: photos.length,
          latest: photos[0] ?? null,
          converter: converters[0]?.kind ?? null,
          converters: converters.map(converter => converter.kind),
          control: await controlStatus(),
        })
        return
      }
      if (url.pathname === '/api/camera/control') {
        json(res, 200, await controlStatus())
        return
      }
      if (url.pathname === '/api/camera/liveview') {
        if (!control?.liveView) {
          json(res, 501, { ok: false, error: '这个桥没有实时取景' })
          return
        }
        let frame: Uint8Array | null
        try {
          frame = await control.liveView()
        } catch (error) {
          console.error('相机实时取景失败', error)
          json(res, 502, {
            ok: false,
            error: '实时取景暂时没画面。确认相机还连着、没有进入回放模式，再试一次。',
          })
          return
        }
        if (!frame) {
          res.writeHead(204, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': frame.length,
          'cache-control': 'no-store',
        })
        res.end(frame)
        return
      }
      if (url.pathname === '/api/camera/photos') {
        const photos = await listCameraPhotos(root, maxPhotos)
        json(res, 200, {
          photos: photos.map(photo => ({
            ...photo,
            url: `/api/camera/file?id=${encodeURIComponent(photo.id)}`,
            convertible: isConvertible(photo.name)
              && convertersFor(photo.name, converters).length > 0,
            convertUrl: isConvertible(photo.name)
              && convertersFor(photo.name, converters).length > 0
              ? `/api/camera/convert?id=${encodeURIComponent(photo.id)}`
              : null,
            raw: photo.raw
              ? {
                ...photo.raw,
                url: `/api/camera/file?id=${encodeURIComponent(photo.raw.id)}`,
                convertible: isConvertible(photo.raw.name)
                  && convertersFor(photo.raw.name, converters).length > 0,
                convertUrl: isConvertible(photo.raw.name)
                  && convertersFor(photo.raw.name, converters).length > 0
                  ? `/api/camera/convert?id=${encodeURIComponent(photo.raw.id)}`
                  : null,
              }
              : null,
            sidecar: photo.sidecar
              ? {
                ...photo.sidecar,
                url: `/api/camera/file?id=${encodeURIComponent(photo.sidecar.id)}`,
              }
              : null,
          })),
        })
        return
      }
      if (url.pathname === '/api/camera/file') {
        const id = url.searchParams.get('id') ?? ''
        if (!id) {
          json(res, 400, { ok: false, error: '缺少照片 id' })
          return
        }
        const full = await safePhotoPath(root, id)
        if (!full) {
          json(res, 403, { ok: false, error: '照片不在桥接目录里' })
          return
        }
        const info = await stat(full).catch(() => null)
        if (!info?.isFile()) {
          json(res, 404, { ok: false, error: '照片不在了' })
          return
        }
        res.writeHead(200, {
          'content-type': contentType(id),
          'content-length': info.size,
          'cache-control': 'no-store',
        })
        createReadStream(full).pipe(res)
        return
      }
      if (url.pathname === '/api/camera/convert') {
        const id = url.searchParams.get('id') ?? ''
        if (!id) {
          json(res, 400, { ok: false, error: '缺少照片 id' })
          return
        }
        const full = await safePhotoPath(root, id)
        if (!full || !isConvertible(id)) {
          json(res, 403, { ok: false, error: '这张照片不在可转换范围里' })
          return
        }
        const applicable = convertersFor(id, converters)
        if (applicable.length === 0) {
          json(res, 501, { ok: false, error: '这台机器没有能处理这个格式的转换器' })
          return
        }
        let jpeg: string
        try {
          jpeg = await convertCameraPhotoToJpeg(applicable, full, cacheDir)
        } catch (error) {
          console.error('相机照片转换失败', id, error)
          json(res, 422, {
            ok: false,
            error: '这张照片没转成 JPG。检查本机转换器是否支持这个相机格式。',
          })
          return
        }
        const info = await stat(jpeg)
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': info.size,
          'cache-control': 'no-store',
        })
        createReadStream(jpeg).pipe(res)
        return
      }
      json(res, 404, { ok: false, error: '没有这个接口' })
    } catch (error) {
      console.error('相机桥请求失败', error)
      if (!res.headersSent) json(res, 500, { ok: false, error: '相机桥读目录失败' })
      else res.destroy()
    }
  })
}
