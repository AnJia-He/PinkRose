import { blobToDataUrl } from './blob'

/** 源文件的声明色彩空间；null / unknown 表示文件没有可读标签。 */
export type SourceColorProfile =
  'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto-rgb' | 'bt2020' | 'other'

const MAX_PROFILE_SCAN = 8 * 1024 * 1024

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length && offset + i < bytes.length; i++) {
    out += String.fromCharCode(bytes[offset + i]!)
  }
  return out
}

function lowerText(bytes: Uint8Array): string {
  let ascii = ''
  let utf16 = ''
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i]!
    ascii += value >= 32 && value < 127 ? String.fromCharCode(value) : ' '
    if (i + 1 < bytes.length && value === 0 && bytes[i + 1]! >= 32 && bytes[i + 1]! < 127) {
      utf16 += String.fromCharCode(bytes[i + 1]!)
      i++
    }
  }
  return `${ascii} ${utf16}`.toLowerCase()
}

function profileFromMatrix(bytes: Uint8Array): SourceColorProfile | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 132 || asciiAt(bytes, 36, 4) !== 'acsp') return null
  const count = view.getUint32(128)
  if (count > 200 || 132 + count * 12 > bytes.length) return null
  let redX: number | null = null
  for (let i = 0; i < count; i++) {
    const at = 132 + i * 12
    if (asciiAt(bytes, at, 4) !== 'rXYZ') continue
    const offset = view.getUint32(at + 4)
    if (offset + 12 > bytes.length) continue
    redX = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 4).getInt32(0) / 65536
  }
  if (redX === null) return null
  if (Math.abs(redX - 0.436) < 0.03) return 'srgb'
  if (Math.abs(redX - 0.515) < 0.03) return 'display-p3'
  if (Math.abs(redX - 0.610) < 0.04) return 'adobe-rgb'
  if (Math.abs(redX - 0.798) < 0.04) return 'prophoto-rgb'
  return null
}

/** 只认常见的名字和 rXYZ 主色矩阵；未知 ICC 不冒充 sRGB。 */
export function classifyIccProfile(bytes: Uint8Array): SourceColorProfile {
  const text = lowerText(bytes)
  if (text.includes('display p3') || text.includes('p3-d65')) return 'display-p3'
  if (text.includes('adobe rgb')) return 'adobe-rgb'
  if (text.includes('prophoto')) return 'prophoto-rgb'
  if (text.includes('bt.2020') || text.includes('rec.2020')) return 'bt2020'
  if (text.includes('srgb')) return 'srgb'
  return profileFromMatrix(bytes) ?? 'other'
}

export function sourceColorProfileLabel(profile: SourceColorProfile | null): string | null {
  switch (profile) {
    case 'srgb': return 'sRGB'
    case 'display-p3': return 'Display P3'
    case 'adobe-rgb': return 'Adobe RGB'
    case 'prophoto-rgb': return 'ProPhoto RGB'
    case 'bt2020': return 'BT.2020'
    case 'other': return '其它 ICC 广色域'
    default: return null
  }
}

async function readPrefix(file: File): Promise<Uint8Array<ArrayBuffer>> {
  const slice = file.slice(0, MAX_PROFILE_SCAN)
  if (typeof slice.arrayBuffer === 'function') {
    return new Uint8Array(await slice.arrayBuffer())
  }
  const data = await blobToDataUrl(slice)
  const binary = atob(data.slice(data.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function jpegIcc(bytes: Uint8Array): Uint8Array | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const chunks: Uint8Array[] = []
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break
    const marker = bytes[offset + 1]!
    if (marker === 0xda || marker === 0xd9) break
    const length = bytes[offset + 2]! * 256 + bytes[offset + 3]!
    const end = offset + 2 + length
    if (length < 2 || end > bytes.length) break
    if (marker === 0xe2 && asciiAt(bytes, offset + 4, 12) === 'ICC_PROFILE\0') {
      chunks.push(bytes.slice(offset + 18, end))
    }
    offset = end
  }
  if (chunks.length === 0) return null
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

async function pngIcc(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (!(bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)) return null
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
    const type = asciiAt(bytes, offset + 4, 4)
    const dataAt = offset + 8
    const end = dataAt + length
    if (end + 4 > bytes.length) return null
    if (type === 'iCCP') {
      const data = bytes.slice(dataAt, end)
      const nul = data.indexOf(0)
      if (nul < 0) return null
      if (typeof DecompressionStream !== 'undefined') {
        const stream = new Blob([data.slice(nul + 2)]).stream()
          .pipeThrough(new DecompressionStream('deflate'))
        return new Uint8Array(await new Response(stream).arrayBuffer())
      }
      return null
    }
    if (type === 'sRGB') return new Uint8Array([...new TextEncoder().encode('sRGB')])
    offset = end + 4
  }
  return null
}

function webpIcc(bytes: Uint8Array): Uint8Array | null {
  if (asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WEBP') return null
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getUint32(4, true)
    const type = asciiAt(bytes, offset, 4)
    const dataAt = offset + 8
    const end = dataAt + length
    if (end > bytes.length) return null
    if (type === 'ICCP') return bytes.slice(dataAt, end)
    offset = end + (length & 1)
  }
  return null
}

function tiffIcc(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 8) return null
  const little = bytes[0] === 0x49 && bytes[1] === 0x49
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d
  if (!little && !big) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (at: number) => view.getUint16(at, little)
  const u32 = (at: number) => view.getUint32(at, little)
  if (u16(2) !== 42) return null
  const ifd = u32(4)
  if (ifd + 2 > bytes.length) return null
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12
    if (at + 12 > bytes.length) return null
    if (u16(at) !== 34675) continue
    const length = u32(at + 4)
    const offset = length <= 4 ? at + 8 : u32(at + 8)
    if (offset + length > bytes.length) return null
    return bytes.slice(offset, offset + length)
  }
  return null
}

function heifNclx(bytes: Uint8Array): SourceColorProfile | null {
  const text = asciiAt(bytes, 0, Math.min(bytes.length, 64))
  if (!text.includes('ftyp') && !text.includes('heic') && !text.includes('heif')) return null
  for (let i = 0; i + 10 < bytes.length; i++) {
    if (asciiAt(bytes, i, 4) !== 'nclx') continue
    const primaries = bytes[i + 4]! * 256 + bytes[i + 5]!
    if (primaries === 1) return 'srgb'
    if (primaries === 11 || primaries === 12) return 'display-p3'
    if (primaries === 9) return 'bt2020'
  }
  return null
}

/**
 * 读取文件头部，不依赖浏览器是否真的能解码这张照片。
 * JPEG APP2 / PNG iCCP / HEIF nclx 覆盖了苹果照片和常见相机交付；
 * 读不出来时返回 null，由 UI 说“未标注”，不硬猜成 sRGB。
 */
export async function detectSourceColorProfile(file: File): Promise<SourceColorProfile | null> {
  try {
    const bytes = await readPrefix(file)
    if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      return heifNclx(bytes)
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const icc = jpegIcc(bytes)
      return icc ? classifyIccProfile(icc) : null
    }
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
      const icc = await pngIcc(bytes)
      return icc ? classifyIccProfile(icc) : null
    }
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
      const icc = webpIcc(bytes)
      return icc ? classifyIccProfile(icc) : null
    }
    if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) {
      const icc = tiffIcc(bytes)
      return icc ? classifyIccProfile(icc) : null
    }
    return null
  } catch {
    return null
  }
}
