import piexif from 'piexifjs'
import { blobToDataUrl } from '../image/blob.ts'
import { detectSourceColorProfile, sourceColorProfileLabel } from '../image/sourceProfile.ts'
import { parseTiffMetadata, type TiffMetadata } from '../image/tiffMetadata.ts'
import { isRawFileName } from '../../shared/imageFormats.ts'

/**
 * 照片信息：文件基础信息 + JPG / PNG / WebP / TIFF EXIF。纯解析一层，
 * UI 只负责展开 / 收起；
 * 不改像素、不上传文件。按需读取，避免每次上传都对大图做一次 base64。
 */
export type PhotoInfo = {
  fileName: string
  fileType: string
  fileSize: string
  width: number
  height: number
  camera: string | null
  lens: string | null
  takenAt: string | null
  shutter: string | null
  aperture: string | null
  iso: string | null
  focalLength: string | null
  whiteBalance: string | null
  creator: string | null
  copyright: string | null
  gps: string | null
  colorProfile: string | null
  hasGps: boolean
  hasExif: boolean
}

/** 镜头匹配要用的原始字段（不格式化，避免把数字再解析回来）。 */
export type LensInfo = {
  make: string | null
  model: string | null
  lens: string | null
  focalMm: number | null
  focal35mm: number | null
  hasExif: boolean
  /** 已格式化为 `YYYY-MM-DD HH:MM`；用于批量按拍摄日期命名。 */
  takenAt?: string | null
  /** EXIF 拍摄时间的毫秒值；保留秒级精度，供连拍识别使用。 */
  takenAtMs?: number | null
}

type ExifDict = ReturnType<typeof piexif.load>

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (!Array.isArray(value) || value.length === 0) return null
  if (value.length === 1) return numberValue(value[0])
  const numerator = numberValue(value[0])
  const denominator = numberValue(value[1])
  if (numerator === null || denominator === null || denominator === 0) return null
  return numerator / denominator
}

function textValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\0+$/g, '').trim()
  return text || null
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatShutter(value: unknown): string | null {
  const seconds = numberValue(value)
  if (seconds === null || seconds <= 0) return null
  if (seconds >= 1) return `${seconds.toFixed(seconds < 10 ? 1 : 0).replace(/\.0$/, '')} 秒`
  return `1/${Math.max(1, Math.round(1 / seconds))} 秒`
}

function formatAperture(value: unknown): string | null {
  const f = numberValue(value)
  return f === null || f <= 0 ? null : `f/${f.toFixed(f < 10 ? 1 : 0).replace(/\.0$/, '')}`
}

function formatFocal(value: unknown): string | null {
  const mm = numberValue(value)
  return mm === null || mm <= 0 ? null : `${mm.toFixed(mm < 10 ? 1 : 0).replace(/\.0$/, '')} mm`
}

function formatLens(value: unknown): string | null {
  const direct = textValue(value)
  if (direct) return direct
  if (!Array.isArray(value) || value.length < 4) return null
  const min = numberValue(value[0])
  const max = numberValue(value[1])
  const minAperture = numberValue(value[2])
  if (min === null || max === null) return null
  const range = Math.abs(max - min) < 0.05 ? `${min.toFixed(0)}mm` : `${min.toFixed(0)}-${max.toFixed(0)}mm`
  return minAperture ? `${range} f/${minAperture.toFixed(1)}` : range
}

function formatDate(value: unknown): string | null {
  const raw = textValue(value)
  if (!raw) return null
  const match = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}` : raw
}

function captureDateMs(value: unknown): number | null {
  const raw = textValue(value)
  if (!raw) return null
  const match = raw.match(
    /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  )
  if (!match) return null
  const [year, month, day, hour, minute, second] = [
    Number(match[1]), Number(match[2]), Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6] ?? 0),
  ]
  const date = new Date(year, month - 1, day, hour, minute, second)
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    && date.getHours() === hour
    && date.getMinutes() === minute
    && date.getSeconds() === second
    ? date.getTime()
    : null
}

function gpsDegrees(value: unknown, ref: unknown): number | null {
  if (!Array.isArray(value) || value.length < 3) return null
  const parts = value.slice(0, 3).map(numberValue)
  if (parts.some(part => part === null)) return null
  const [degrees, minutes, seconds] = parts as [number, number, number]
  const coordinate = degrees + minutes / 60 + seconds / 3600
  const direction = textValue(ref)?.toUpperCase()
  return direction === 'S' || direction === 'W' ? -coordinate : coordinate
}

function formatGps(latitude: number | null, longitude: number | null): string | null {
  if (latitude === null || longitude === null
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  const latRef = latitude < 0 ? 'S' : 'N'
  const lonRef = longitude < 0 ? 'W' : 'E'
  return `${Math.abs(latitude).toFixed(6)}° ${latRef}, ${Math.abs(longitude).toFixed(6)}° ${lonRef}`
}

export function exifToPhotoInfo(
  file: Pick<File, 'name' | 'type' | 'size'>,
  width: number,
  height: number,
  exif: ExifDict | null,
  colorProfile: string | null = null,
): PhotoInfo {
  const zeroth = exif?.['0th'] ?? {}
  const details = exif?.Exif ?? {}
  const make = textValue(zeroth[piexif.ImageIFD.Make])
  const model = textValue(zeroth[piexif.ImageIFD.Model])
  const camera = model
    ? (make && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : model)
    : make
  const isoRaw = details[piexif.ExifIFD.ISOSpeedRatings]
    ?? details[piexif.ExifIFD.ISOSpeed]
    ?? details[piexif.ExifIFD.StandardOutputSensitivity]
  const iso = numberValue(Array.isArray(isoRaw) ? isoRaw[0] : isoRaw)
  const focal = formatFocal(details[piexif.ExifIFD.FocalLength])
  const focal35 = formatFocal(details[piexif.ExifIFD.FocalLengthIn35mmFilm])
  const whiteBalanceRaw = numberValue(details[piexif.ExifIFD.WhiteBalance])
  const latitude = gpsDegrees(
    exif?.GPS?.[piexif.GPSIFD.GPSLatitude],
    exif?.GPS?.[piexif.GPSIFD.GPSLatitudeRef],
  )
  const longitude = gpsDegrees(
    exif?.GPS?.[piexif.GPSIFD.GPSLongitude],
    exif?.GPS?.[piexif.GPSIFD.GPSLongitudeRef],
  )
  return {
    fileName: file.name,
    fileType: file.type || file.name.split('.').pop()?.toUpperCase() || '未知',
    fileSize: formatFileSize(file.size),
    width,
    height,
    camera,
    lens: formatLens(details[piexif.ExifIFD.LensModel])
      ?? formatLens(details[piexif.ExifIFD.LensSpecification]),
    takenAt: formatDate(details[piexif.ExifIFD.DateTimeOriginal])
      ?? formatDate(zeroth[piexif.ImageIFD.DateTime]),
    shutter: formatShutter(details[piexif.ExifIFD.ExposureTime]),
    aperture: formatAperture(details[piexif.ExifIFD.FNumber]),
    iso: iso === null ? null : `ISO ${Math.round(iso)}`,
    focalLength: focal && focal35 ? `${focal}（等效 ${focal35}）` : focal,
    whiteBalance: whiteBalanceRaw === 0 ? '自动' : whiteBalanceRaw === 1 ? '手动' : null,
    creator: textValue(zeroth[piexif.ImageIFD.Artist]),
    copyright: textValue(zeroth[piexif.ImageIFD.Copyright]),
    gps: formatGps(latitude, longitude),
    colorProfile,
    hasGps: !!exif?.GPS && Object.keys(exif.GPS).length > 0,
    hasExif: !!exif && (
      Object.keys(zeroth).length > 0 || Object.keys(details).length > 0
    ),
  }
}

export function exifToLensInfo(exif: ExifDict | null): LensInfo {
  const zeroth = exif?.['0th'] ?? {}
  const details = exif?.Exif ?? {}
  const takenAt = formatDate(details[piexif.ExifIFD.DateTimeOriginal])
    ?? formatDate(zeroth[piexif.ImageIFD.DateTime])
  const takenAtMs = captureDateMs(details[piexif.ExifIFD.DateTimeOriginal])
    ?? captureDateMs(zeroth[piexif.ImageIFD.DateTime])
  return {
    make: textValue(zeroth[piexif.ImageIFD.Make]),
    model: textValue(zeroth[piexif.ImageIFD.Model]),
    lens: textValue(details[piexif.ExifIFD.LensModel])
      ?? textValue(formatLens(details[piexif.ExifIFD.LensSpecification])),
    focalMm: numberValue(details[piexif.ExifIFD.FocalLength]),
    focal35mm: numberValue(details[piexif.ExifIFD.FocalLengthIn35mmFilm]),
    hasExif: !!exif && (
      Object.keys(zeroth).length > 0 || Object.keys(details).length > 0
    ),
    ...(takenAt ? { takenAt, takenAtMs } : {}),
  }
}

const lensInfoCache = new Map<string, Promise<LensInfo>>()

function looksTiffBased(file: Pick<File, 'name'>): boolean {
  return /\.tiff?$/i.test(file.name) || isRawFileName(file.name)
}

function looksPng(file: Pick<File, 'name' | 'type'>): boolean {
  return /^image\/png$/i.test(file.type) || /\.png$/i.test(file.name)
}

function looksWebp(file: Pick<File, 'name' | 'type'>): boolean {
  return /^image\/webp$/i.test(file.type) || /\.webp$/i.test(file.name)
}

function looksHeic(file: Pick<File, 'name' | 'type'>): boolean {
  return /^image\/hei[cf](?:-sequence)?$/i.test(file.type) || /\.(?:heic|heif)$/i.test(file.name)
}

async function readPrefixBytes(file: File, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const slice = file.slice(0, maxBytes)
  if (typeof slice.arrayBuffer === 'function') {
    return new Uint8Array(await slice.arrayBuffer())
  }
  const data = await blobToDataUrl(slice)
  const binary = atob(data.slice(data.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function readTiffMetadata(file: File): Promise<TiffMetadata | null> {
  try {
    return parseTiffMetadata(await readPrefixBytes(file, 2 * 1024 * 1024))
  } catch {
    return null
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

/** PNG eXIf chunk 的内容就是一段 TIFF EXIF；CRC 不参与解析。 */
function pngExifBytes(bytes: Uint8Array): Uint8Array | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!signature.every((value, index) => bytes[index] === value)) return null
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 12)
    const length = view.getUint32(0)
    const end = offset + 12 + length
    if (length > bytes.length || end > bytes.length) return null
    if (ascii(bytes, offset + 4, 4) === 'eXIf') {
      return bytes.subarray(offset + 8, offset + 8 + length)
    }
    offset = end
  }
  return null
}

/** WebP EXIF chunk 可能带 `Exif\0\0` 前缀；后续 TIFF 解析器会自行定位。 */
function webpExifBytes(bytes: Uint8Array): Uint8Array | null {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8)
    const length = view.getUint32(4, true)
    const start = offset + 8
    const end = start + length
    if (length > bytes.length || end > bytes.length) return null
    if (ascii(bytes, offset, 4) === 'EXIF') return bytes.subarray(start, end)
    offset = end + (length & 1)
  }
  return null
}

/**
 * HEIF 的 Exif item 在 `meta/iloc` 里，完整定位需要解析多个 box。这里只在
 * 文件头部寻找带有效 IFD 的 TIFF EXIF 载荷：找到后交给现有轻量 TIFF 解析器，
 * 解析不出有效字段就继续换下一个候选，不把随机 `II*` 字节当 EXIF。
 */
function heicExifBytes(bytes: Uint8Array): Uint8Array | null {
  if (ascii(bytes, 4, 4) !== 'ftyp') return null
  for (let at = 0; at + 8 < bytes.length; at++) {
    const little = bytes[at] === 0x49 && bytes[at + 1] === 0x49
      && bytes[at + 2] === 0x2a && bytes[at + 3] === 0x00
    const big = bytes[at] === 0x4d && bytes[at + 1] === 0x4d
      && bytes[at + 2] === 0x00 && bytes[at + 3] === 0x2a
    if (!little && !big) continue
    const candidate = bytes.subarray(at)
    try {
      if (parseTiffMetadata(candidate)?.hasExif) return candidate
    } catch {
      // 继续找下一个 TIFF 头。
    }
  }
  return null
}

async function readContainerMetadata(file: File): Promise<TiffMetadata | null> {
  try {
    const bytes = await readPrefixBytes(file, 4 * 1024 * 1024)
    const exif = looksPng(file)
      ? pngExifBytes(bytes)
      : looksWebp(file) ? webpExifBytes(bytes) : heicExifBytes(bytes)
    return exif ? parseTiffMetadata(exif) : null
  } catch {
    return null
  }
}

function tiffLensInfo(meta: TiffMetadata): LensInfo {
  const takenAt = formatDate(meta.takenAt)
  const takenAtMs = captureDateMs(meta.takenAt)
  return {
    make: meta.make,
    model: meta.model,
    lens: meta.lens,
    focalMm: meta.focalMm,
    focal35mm: meta.focal35mm,
    hasExif: meta.hasExif,
    ...(takenAt ? { takenAt, takenAtMs } : {}),
  }
}

function tiffToPhotoInfo(
  file: Pick<File, 'name' | 'type' | 'size'>,
  width: number,
  height: number,
  meta: TiffMetadata,
  colorProfile: string | null,
): PhotoInfo {
  const camera = meta.model
    ? (meta.make && !meta.model.toLowerCase().startsWith(meta.make.toLowerCase())
      ? `${meta.make} ${meta.model}` : meta.model)
    : meta.make
  const focal = formatFocal(meta.focalMm)
  const focal35 = formatFocal(meta.focal35mm)
  const shutter = meta.exposureSeconds === null || meta.exposureSeconds <= 0
    ? null
    : meta.exposureSeconds >= 1
      ? `${meta.exposureSeconds.toFixed(meta.exposureSeconds < 10 ? 1 : 0).replace(/\.0$/, '')} 秒`
      : `1/${Math.max(1, Math.round(1 / meta.exposureSeconds))} 秒`
  return {
    fileName: file.name,
    fileType: file.type || file.name.split('.').pop()?.toUpperCase() || '未知',
    fileSize: formatFileSize(file.size),
    width,
    height,
    camera,
    lens: meta.lens,
    takenAt: formatDate(meta.takenAt),
    shutter,
    aperture: meta.fNumber === null ? null
      : `f/${meta.fNumber.toFixed(meta.fNumber < 10 ? 1 : 0).replace(/\.0$/, '')}`,
    iso: meta.iso === null ? null : `ISO ${Math.round(meta.iso)}`,
    focalLength: focal && focal35 ? `${focal}（等效 ${focal35}）` : (focal ?? (focal35 ? `等效 ${focal35}` : null)),
    whiteBalance: meta.whiteBalance === 0 ? '自动' : meta.whiteBalance === 1 ? '手动' : null,
    creator: meta.artist,
    copyright: meta.copyright,
    gps: formatGps(meta.gps?.latitude ?? null, meta.gps?.longitude ?? null),
    colorProfile,
    hasGps: meta.gps !== null,
    hasExif: meta.hasExif,
  }
}

/**
 * 按需读取镜头字段：JPG 走 piexif，PNG / WebP 读 eXIf / EXIF chunk，
 * TIFF / DNG / 常见 TIFF-based RAW 走轻量 TIFF IFD 解析；
 * 其它格式返回空字段，由 UI 走手动选择。
 * 同一份文件反复展开面板时不重复 base64 + 解析。
 */
export function readLensInfo(file: File): Promise<LensInfo> {
  const looksJpeg = /^image\/jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name)
  const containerExif = looksPng(file) || looksWebp(file) || looksHeic(file)
  if (!looksJpeg && !looksTiffBased(file) && !containerExif) {
    return Promise.resolve({
      make: null, model: null, lens: null, focalMm: null, focal35mm: null, hasExif: false,
    })
  }
  const key = `${file.name}:${file.size}:${file.lastModified}`
  const cached = lensInfoCache.get(key)
  if (cached) return cached
  // EXIF APP1 按规范最多 64KB，通常就在文件头；只读前 512KB，
  // 不为一张 20MB 的 JPEG 造一整份 base64（内存和等待都不值）。
  // 第三参把切片标成 JPEG：有些浏览器给的 File.type 是空的，切片会变成
  // application/octet-stream，piexif 会直接判"不是 JPEG/TIFF"。
  const pending = (looksJpeg
    ? blobToDataUrl(file.slice(0, 512 * 1024, 'image/jpeg'))
      .then(data => exifToLensInfo(piexif.load(data)))
    : (looksTiffBased(file) ? readTiffMetadata(file) : readContainerMetadata(file))
      .then(meta => meta ? tiffLensInfo(meta) : {
      make: null, model: null, lens: null, focalMm: null, focal35mm: null, hasExif: false,
    }))
    // 读不出来（不是真 JPEG、EXIF 损坏等）不能让面板消失，也不值得刷控制台：
    // 照片信息面板同一套解析也是静默退回。手动选择永远可用。
    .catch(() => ({
      make: null, model: null, lens: null, focalMm: null, focal35mm: null, hasExif: false,
    }))
  lensInfoCache.set(key, pending)
  return pending
}

export async function readPhotoInfo(
  file: File, width: number, height: number,
): Promise<PhotoInfo> {
  const profile = sourceColorProfileLabel(await detectSourceColorProfile(file))
  const base = exifToPhotoInfo(file, width, height, null, profile)
  const looksJpeg = /^image\/jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name)
  if (!looksJpeg && looksTiffBased(file)) {
    const meta = await readTiffMetadata(file)
    return meta ? tiffToPhotoInfo(file, width, height, meta, profile) : base
  }
  if (!looksJpeg && (looksPng(file) || looksWebp(file) || looksHeic(file))) {
    const meta = await readContainerMetadata(file)
    return meta ? tiffToPhotoInfo(file, width, height, meta, profile) : base
  }
  if (!looksJpeg) return base
  try {
    const exif = piexif.load(await blobToDataUrl(file))
    return exifToPhotoInfo(file, width, height, exif, profile)
  } catch {
    return base
  }
}
