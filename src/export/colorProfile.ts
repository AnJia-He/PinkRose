/**
 * 明确的 sRGB ICC 输出标记。
 *
 * 编辑链目前统一在 sRGB 像素空间工作；浏览器 `canvas.toBlob()` 生成的
 * JPG / PNG / WebP 却不一定带 profile。看图和打印软件只能猜，同一张图在
 * Apple「预览」、Photoshop、印刷 RIP 里就可能不一致。这里生成一个很小的
 * ICC v4 显示配置并把同一份字节写进 JPG / PNG / WebP / TIFF。
 *
 * ⚠️ 这不是“已支持 P3 编辑”。WebKit 的 WebGL2 当前没有
 * `drawingBufferColorSpace` / `unpackColorSpace`，主编辑链无法在保留 P3
 * 广色域的前提下完整预览。本模块只解决当前 sRGB 结果“没有标签”的问题。
 */

type Bytes = Uint8Array<ArrayBuffer>

const u16 = (value: number): Bytes => {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, value)
  return out
}

const u32 = (value: number): Bytes => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

const ascii = (value: string): Bytes => Uint8Array.from(value, c => c.charCodeAt(0))
const pad4 = (n: number): number => (n + 3) & ~3

function concat(parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function s15(value: number): Bytes {
  return u32(Math.round(value * 65536) >>> 0)
}

function typeHeader(type: string): Bytes {
  return concat([ascii(type), new Uint8Array(4)])
}

function xyzTag(x: number, y: number, z: number): Bytes {
  return concat([typeHeader('XYZ '), s15(x), s15(y), s15(z)])
}

function textTag(value: string): Bytes {
  return concat([typeHeader('text'), ascii(value), new Uint8Array(1)])
}

function descriptionTag(value: string): Bytes {
  const text = concat([ascii(value), new Uint8Array(1)])
  return concat([
    typeHeader('desc'), u32(text.length), text,
    u32(0), u32(0), u16(0), new Uint8Array([0, 0]),
  ])
}

function sRGBCurveTag(): Bytes {
  return concat([
    typeHeader('para'), u16(3), u16(0),
    // ICC parametricCurveType function 3: sRGB transfer.
    s15(2.4), s15(1 / 1.055), s15(0.055 / 1.055), s15(1 / 12.92), s15(0.04045),
  ])
}

function sf32Tag(values: readonly number[]): Bytes {
  return concat([typeHeader('sf32'), ...values.map(s15)])
}

type IccSpec = {
  name: string
  copyright: string
  rXYZ: readonly [number, number, number]
  gXYZ: readonly [number, number, number]
  bXYZ: readonly [number, number, number]
  chad: readonly [number, number, number, number, number, number, number, number, number]
}

function createIccProfile(spec: IccSpec): Bytes {
  const tags: [string, Bytes][] = [
    ['desc', descriptionTag(spec.name)],
    ['cprt', textTag(spec.copyright)],
    ['wtpt', xyzTag(0.9642, 1, 0.8249)],
    ['rXYZ', xyzTag(...spec.rXYZ)],
    ['gXYZ', xyzTag(...spec.gXYZ)],
    ['bXYZ', xyzTag(...spec.bXYZ)],
    ['rTRC', sRGBCurveTag()],
    ['gTRC', sRGBCurveTag()],
    ['bTRC', sRGBCurveTag()],
    ['chad', sf32Tag(spec.chad)],
    ['lumi', xyzTag(0, 1, 0)],
  ]

  let dataOffset = 128 + 4 + tags.length * 12
  const entries: Bytes[] = []
  const data: Bytes[] = []
  for (const [signature, bytes] of tags) {
    dataOffset = pad4(dataOffset)
    entries.push(concat([
      ascii(signature), u32(dataOffset), u32(bytes.length),
    ]))
    data.push(bytes, new Uint8Array(pad4(bytes.length) - bytes.length))
    dataOffset += pad4(bytes.length)
  }

  const out = new Uint8Array(dataOffset)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  view.setUint32(8, 0x04300000)
  out.set(ascii('mntr'), 12)
  out.set(ascii('RGB '), 16)
  out.set(ascii('XYZ '), 20)
  view.setUint16(24, 2026)
  out[26] = 10
  out[27] = 21
  view.setUint32(36, 0x61637370) // acsp
  out.set(ascii('APPL'), 40)
  view.setUint32(64, 0)
  view.setUint32(68, Math.round(0.9642 * 65536))
  view.setUint32(72, 65536)
  view.setUint32(76, Math.round(0.8249 * 65536))
  out.set(ascii('Pink'), 80)
  view.setUint32(128, tags.length)

  let table = 132
  for (const entry of entries) {
    out.set(entry, table)
    table += entry.length
  }
  dataOffset = 128 + 4 + tags.length * 12
  for (const bytes of data) {
    out.set(bytes, dataOffset)
    dataOffset += bytes.length
  }
  return out
}

let cachedSrgbIcc: Bytes | null = null
let cachedDisplayP3Icc: Bytes | null = null

/** 生成可独立识别的 sRGB ICC v4 显示配置；字节稳定，可安全缓存。 */
export function createSrgbIccProfile(): Bytes {
  if (!cachedSrgbIcc) {
    cachedSrgbIcc = createIccProfile({
      name: 'PinkRose sRGB',
      copyright: 'PinkRose generated sRGB profile',
      // Bradford-adapted sRGB primaries to ICC D50 PCS.
      rXYZ: [0.4360747, 0.2225045, 0.0139322],
      gXYZ: [0.3850649, 0.7168786, 0.0971045],
      bXYZ: [0.1430804, 0.0606169, 0.7141733],
      chad: [
        1.0478112, 0.0228866, -0.0501270,
        0.0295424, 0.9904844, -0.0170491,
        -0.0092345, 0.0150436, 0.7521316,
      ],
    })
  }
  return cachedSrgbIcc.slice()
}

/** Display P3（D65、sRGB 传输曲线），Bradford 适配到 ICC D50 PCS。 */
export function createDisplayP3IccProfile(): Bytes {
  if (!cachedDisplayP3Icc) {
    cachedDisplayP3Icc = createIccProfile({
      name: 'PinkRose Display P3',
      copyright: 'PinkRose generated Display P3 profile',
      rXYZ: [0.5151, 0.2412, -0.0010],
      gXYZ: [0.2920, 0.6922, 0.0419],
      bXYZ: [0.1572, 0.0666, 0.7845],
      chad: [
        1.02567, 0.01304, -0.03301,
        0.02060, 0.99550, -0.01376,
        -0.00200, 0.01238, 0.80639,
      ],
    })
  }
  return cachedDisplayP3Icc.slice()
}

async function blobBytes(blob: Blob): Promise<Bytes> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer())
  }
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(blob)
    })
  }
  return new Uint8Array(await new Response(blob).arrayBuffer())
}

function jpegIccSegments(profile: Bytes): Bytes[] {
  const chunkSize = 65519
  const count = Math.ceil(profile.length / chunkSize)
  if (count < 1 || count > 255) throw new Error('ICC 配置过大，无法写入 JPG')
  const out: Bytes[] = []
  for (let i = 0; i < count; i++) {
    const chunk = profile.slice(i * chunkSize, Math.min(profile.length, (i + 1) * chunkSize))
    const payload = concat([
      ascii('ICC_PROFILE'), new Uint8Array(1),
      Uint8Array.from([i + 1, count]), chunk,
    ])
    const length = payload.length + 2
    out.push(concat([
      Uint8Array.from([0xff, 0xe2]),
      Uint8Array.from([length >> 8, length & 0xff]),
      payload,
    ]))
  }
  return out
}

/** 写入 JPG 的 APP2 ICC_PROFILE；已有 profile 会被替换而不是重复堆叠。 */
export async function injectJpegIcc(blob: Blob, profile: Bytes): Promise<Blob> {
  const bytes = await blobBytes(blob)
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return blob
  const parts: Bytes[] = [bytes.slice(0, 2), ...jpegIccSegments(profile)]
  let offset = 2
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      parts.push(bytes.slice(offset))
      offset = bytes.length
      break
    }
    const marker = bytes[offset + 1]!
    if (marker === 0xda || marker === 0xd9) {
      parts.push(bytes.slice(offset))
      offset = bytes.length
      break
    }
    if (marker >= 0xd0 && marker <= 0xd8) {
      parts.push(bytes.slice(offset, offset + 2))
      offset += 2
      continue
    }
    if (offset + 4 > bytes.length) {
      parts.push(bytes.slice(offset))
      break
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    const end = offset + 2 + length
    if (length < 2 || end > bytes.length) {
      parts.push(bytes.slice(offset))
      break
    }
    const isIcc = marker === 0xe2
      && String.fromCharCode(...bytes.slice(offset + 4, offset + 16)) === 'ICC_PROFILE\0'
    if (!isIcc) parts.push(bytes.slice(offset, end))
    offset = end
  }
  return new Blob(parts, { type: blob.type || 'image/jpeg' })
}

let crcTable: Uint32Array | null = null

function crc32(bytes: Bytes): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function zlibStore(bytes: Bytes): Bytes {
  const out: number[] = [0x78, 0x01]
  let offset = 0
  do {
    const size = Math.min(65535, bytes.length - offset)
    const final = offset + size >= bytes.length
    out.push(final ? 1 : 0, size & 0xff, size >> 8, (~size) & 0xff, ((~size) >> 8) & 0xff)
    for (let i = 0; i < size; i++) out.push(bytes[offset + i]!)
    offset += size
  } while (offset < bytes.length)
  let a = 1
  let b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  out.push((b >>> 8) & 0xff, b & 0xff, (a >>> 8) & 0xff, a & 0xff)
  return Uint8Array.from(out)
}

function pngChunk(type: string, data: Bytes): Bytes {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(ascii(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.slice(4, 8 + data.length)))
  return out
}

/** 写入 PNG iCCP；编码使用合法的 zlib stored block，不依赖 CompressionStream。 */
export async function injectPngIcc(blob: Blob, profile: Bytes): Promise<Blob> {
  const bytes = await blobBytes(blob)
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!signature.every((v, i) => bytes[i] === v)) return blob
  const profileName = concat([ascii('PinkRose sRGB'), new Uint8Array(1)])
  const iccp = pngChunk('iCCP', concat([profileName, new Uint8Array([0]), zlibStore(profile)]))
  const parts: Bytes[] = [signature]
  let offset = 8
  let inserted = false
  while (offset + 12 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 12)
    const length = view.getUint32(0)
    const end = offset + 12 + length
    if (end > bytes.length) return blob
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8))
    if (type !== 'iCCP') parts.push(bytes.slice(offset, end))
    if (type === 'IHDR' && !inserted) {
      parts.push(iccp)
      inserted = true
    }
    offset = end
  }
  if (offset < bytes.length) parts.push(bytes.slice(offset))
  return new Blob(parts, { type: blob.type || 'image/png' })
}

/** 写入 PNG eXIf；同一文件只保留一份。 */
export async function injectPngExif(blob: Blob, exif: Bytes): Promise<Blob> {
  const bytes = await blobBytes(blob)
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!signature.every((value, index) => bytes[index] === value)) return blob
  const chunk = pngChunk('eXIf', exif)
  const parts: Bytes[] = [signature]
  let offset = 8
  let inserted = false
  while (offset + 12 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 12)
    const length = view.getUint32(0)
    const end = offset + 12 + length
    if (end > bytes.length) return blob
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8))
    if (type !== 'eXIf') parts.push(bytes.slice(offset, end))
    if (type === 'IHDR' && !inserted) {
      parts.push(chunk)
      inserted = true
    }
    offset = end
  }
  if (offset < bytes.length) parts.push(bytes.slice(offset))
  return new Blob(parts, { type: blob.type || 'image/png' })
}

type WebpChunk = { type: string; bytes: Bytes; data: Bytes }

function readWebpChunks(bytes: Bytes): WebpChunk[] {
  const chunks: WebpChunk[] = []
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8)
    const length = view.getUint32(4, true)
    const end = offset + 8 + length + (length & 1)
    if (end > bytes.length) break
    chunks.push({
      type: String.fromCharCode(...bytes.slice(offset, offset + 4)),
      bytes: bytes.slice(offset, end),
      data: bytes.slice(offset + 8, offset + 8 + length),
    })
    offset = end
  }
  return chunks
}

function u24le(value: number): Bytes {
  return Uint8Array.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff])
}

function u32le(value: number): Bytes {
  return Uint8Array.from([
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
  ])
}

function webpChunk(type: string, data: Bytes): Bytes {
  const padding = new Uint8Array(data.length & 1)
  return concat([ascii(type), u32le(data.length), data, padding])
}

function webpDimensions(chunks: readonly WebpChunk[]): { width: number; height: number } | null {
  for (const chunk of chunks) {
    const data = chunk.data
    if (chunk.type === 'VP8X' && data.length >= 10) {
      return {
        width: 1 + data[4]! + data[5]! * 256 + data[6]! * 65536,
        height: 1 + data[7]! + data[8]! * 256 + data[9]! * 65536,
      }
    }
    if (chunk.type === 'VP8L' && data.length >= 5 && data[0] === 0x2f) {
      const bits = data[1]! | data[2]! << 8 | data[3]! << 16 | data[4]! << 24
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
    }
    if (chunk.type === 'VP8 ' && data.length >= 10
      && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
      return {
        width: (data[6]! | data[7]! << 8) & 0x3fff,
        height: (data[8]! | data[9]! << 8) & 0x3fff,
      }
    }
  }
  return null
}

/** 写入 WebP ICCP；没有 VP8X 时先补一个声明 ICC 的扩展头。 */
export async function injectWebpIcc(blob: Blob, profile: Bytes): Promise<Blob> {
  const bytes = await blobBytes(blob)
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF'
    || String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') return blob
  const chunks = readWebpChunks(bytes)
  const dimensions = webpDimensions(chunks)
  if (!dimensions) return blob

  let hasVp8x = false
  const normalized: WebpChunk[] = []
  for (const chunk of chunks) {
    if (chunk.type === 'ICCP') continue
    if (chunk.type === 'VP8X') {
      hasVp8x = true
      const data = chunk.data.slice()
      data[0] = (data[0] ?? 0) | 0x20
      normalized.push({ ...chunk, data, bytes: webpChunk('VP8X', data) })
    } else {
      normalized.push(chunk)
    }
  }
  const vp8x = hasVp8x ? null : webpChunk('VP8X', concat([
    Uint8Array.from([0x20, 0, 0, 0]),
    u24le(dimensions.width - 1), u24le(dimensions.height - 1),
  ]))
  const iccp = webpChunk('ICCP', profile)
  const bodyParts: Bytes[] = []
  if (vp8x) bodyParts.push(vp8x, iccp)
  for (const chunk of normalized) {
    bodyParts.push(chunk.bytes)
    if (chunk.type === 'VP8X' && !vp8x) bodyParts.push(iccp)
  }
  const body = concat(bodyParts)
  const out = concat([
    ascii('RIFF'), u32le(body.length + 4), ascii('WEBP'), body,
  ])
  return new Blob([out], { type: blob.type || 'image/webp' })
}

/** 写入 WebP EXIF，并确保 VP8X 标志声明 EXIF 存在。 */
export async function injectWebpExif(blob: Blob, exif: Bytes): Promise<Blob> {
  const bytes = await blobBytes(blob)
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF'
    || String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') return blob
  const chunks = readWebpChunks(bytes)
  const dimensions = webpDimensions(chunks)
  if (!dimensions) return blob

  let hasVp8x = false
  const normalized: WebpChunk[] = []
  for (const chunk of chunks) {
    if (chunk.type === 'EXIF') continue
    if (chunk.type === 'VP8X') {
      hasVp8x = true
      const data = chunk.data.slice()
      data[0] = (data[0] ?? 0) | 0x08
      normalized.push({ ...chunk, data, bytes: webpChunk('VP8X', data) })
    } else {
      normalized.push(chunk)
    }
  }
  const vp8x = hasVp8x ? null : webpChunk('VP8X', concat([
    Uint8Array.from([0x08, 0, 0, 0]),
    u24le(dimensions.width - 1), u24le(dimensions.height - 1),
  ]))
  const exifChunk = webpChunk('EXIF', exif)
  const bodyParts: Bytes[] = []
  if (vp8x) bodyParts.push(vp8x)
  let inserted = false
  for (const chunk of normalized) {
    if (chunk.type === 'XMP ' && !inserted) {
      bodyParts.push(exifChunk)
      inserted = true
    }
    bodyParts.push(chunk.bytes)
  }
  if (!inserted) bodyParts.push(exifChunk)
  const body = concat(bodyParts)
  const out = concat([
    ascii('RIFF'), u32le(body.length + 4), ascii('WEBP'), body,
  ])
  return new Blob([out], { type: blob.type || 'image/webp' })
}

export const SRGB_ICC_PROFILE = createSrgbIccProfile()

export function supportsEmbeddedColorProfile(format: string): boolean {
  return format === 'image/jpeg' || format === 'image/png'
    || format === 'image/webp' || format === 'image/tiff'
}
