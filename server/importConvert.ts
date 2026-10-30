/**
 * 普通照片上传的服务端解码兜底。
 *
 * 只在浏览器原生 `createImageBitmap` 与 `<img>` 都失败后调用，而且只接收
 * HEIC / RAW / TIFF。转换结果固定 JPEG 92%，图片仍在本机处理。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { HttpError } from './http.ts'
import {
  imageFileFormat, RAW_EXTENSIONS, type ImageFileFormat,
} from '../shared/imageFormats.ts'
import {
  convertImageFile, detectImageConverters, isJpegBytes, runImageConverter,
  type ImageConverter,
} from './imageConverter.ts'

/** iPhone 48MP ProRAW 可能超过旧 64MB 上限；二进制上传后留到 128MB。 */
export const IMPORT_SOURCE_LIMIT = 128 * 1024 * 1024

const DATA_URL = /^data:[^,]*;base64,([A-Za-z0-9+/=]*)$/
const CONVERT_EXTS = new Set([
  '.heic', '.heif', '.tif', '.tiff',
  ...RAW_EXTENSIONS,
])

export type ImportConverter = ImageConverter
export type ImportCapability = {
  raw: boolean
  heic: boolean
  tiff: boolean
  converters: string[]
  maxBytes: number
}

type ImportRequest = {
  buffer: Buffer
  name: string
  ext: string
}

function validateImportSource(buffer: Buffer, rawName: string): ImportRequest {
  const name = rawName.trim()
  const ext = extname(name).toLowerCase()
  if (!name || !CONVERT_EXTS.has(ext)) {
    throw new HttpError(
      'BAD_REQUEST',
      '这张图不需要服务端转换。只支持 HEIC / RAW / TIFF 兜底。',
      400,
    )
  }
  if (buffer.length === 0) {
    throw new HttpError('BAD_REQUEST', '这张图是空的。', 400)
  }
  if (buffer.length > IMPORT_SOURCE_LIMIT) {
    throw new HttpError('BAD_REQUEST', '这张图超过 128MB，先在相机或照片应用里导出 JPG。', 413)
  }
  return { buffer, name, ext }
}

export function parseImportRequest(raw: unknown): ImportRequest {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  if (typeof body.image !== 'string') {
    throw new HttpError('BAD_REQUEST', '没有收到要打开的图片。', 400)
  }
  const match = DATA_URL.exec(body.image)
  if (!match) {
    throw new HttpError('BAD_REQUEST', '照片内容不是合法图片。', 400)
  }
  return validateImportSource(
    Buffer.from(match[1]!, 'base64'),
    typeof body.name === 'string' ? body.name : '',
  )
}

let cachedConverters: Promise<ImportConverter[]> | null = null

function convertersOrNone(): Promise<ImportConverter[]> {
  if (!cachedConverters) cachedConverters = detectImageConverters()
  return cachedConverters
}

function formatForExt(ext: string): ImageFileFormat {
  return imageFileFormat(`photo${ext}`) ?? 'tiff'
}

function supports(converter: ImportConverter, format: ImageFileFormat): boolean {
  return !converter.formats || converter.formats.includes(format)
}

export async function getImportCapability(options: {
  converters?: readonly ImportConverter[]
} = {}): Promise<ImportCapability> {
  const converters = options.converters ?? await convertersOrNone()
  return {
    raw: converters.some(converter => supports(converter, 'raw')),
    heic: converters.some(converter => supports(converter, 'heic')),
    tiff: converters.some(converter => supports(converter, 'tiff')),
    converters: [...new Set(converters.map(converter => converter.kind))],
    maxBytes: IMPORT_SOURCE_LIMIT,
  }
}

export async function convertImportToJpeg(
  raw: unknown,
  options: {
    converter?: ImportConverter | null
    converters?: readonly ImportConverter[]
    run?: typeof runImageConverter
  } = {},
): Promise<Uint8Array> {
  return convertImportRequest(parseImportRequest(raw), options)
}

export async function convertImportBytesToJpeg(
  buffer: Buffer,
  name: string,
  options: {
    converter?: ImportConverter | null
    converters?: readonly ImportConverter[]
    run?: typeof runImageConverter
  } = {},
): Promise<Uint8Array> {
  return convertImportRequest(validateImportSource(buffer, name), options)
}

async function convertImportRequest(
  request: ImportRequest,
  options: {
    converter?: ImportConverter | null
    converters?: readonly ImportConverter[]
    run?: typeof runImageConverter
  },
): Promise<Uint8Array> {
  const converters = options.converters
    ?? (options.converter !== undefined
      ? options.converter ? [options.converter] : []
      : await convertersOrNone())
  const applicable = converters.filter(item =>
    supports(item, formatForExt(request.ext)))
  if (applicable.length === 0) {
    throw new HttpError(
      'INTERNAL',
      '浏览器打不开这张图，这台电脑也没有能处理这个格式的转换器。先在照片应用里导出 JPG，或安装 RawTherapee / darktable / LibRaw。',
      503,
    )
  }
  const run = options.run ?? runImageConverter
  const dir = await mkdtemp(join(tmpdir(), 'pinkrose-import-'))
  const input = join(dir, `in${request.ext}`)
  const output = join(dir, 'out.jpg')
  try {
    await writeFile(input, request.buffer)
    for (const converter of applicable) {
      await rm(output, { force: true }).catch(() => {})
      try {
        await convertImageFile(converter, input, output, 120_000, run)
        const bytes = await readFile(output).catch(() => null)
        if (bytes && isJpegBytes(bytes)) return new Uint8Array(bytes)
      } catch {
        // 同一个文件交给下一个已安装的转换器；最终仍失败再给用户可执行提示。
      }
    }
    throw new HttpError(
      'BAD_REQUEST',
      `这台电脑的转换器都没打开 ${request.name}。先在照片应用里导出 JPG，再传一次。`,
      422,
    )
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
