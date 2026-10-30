/**
 * 轻量 TIFF / DNG / CR2 / NEF / ARW 基础 EXIF 读取。
 *
 * 不解 RAW 像素，只读 IFD0 + Exif IFD 的公开字段，供照片信息与自动镜头
 * 配置文件复用。调用方只需传入文件头（建议 1–2MB），不会为了看机型把
 * 几十 MB 的 RAW 整份展开。
 */

export type TiffMetadata = {
  make: string | null
  model: string | null
  artist: string | null
  copyright: string | null
  lens: string | null
  focalMm: number | null
  focal35mm: number | null
  takenAt: string | null
  exposureSeconds: number | null
  fNumber: number | null
  iso: number | null
  whiteBalance: number | null
  gps: { latitude: number; longitude: number } | null
  hasExif: boolean
}

type Entry = {
  type: number
  count: number
  valueOffset: number
  inline: boolean
}

const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8,
}

function findTiffStart(bytes: Uint8Array): number {
  if (bytes.length >= 4
    && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0)
      || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42))) {
    return 0
  }
  const limit = Math.min(bytes.length - 4, 4096)
  for (let i = 0; i <= limit; i++) {
    if (bytes[i] === 0x49 && bytes[i + 1] === 0x49 && bytes[i + 2] === 42 && bytes[i + 3] === 0) {
      return i
    }
    if (bytes[i] === 0x4d && bytes[i + 1] === 0x4d && bytes[i + 2] === 0 && bytes[i + 3] === 42) {
      return i
    }
  }
  return -1
}

function readIfd(
  view: DataView, bytesLength: number, offset: number, little: boolean,
): Map<number, Entry> {
  const out = new Map<number, Entry>()
  if (offset + 2 > bytesLength) return out
  const count = view.getUint16(offset, little)
  if (count > 2048 || offset + 2 + count * 12 > bytesLength) return out
  for (let i = 0; i < count; i++) {
    const at = offset + 2 + i * 12
    if (at + 12 > bytesLength) break
    const tag = view.getUint16(at, little)
    const type = view.getUint16(at + 2, little)
    const countValue = view.getUint32(at + 4, little)
    const size = (TYPE_SIZE[type] ?? 1) * countValue
    const valueOffset = size <= 4 ? at + 8 : view.getUint32(at + 8, little)
    out.set(tag, { type, count: countValue, valueOffset, inline: size <= 4 })
  }
  return out
}

function asciiValue(bytes: Uint8Array, entry: Entry | undefined): string | null {
  if (!entry || entry.type !== 2 || entry.valueOffset < 0
    || entry.valueOffset + entry.count > bytes.length) return null
  let out = ''
  for (let i = 0; i < entry.count; i++) {
    const value = bytes[entry.valueOffset + i]!
    if (value === 0) break
    out += String.fromCharCode(value)
  }
  return out.trim() || null
}

function numberValues(
  view: DataView, bytes: Uint8Array, entry: Entry, little: boolean,
): number[] {
  const sizes = TYPE_SIZE[entry.type]
  if (!sizes || entry.valueOffset + entry.count * sizes > bytes.length) return []
  const out: number[] = []
  for (let i = 0; i < entry.count; i++) {
    const at = entry.valueOffset + i * sizes
    if (entry.type === 3) out.push(view.getUint16(at, little))
    else if (entry.type === 4) out.push(view.getUint32(at, little))
    else if (entry.type === 9) out.push(view.getInt32(at, little))
    else if (entry.type === 5) {
      const n = view.getUint32(at, little)
      const d = view.getUint32(at + 4, little)
      out.push(d ? n / d : 0)
    } else if (entry.type === 10) {
      const n = view.getInt32(at, little)
      const d = view.getInt32(at + 4, little)
      out.push(d ? n / d : 0)
    } else if (entry.type === 1 || entry.type === 7) out.push(bytes[at]!)
  }
  return out
}

function firstNumber(
  view: DataView, bytes: Uint8Array, entry: Entry | undefined, little: boolean,
): number | null {
  if (!entry) return null
  const values = numberValues(view, bytes, entry, little)
  return values.length > 0 && Number.isFinite(values[0]) ? values[0]! : null
}

function gpsCoordinate(
  view: DataView,
  bytes: Uint8Array,
  valueEntry: Entry | undefined,
  refEntry: Entry | undefined,
  little: boolean,
): number | null {
  if (!valueEntry) return null
  const values = numberValues(view, bytes, valueEntry, little)
  if (values.length < 3 || values.some(value => !Number.isFinite(value))) return null
  const degrees = values[0]! + values[1]! / 60 + values[2]! / 3600
  const ref = asciiValue(bytes, refEntry)?.toUpperCase()
  return ref === 'S' || ref === 'W' ? -degrees : degrees
}

/** 读取 TIFF-based RAW / TIFF 的基础 EXIF；损坏或截断时安全返回 null。 */
export function parseTiffMetadata(bytes: Uint8Array): TiffMetadata | null {
  const start = findTiffStart(bytes)
  if (start < 0 || start + 8 > bytes.length) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, bytes.length - start)
  const little = bytes[start] === 0x49
  const ifd0 = view.getUint32(4, little)
  if (ifd0 < 8 || ifd0 + 2 > view.byteLength) return null
  const first = readIfd(view, view.byteLength, ifd0, little)
  if (first.size === 0) return null

  const exifPointer = firstNumber(view, bytes.subarray(start), first.get(34665), little)
  const exif = typeof exifPointer === 'number' && exifPointer > 0
    ? readIfd(view, view.byteLength, exifPointer, little)
    : new Map<number, Entry>()
  const gpsPointer = firstNumber(view, bytes.subarray(start), first.get(34853), little)
  const gps = typeof gpsPointer === 'number' && gpsPointer > 0
    ? readIfd(view, view.byteLength, gpsPointer, little)
    : new Map<number, Entry>()
  const all = (tag: number) => exif.get(tag) ?? first.get(tag)
  const tiffBytes = bytes.subarray(start)
  const make = asciiValue(tiffBytes, all(271))
  const model = asciiValue(tiffBytes, all(272))
  let lens = asciiValue(tiffBytes, all(42036))
  if (!lens) {
    const spec = all(42034)
    const values = spec ? numberValues(view, tiffBytes, spec, little) : []
    if (values.length >= 4) {
      const [min, max, minAperture] = values
      const range = Math.abs((max ?? min) - (min ?? 0)) < 0.05
        ? `${Math.round(min ?? 0)}mm`
        : `${Math.round(min ?? 0)}-${Math.round(max ?? 0)}mm`
      lens = minAperture ? `${range} f/${minAperture.toFixed(1)}` : range
    }
  }
  const latitude = gpsCoordinate(view, tiffBytes, gps.get(2), gps.get(1), little)
  const longitude = gpsCoordinate(view, tiffBytes, gps.get(4), gps.get(3), little)
  return {
    make,
    model,
    artist: asciiValue(tiffBytes, all(315)),
    copyright: asciiValue(tiffBytes, all(33432)),
    lens,
    focalMm: firstNumber(view, tiffBytes, all(37386), little),
    focal35mm: firstNumber(view, tiffBytes, all(41989), little),
    takenAt: asciiValue(tiffBytes, all(36867)),
    exposureSeconds: firstNumber(view, tiffBytes, all(33434), little),
    fNumber: firstNumber(view, tiffBytes, all(33437), little),
    iso: firstNumber(view, tiffBytes, all(34855), little),
    whiteBalance: firstNumber(view, tiffBytes, all(41987), little),
    gps: latitude !== null && longitude !== null
      && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
      ? { latitude, longitude }
      : null,
    hasExif: true,
  }
}
