import { makeCanvas } from '../core/canvas'

/**
 * 浏览器端 TIFF 编码器。
 *
 * 只写摄影交付最需要的基础 TIFF：8 位 RGB，或检测到透明像素时写 8 位 RGBA。
 * 一个 strip、chunky（RGBRGB…）。浏览器支持 `CompressionStream` 时写 Deflate，
 * 否则回退无压缩；兼容 Lightroom、Photoshop、macOS 预览和常见打印流程，也不会
 * 把画布再交给服务端。
 */
async function deflateBytes(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const source = new Uint8Array(data.length)
    source.set(data)
    const stream = new Blob([source]).stream().pipeThrough(new CompressionStream('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

export type TiffEncodeOptions = {
  /** 写入 TIFF tag 34675 的 ICC Profile 原始字节。 */
  iccProfile?: Uint8Array
  /** 标准 TIFF / EXIF / GPS 标签；缺省 = 只写像素和 ICC。 */
  metadata?: TiffMetadata
}

export type TiffMetadata = {
  make?: string
  model?: string
  software?: string
  artist?: string
  copyright?: string
  description?: string
  dateTime?: string
  dateTimeOriginal?: string
  exposureSeconds?: number
  fNumber?: number
  iso?: number
  focalLength?: number
  focalLength35?: number
  lensModel?: string
  lensSpecification?: [number, number, number, number]
  whiteBalance?: number
  gps?: { latitude: number; longitude: number; altitude?: number }
}

type TiffEntry = {
  tag: number
  type: 2 | 3 | 4 | 5 | 7
  count: number
  data: Uint8Array
  externalOffset?: number
}

const align4 = (value: number): number => (value + 3) & ~3

function rawEntry(
  tag: number, type: TiffEntry['type'], count: number, data: Uint8Array,
): TiffEntry {
  return { tag, type, count, data }
}

function asciiEntry(tag: number, value: string): TiffEntry {
  const bytes = new TextEncoder().encode(value.replace(/\0+$/g, '').slice(0, 2048))
  const data = new Uint8Array(bytes.length + 1)
  data.set(bytes)
  return rawEntry(tag, 2, data.length, data)
}

/** EXIF / TIFF 的标准文字字段按单字节存储；© 等 Latin-1 字符不能被 UTF-8 双字节化。 */
function latin1Entry(tag: number, value: string): TiffEntry {
  const text = value.replace(/\0+$/g, '').slice(0, 2048)
  const data = new Uint8Array(text.length + 1)
  for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i) & 0xff
  return rawEntry(tag, 2, data.length, data)
}

function shortEntry(tag: number, value: number): TiffEntry {
  const data = new Uint8Array(2)
  new DataView(data.buffer).setUint16(0, Math.max(0, Math.min(0xffff, Math.round(value))), true)
  return rawEntry(tag, 3, 1, data)
}

function longEntry(tag: number, value: number): TiffEntry {
  const data = new Uint8Array(4)
  new DataView(data.buffer).setUint32(0, value, true)
  return rawEntry(tag, 4, 1, data)
}

function rationalPair(value: number): [number, number] {
  if (!Number.isFinite(value) || value <= 0) return [0, 1]
  const integer = Math.round(value)
  if (Math.abs(value - integer) < 1e-7) return [integer, 1]
  const denominator = 10_000
  return [Math.max(1, Math.round(value * denominator)), denominator]
}

function rationalEntry(tag: number, values: readonly number[]): TiffEntry {
  const data = new Uint8Array(values.length * 8)
  const view = new DataView(data.buffer)
  values.forEach((value, index) => {
    const [numerator, denominator] = rationalPair(value)
    view.setUint32(index * 8, numerator, true)
    view.setUint32(index * 8 + 4, denominator, true)
  })
  return rawEntry(tag, 5, values.length, data)
}

function gpsParts(value: number): [number, number, number] {
  const absolute = Math.abs(value)
  const degrees = Math.floor(absolute)
  const minuteValue = (absolute - degrees) * 60
  const minutes = Math.floor(minuteValue)
  return [degrees, minutes, (minuteValue - minutes) * 60]
}

function metadataIfds(metadata: TiffMetadata | undefined): {
  image: TiffEntry[]
  exif: TiffEntry[]
  gps: TiffEntry[]
} {
  const image: TiffEntry[] = []
  const exif: TiffEntry[] = []
  const gps: TiffEntry[] = []
  if (!metadata) return { image, exif, gps }
  if (metadata.make) image.push(asciiEntry(271, metadata.make))
  if (metadata.model) image.push(asciiEntry(272, metadata.model))
  if (metadata.software) image.push(asciiEntry(305, metadata.software))
  if (metadata.artist) image.push(latin1Entry(315, metadata.artist))
  if (metadata.copyright) image.push(latin1Entry(33432, metadata.copyright))
  if (metadata.dateTime) image.push(asciiEntry(306, metadata.dateTime))
  if (metadata.description) image.push(asciiEntry(270, metadata.description))

  if (metadata.exposureSeconds !== undefined) {
    exif.push(rationalEntry(33434, [metadata.exposureSeconds]))
  }
  if (metadata.fNumber !== undefined) exif.push(rationalEntry(33437, [metadata.fNumber]))
  if (metadata.iso !== undefined) exif.push(shortEntry(34855, metadata.iso))
  if (metadata.dateTimeOriginal) exif.push(asciiEntry(36867, metadata.dateTimeOriginal))
  if (metadata.focalLength !== undefined) exif.push(rationalEntry(37386, [metadata.focalLength]))
  if (metadata.focalLength35 !== undefined) exif.push(shortEntry(41989, metadata.focalLength35))
  if (metadata.lensSpecification) {
    exif.push(rationalEntry(42034, metadata.lensSpecification))
  }
  if (metadata.lensModel) exif.push(asciiEntry(42036, metadata.lensModel))
  if (metadata.whiteBalance !== undefined) exif.push(shortEntry(41987, metadata.whiteBalance))

  if (metadata.gps) {
    const latitude = metadata.gps.latitude
    const longitude = metadata.gps.longitude
    gps.push(asciiEntry(1, latitude < 0 ? 'S' : 'N'))
    gps.push(rationalEntry(2, gpsParts(latitude)))
    gps.push(asciiEntry(3, longitude < 0 ? 'W' : 'E'))
    gps.push(rationalEntry(4, gpsParts(longitude)))
    if (metadata.gps.altitude !== undefined) {
      gps.push(shortEntry(5, metadata.gps.altitude < 0 ? 1 : 0))
      gps.push(rationalEntry(6, [Math.abs(metadata.gps.altitude)]))
    }
  }
  return { image, exif, gps }
}

function ifdSize(entries: TiffEntry[]): number {
  return entries.length ? 2 + entries.length * 12 + 4 : 0
}

export async function encodeTiff(
  canvas: HTMLCanvasElement, options: TiffEncodeOptions = {},
): Promise<Blob> {
  const width = canvas.width
  const height = canvas.height
  if (width <= 0 || height <= 0) throw new Error('TIFF 导出失败：画布尺寸无效')
  const iccProfile = options.iccProfile

  let image: ImageData
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx) {
    image = ctx.getImageData(0, 0, width, height)
  } else {
    // TonePipeline 的输出画布已经绑定了 WebGL2，规范不允许同一张画布再拿 2D
    // 上下文。先让浏览器把当前帧画到位图，再转进临时 2D 画布读像素。
    const bitmap = await createImageBitmap(canvas)
    try {
      const copy = makeCanvas(width, height, 'TIFF 导出失败：拿不到画布像素')
      copy.ctx.drawImage(bitmap, 0, 0)
      image = copy.ctx.getImageData(0, 0, width, height)
    } finally {
      bitmap.close()
    }
  }
  let hasAlpha = false
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] !== 255) {
      hasAlpha = true
      break
    }
  }

  const samples = hasAlpha ? 4 : 3
  const ifdOffset = 8
  const stripBytes = width * height * samples

  const pixels = new Uint8Array(stripBytes)
  let out = 0
  for (let i = 0; i < image.data.length; i += 4) {
    pixels[out++] = image.data[i]!
    pixels[out++] = image.data[i + 1]!
    pixels[out++] = image.data[i + 2]!
    if (hasAlpha) pixels[out++] = image.data[i + 3]!
  }
  const compressed = await deflateBytes(pixels)
  const stored = compressed && compressed.length < pixels.length ? compressed : pixels
  const compression = stored === pixels ? 1 : 8

  const bitsData = new Uint8Array(samples * 2)
  for (let i = 0; i < samples; i++) {
    new DataView(bitsData.buffer).setUint16(i * 2, 8, true)
  }
  const metadata = metadataIfds(options.metadata)
  const imageEntries: TiffEntry[] = [
    longEntry(256, width),
    longEntry(257, height),
    rawEntry(258, 3, samples, bitsData),
    shortEntry(259, compression),
    shortEntry(262, 2),
    longEntry(273, 0),
    shortEntry(277, samples),
    longEntry(278, height),
    longEntry(279, stored.length),
    shortEntry(284, 1),
    ...(hasAlpha ? [shortEntry(338, 2)] : []),
    ...metadata.image,
    ...(iccProfile ? [rawEntry(34675, 7, iccProfile.length, iccProfile)] : []),
  ]

  const imageCount = imageEntries.length
    + (metadata.exif.length ? 1 : 0)
    + (metadata.gps.length ? 1 : 0)
  const imageIfdSize = 2 + imageCount * 12 + 4
  const exifOffset = ifdOffset + imageIfdSize
  const exifSize = ifdSize(metadata.exif)
  const gpsOffset = exifOffset + exifSize
  const gpsSize = ifdSize(metadata.gps)
  if (metadata.exif.length) imageEntries.push(longEntry(34665, exifOffset))
  if (metadata.gps.length) imageEntries.push(longEntry(34853, gpsOffset))

  const tables = [
    { offset: ifdOffset, entries: imageEntries },
    ...(metadata.exif.length ? [{ offset: exifOffset, entries: metadata.exif }] : []),
    ...(metadata.gps.length ? [{ offset: gpsOffset, entries: metadata.gps }] : []),
  ]
  let externalOffset = align4(
    ifdOffset + imageIfdSize + exifSize + gpsSize,
  )
  for (const table of tables) {
    for (const item of table.entries) {
      if (item.data.length <= 4) continue
      item.externalOffset = externalOffset
      externalOffset = align4(externalOffset + item.data.length)
    }
  }
  const pixelOffset = externalOffset
  if (pixelOffset + stripBytes > 0xffff_ffff) {
    throw new Error('TIFF 导出失败：这张图超过了 TIFF 单文件 4GB 上限')
  }

  // StripOffsets is the pixel position, known only after external metadata is laid out.
  imageEntries.find(item => item.tag === 273)!.data = longEntry(
    273, pixelOffset,
  ).data

  const bytes = new Uint8Array(pixelOffset + stored.length)
  const view = new DataView(bytes.buffer)

  // TIFF header：little-endian、版本 42、第一张 IFD 紧跟在头后面。
  view.setUint16(0, 0x4949, true)
  view.setUint16(2, 42, true)
  view.setUint32(4, ifdOffset, true)
  for (const table of tables) {
    view.setUint16(table.offset, table.entries.length, true)
    table.entries.forEach((item, index) => {
      const at = table.offset + 2 + index * 12
      view.setUint16(at, item.tag, true)
      view.setUint16(at + 2, item.type, true)
      view.setUint32(at + 4, item.count, true)
      if (item.data.length <= 4) bytes.set(item.data, at + 8)
      else view.setUint32(at + 8, item.externalOffset!, true)
    })
    view.setUint32(table.offset + 2 + table.entries.length * 12, 0, true)
  }
  for (const table of tables) {
    for (const item of table.entries) {
      if (item.externalOffset !== undefined) bytes.set(item.data, item.externalOffset)
    }
  }
  bytes.set(stored, pixelOffset)

  return new Blob([bytes], { type: 'image/tiff' })
}
