import piexif from 'piexifjs'
import { makeCanvas } from '../core/canvas'
import {
  drawWatermark, hasWatermark,
  type WatermarkLogo, type WatermarkOptions,
} from '../image/watermark'
import {
  createDisplayP3IccProfile, injectJpegIcc, injectPngIcc, injectWebpIcc,
  injectPngExif, injectWebpExif, SRGB_ICC_PROFILE,
} from './colorProfile'
import { convertSrgbPixelsToDisplayP3 } from './p3'
import type { TiffMetadata } from './tiff'

type ExifDict = ReturnType<typeof piexif.load>

export type ExportFormat =
  'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif' | 'image/heic' | 'image/tiff'
export type ExportAspect = 'original' | '1:1' | '4:5' | '3:4' | '4:3' | '9:16' | '16:9'
export type ExportFit = 'crop' | 'blur' | 'mirror'
export type ExportColorSpace = 'srgb' | 'display-p3'

export type ExportRights = {
  /** 作者 / 摄影师，写入 EXIF Artist 与 TIFF Artist。 */
  creator?: string
  /** 版权声明，写入 EXIF Copyright 与 TIFF Copyright。 */
  copyright?: string
}

/** 导出设置 —— 只作用于「把图给我」那条路（下载 / 分享）；存进作品集仍走 JPEG。 */
export type ExportOptions = ExportRights & {
  format: ExportFormat
  /** 60~100。PNG 无损，忽略这个值。 */
  qualityPct: number
  /** 长边上限；null = 原尺寸。小于原图时等比缩小，从不放大。 */
  longEdge: number | null
  /** 导出前的居中裁切比例；缺省 / original = 保持当前画布。 */
  aspect?: ExportAspect
  /** 非原图比例时：裁切 / 模糊扩展 / 镜像扩展。 */
  fit?: ExportFit
  /** 是否把原图拍摄信息写回 JPG / PNG / WebP / TIFF；缺省 / true = 保留。 */
  preserveMetadata?: boolean
  /** 保留拍摄信息时是否连 GPS 也保留；缺省 / true = 保留。 */
  preserveLocation?: boolean
  /** 导出色彩空间；默认 sRGB。P3 只改变数值和 ICC，不扩大当前 sRGB 编辑色域。 */
  colorSpace?: ExportColorSpace
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: 'image/jpeg', qualityPct: 95, longEdge: null, aspect: 'original', fit: 'crop',
  preserveMetadata: true, preserveLocation: true, colorSpace: 'srgb',
  creator: '', copyright: '',
}

const ASPECT_RATIO: Record<Exclude<ExportAspect, 'original'>, number> = {
  '1:1': 1,
  '4:5': 4 / 5,
  '3:4': 3 / 4,
  '4:3': 4 / 3,
  '9:16': 9 / 16,
  '16:9': 16 / 9,
}

export function exportAspectRatio(aspect: Exclude<ExportAspect, 'original'>): number {
  return ASPECT_RATIO[aspect]
}

/** 居中取最大目标比例区域；original / 非法尺寸原样返回。 */
export function cropRectForAspect(
  width: number, height: number, aspect: ExportAspect,
): { x: number; y: number; w: number; h: number } {
  if (aspect === 'original' || width <= 0 || height <= 0) {
    return { x: 0, y: 0, w: Math.max(1, width), h: Math.max(1, height) }
  }
  const target = ASPECT_RATIO[aspect]
  let w = width
  let h = height
  if (width / height > target) w = height * target
  else h = width / target
  w = Math.max(1, Math.round(w))
  h = Math.max(1, Math.round(h))
  return {
    x: Math.max(0, Math.floor((width - w) / 2)),
    y: Math.max(0, Math.floor((height - h) / 2)),
    w, h,
  }
}

/**
 * ★ 2026-10-17（透明抠图）：JPEG 没有 alpha，先把图铺到白底上再编码。
 * PNG / WebP 原样走，保留透明通道。
 */
export function flattenToWhite(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const { canvas: out, ctx } = makeCanvas(canvas.width, canvas.height, '铺不了白底')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(canvas, 0, 0)
  return out
}

/**
 * 导出前把水印画到一张副本上。
 *
 * 不能直接画在舞台画布上：那会把水印烤进用户眼前的底图，下一次再改就没有退路。
 * 没有文字 / 没有 Logo 时原样返回，和加这个功能之前逐字节一致。
 */
export function markExportCanvas(
  source: HTMLCanvasElement,
  watermark: WatermarkOptions | null | undefined,
  logo?: WatermarkLogo | null,
): HTMLCanvasElement {
  if (!hasWatermark(watermark, logo)) return source
  const { canvas, ctx } = makeCanvas(source.width, source.height, '加不上水印')
  ctx.drawImage(source, 0, 0)
  drawWatermark(canvas, watermark, logo)
  return canvas
}

export function canvasForColorSpace(
  source: HTMLCanvasElement,
  colorSpace: ExportColorSpace,
): HTMLCanvasElement {
  if (colorSpace === 'srgb') return source
  const { canvas, ctx } = makeCanvas(
    source.width, source.height, '换不了导出色彩空间', { willReadFrequently: true },
  )
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, source.width, source.height)
  convertSrgbPixelsToDisplayP3(image.data)
  ctx.putImageData(image, 0, 0)
  return canvas
}

/** 按长边上限算导出尺寸。纯函数，单位是像素。 */
export function exportSize(
  width: number, height: number, longEdge: number | null, allowUpscale = false,
): { width: number; height: number } {
  if (!Number.isFinite(longEdge) || longEdge === null || longEdge <= 0
    || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width, height }
  }
  const scale = longEdge / Math.max(width, height)
  if (scale >= 1 && !allowUpscale) return { width, height }
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** 自定义文件名只保留安全字符，避免下载时被浏览器 / 系统截断或当成路径。 */
function safeFilenameStem(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .slice(0, 80)
    .trim()
}

export function buildFilename(
  original: string, format: ExportFormat, customStem = '',
): string {
  const ext = format === 'image/png' ? 'png'
    : format === 'image/webp' ? 'webp'
      : format === 'image/avif' ? 'avif'
        : format === 'image/heic' ? 'heic'
          : format === 'image/tiff' ? 'tif'
            : 'jpg'
  const custom = safeFilenameStem(customStem).replace(/\.[^.]+$/, '')
  const stem = custom || `${original.replace(/\.[^.]+$/, '')}_pinkrose`
  return `${stem}.${ext}`
}

/**
 * 画布 → 可导出的 blob（JPG / PNG / WebP / TIFF 把原图拍摄信息写回去）。
 *
 * **分享和下载共用这一步**，所以它只管做图、不管图去哪。分成"做图"和
 * "送出去"两件事，是因为同一次导出可能先试分享、失败再退回下载 ——
 * 那不该把图重做一遍。
 *
 * 为什么要写回 EXIF：canvas.toBlob() 产出的图不带原始 EXIF，
 * 拍摄时间和 GPS 会丢，而旅游照的时间地点对用户有意义。
 */
export async function buildExportBlob(
  canvas: HTMLCanvasElement,
  originalFile: File,
  format: ExportFormat = 'image/jpeg',
  quality = 0.95,
  preserveMetadata = true,
  colorSpace: ExportColorSpace = 'srgb',
  preserveLocation = true,
  rights: ExportRights = {},
): Promise<Blob> {
  if (format === 'image/avif') {
    const { encodeAvif } = await import('./avif')
    return encodeAvif(canvas, quality)
  }
  if (format === 'image/heic') {
    const { encodeHeic } = await import('./heic')
    return encodeHeic(canvas, quality)
  }
  if (format === 'image/tiff') {
    const { encodeTiff } = await import('./tiff')
    let metadata: TiffMetadata | undefined
    const safeRights = rightsToTiffMetadata(rights)
    if (preserveMetadata) {
      metadata = Object.keys(safeRights).length > 0 ? { ...safeRights } : undefined
      try {
        metadata = {
          ...exifToTiffMetadata(await readExifObject(originalFile), preserveLocation),
          ...safeRights,
        }
      } catch (e) {
        console.warn('TIFF 原照片信息读取失败，照常导出（用户填写的权利信息仍保留）', e)
      }
    }
    return encodeTiff(canvasForColorSpace(canvas, colorSpace), {
      iccProfile: colorSpace === 'display-p3'
        ? createDisplayP3IccProfile()
        : SRGB_ICC_PROFILE,
      ...(metadata ? { metadata } : {}),
    })
  }
  const encoded = canvasForColorSpace(canvas, colorSpace)
  const source = format === 'image/jpeg' ? flattenToWhite(encoded) : encoded
  const blob = await new Promise<Blob | null>(res => source.toBlob(res, format, quality))
  if (!blob) throw new Error('导出失败：canvas 没有产出图片')
  const withMetadata = await attachExifMetadata(
    blob, originalFile, preserveMetadata, preserveLocation, rights,
  )
  const profile = colorSpace === 'display-p3'
    ? createDisplayP3IccProfile()
    : SRGB_ICC_PROFILE
  if (format === 'image/jpeg') return injectJpegIcc(withMetadata, profile)
  if (format === 'image/png') return injectPngIcc(withMetadata, profile)
  if (format === 'image/webp') return injectWebpIcc(withMetadata, profile)
  return withMetadata
}

/** 按用户选择决定是否写回 EXIF；失败时降级为无拍摄信息，绝不挡导出。 */
export async function attachExifMetadata(
  blob: Blob,
  originalFile: File,
  preserveMetadata = true,
  preserveLocation = true,
  rights: ExportRights = {},
): Promise<Blob> {
  if (!preserveMetadata
    || (blob.type !== 'image/jpeg' && blob.type !== 'image/png' && blob.type !== 'image/webp')) {
    return blob
  }
  try {
    return await withExif(blob, originalFile, preserveLocation, rights)
  } catch (e) {
    // EXIF 写回失败不该挡住用户拿到图，降级为不带 EXIF 保存
    console.warn('EXIF 写回失败，照常导出（无 EXIF）', e)
    return blob
  }
}

/** 任意 Blob → 存成文件。图片、ZIP、预设 JSON 共用这一条下载通道。 */
export function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // 不能在这里同步 revoke：Safari 有「同一个任务里被 revoke 的下载会被取消」
  // 的历史问题，而重编码后的 12–48 MP JPEG 正是那种大 blob。保存又是本产品
  // 在 iPhone 上的终点动作，赌不起——推迟到下载真正开始之后再释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 图片下载 —— 保留原来的名字，行为就是 `downloadFile`。 */
export function downloadImage(blob: Blob, filename: string): void {
  downloadFile(blob, filename)
}

/** 浏览器给的那两个口子。lib.dom 里未必有，这里自己声明最小用得到的形状。 */
type ShareNavigator = {
  canShare?: (data: { files?: File[] }) => boolean
  share?: (data: { files?: File[] }) => Promise<void>
}

export type ShareOutcome = 'shared' | 'cancelled'

/**
 * 这台设备能不能把**图片**交给系统分享面板。
 *
 * **必须用 `canShare` 问，不能只看 `navigator.share` 在不在。** 桌面 Chrome
 * 就是反例：它的 `share` 在，但只能分享文字和链接。只看 share 存不存在，
 * 桌面上就会多出一个"分享"按钮，点下去弹出一个**分享不了图片**的面板 ——
 * 比没有这个按钮还糟。
 *
 * 探测要用一个**真的图片文件**去问：不带 files 的 canShare 只回答
 * "能不能分享文字"。
 *
 * 探测本身失败（老浏览器、隐私模式、异常）一律按"不能分享"处理：
 * 大不了退回下载，不该让整个页面挂掉。
 */
export function canShareImage(): boolean {
  return canShareFile(new Blob([], { type: 'image/jpeg' }), 'probe.jpg')
}

/**
 * 任意文件能不能交给系统分享面板。ZIP 等非图片文件不能复用图片探针：
 * 部分浏览器只开放图片分享，必须用真实 MIME 和扩展名询问。
 */
export function canShareFile(blob: Blob, filename: string): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as unknown as ShareNavigator
  if (typeof nav.canShare !== 'function' || typeof nav.share !== 'function') return false
  try {
    return nav.canShare({
      files: [new File([blob], filename, { type: blob.type || 'application/octet-stream' })],
    })
  } catch {
    return false
  }
}

/**
 * blob → 系统分享面板（手机上一步就能选微信）。
 *
 * **用户自己关掉面板不算失败**：那种情况下 resolve，什么都不做。
 * 当成失败处理的话，用户每次取消都会被弹一句错误、还会白下载一份 ——
 * 恰好是他刚刚表示不想要的东西。
 *
 * 真正失败（权限、系统拒绝、面板崩了）才往外抛，由调用方决定怎么办
 * （现在的做法是退回下载，至少让他拿得到图）。
 */
export async function shareImage(blob: Blob, filename: string): Promise<void> {
  await shareFile(blob, filename)
}

/**
 * 任意 Blob → 系统分享；取消仍是正常结束，真正失败才抛。
 *
 * 返回 `shared` / `cancelled` 是为了让调用方能在用户主动关掉面板时保持安静，
 * 又能在真正分享成功后给出准确回执。调用方不该把这两种结果都当成失败。
 */
export async function shareFile(blob: Blob, filename: string): Promise<ShareOutcome> {
  const nav = navigator as unknown as ShareNavigator
  if (typeof nav.share !== 'function') throw new Error('这台设备不支持分享')
  const file = new File([blob], filename, {
    type: blob.type || 'application/octet-stream',
  })
  try {
    await nav.share({ files: [file] })
    return 'shared'
  } catch (e) {
    // AbortError = 用户自己取消。不是错误，别往外抛。
    if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
    throw e
  }
}

type ClipboardNavigator = {
  clipboard?: { write?: (items: ClipboardItem[]) => Promise<void> }
}

/** 这台设备能不能把图片写进系统剪贴板。 */
export function canCopyImage(): boolean {
  if (typeof navigator === 'undefined' || typeof ClipboardItem === 'undefined') return false
  return typeof (navigator as unknown as ClipboardNavigator).clipboard?.write === 'function'
}

async function clipboardPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  try {
    const { canvas, ctx } = makeCanvas(
      bitmap.width, bitmap.height, '复制不了这张图',
    )
    ctx.drawImage(bitmap, 0, 0)
    const png = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'))
    if (!png) throw new Error('复制时 PNG 编码失败')
    return injectPngIcc(png, SRGB_ICC_PROFILE)
  } finally {
    bitmap.close()
  }
}

/**
 * 把图片放进系统剪贴板。统一用 PNG：Safari 的 ClipboardItem 只稳定支持
 * image/png；值先给 Promise，避免用户在异步编码后才失去剪贴板写权限。
 */
export async function copyImage(blob: Blob): Promise<void> {
  if (!canCopyImage()) throw new Error('这台设备不支持复制图片')
  const png: Blob | Promise<Blob> =
    blob.type === 'image/png' ? blob : clipboardPng(blob)
  const item = new ClipboardItem({ 'image/png': png })
  await (navigator as unknown as ClipboardNavigator).clipboard!.write!([item])
}

function cleanRights(rights: ExportRights): ExportRights {
  const safeText = (value: string | undefined, max: number) =>
    value?.trim().slice(0, max).replace(/[^\x09\x0a\x0d\x20-\xff]/g, '?') ?? ''
  const creator = safeText(rights.creator, 160)
  const copyright = safeText(rights.copyright, 240)
  return {
    ...(creator ? { creator } : {}),
    ...(copyright ? { copyright } : {}),
  }
}

function rightsToTiffMetadata(rights: ExportRights): TiffMetadata {
  const safe = cleanRights(rights)
  return {
    ...(safe.creator ? { artist: safe.creator } : {}),
    ...(safe.copyright ? { copyright: safe.copyright } : {}),
  }
}

async function exifString(
  originalFile: File, preserveLocation = true, rights: ExportRights = {},
): Promise<string> {
  const safeRights = cleanRights(rights)
  let exifObj: ExifDict
  try {
    exifObj = await readExifObject(originalFile)
  } catch (error) {
    // 原图可能是 PNG / WebP / 没有 EXIF 的 JPEG：原拍摄信息读不到，
    // 但用户刚填的作者 / 版权不能跟着一起丢。没有权利信息时保持原来的降级行为。
    if (!safeRights.creator && !safeRights.copyright) throw error
    exifObj = { '0th': {}, Exif: {}, GPS: {}, '1st': {} } as ExifDict
  }
  if (!preserveLocation) delete exifObj.GPS
  if (safeRights.creator || safeRights.copyright) {
    const zeroth = exifObj['0th'] ?? (exifObj['0th'] = {})
    if (safeRights.creator) zeroth[piexif.ImageIFD.Artist] = safeRights.creator
    if (safeRights.copyright) zeroth[piexif.ImageIFD.Copyright] = safeRights.copyright
  }

  // 尺寸会变，这两个字段必须清掉，否则看图软件会显示错误信息
  delete exifObj['0th']?.[piexif.ImageIFD.ImageWidth]
  delete exifObj['0th']?.[piexif.ImageIFD.ImageLength]
  delete exifObj['Exif']?.[piexif.ExifIFD.PixelXDimension]
  delete exifObj['Exif']?.[piexif.ExifIFD.PixelYDimension]

  // Orientation 也必须清掉，这条最容易漏。
  //
  // 解码时 createImageBitmap 的 imageOrientation 默认是 'from-image'，
  // 意思是**已经按 EXIF 把画面摆正了**——canvas 上是正立的像素网格。
  // 若再把原始的 Orientation=6（含义是"显示时顺时针转 90°"）写回去，
  // 看图软件会对着已经正立的图**再转一次**，导出图的方向就错了。
  //
  // 竖拍的手机照片几乎全都带 Orientation=6，所以这条不处理必然翻车。
  delete exifObj['0th']?.[piexif.ImageIFD.Orientation]

  // 原图内嵌的缩略图（IFD1）也必须清掉，这条同样容易漏。
  //
  // 两个理由：
  //   1. 它是**修改前**的画面预览。导出文件里带着一张旧预览，
  //      文件管理器/相册的缩略图模式会显示修图前的样子，与像素本身矛盾。
  //   2. piexif.dump 对缩略图有 64KB 上限，超了会抛错；那个错误会被
  //      下面的 catch 吞掉，用户拿到的就会是**完全没有 EXIF** 的文件——
  //      拍摄时间和 GPS 全丢，恰好是这个任务存在的意义所在。
  delete exifObj['1st']
  // 注：@types/piexifjs 把 thumbnail 声明成 `string`（不是 `string | null`），
  // 所以这里只能 delete，不能赋 null。对 piexif.dump 而言效果一样——
  // 它的判据是 `("thumbnail" in exif_dict) && (exif_dict["thumbnail"] != null)`
  // （piexif.js:197），删掉键与赋 null 都会让这个条件为假。
  delete exifObj.thumbnail

  return piexif.dump(exifObj)
}

async function readExifObject(originalFile: File): Promise<ExifDict> {
  return piexif.load(await blobToDataUrl(originalFile))
}

function exifNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (!Array.isArray(value) || value.length === 0) return null
  if (value.length === 1) return exifNumber(value[0])
  const numerator = exifNumber(value[0])
  const denominator = exifNumber(value[1])
  return numerator !== null && denominator !== null && denominator !== 0
    ? numerator / denominator : null
}

function exifText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\0+$/g, '').trim()
  return text || null
}

function exifGps(value: unknown, ref: unknown): number | null {
  if (!Array.isArray(value) || value.length < 3) return null
  const parts = value.slice(0, 3).map(exifNumber)
  if (parts.some(part => part === null)) return null
  const [degrees, minutes, seconds] = parts as [number, number, number]
  const coordinate = degrees + minutes / 60 + seconds / 3600
  const direction = exifText(ref)?.toUpperCase()
  return direction === 'S' || direction === 'W' ? -coordinate : coordinate
}

/** JPG / TIFF 常见的 piexif 字典 → 标准 TIFF 标签。 */
export function exifToTiffMetadata(exif: ExifDict, preserveLocation = true): TiffMetadata {
  const zeroth = exif['0th'] ?? {}
  const details = exif.Exif ?? {}
  const gps = exif.GPS ?? {}
  const lensSpec = details[piexif.ExifIFD.LensSpecification]
  const lensValues = Array.isArray(lensSpec)
    ? lensSpec.slice(0, 4).map(exifNumber)
    : []
  const latitude = exifGps(
    gps[piexif.GPSIFD.GPSLatitude],
    gps[piexif.GPSIFD.GPSLatitudeRef],
  )
  const longitude = exifGps(
    gps[piexif.GPSIFD.GPSLongitude],
    gps[piexif.GPSIFD.GPSLongitudeRef],
  )
  const altitude = exifNumber(gps[piexif.GPSIFD.GPSAltitude])
  const altitudeRef = exifNumber(gps[piexif.GPSIFD.GPSAltitudeRef])
  const metadata: TiffMetadata = {
    software: exifText(zeroth[piexif.ImageIFD.Software]) ?? 'PinkRose',
  }
  const make = exifText(zeroth[piexif.ImageIFD.Make])
  const model = exifText(zeroth[piexif.ImageIFD.Model])
  const artist = exifText(zeroth[piexif.ImageIFD.Artist])
  const copyright = exifText(zeroth[piexif.ImageIFD.Copyright])
  const description = exifText(zeroth[piexif.ImageIFD.ImageDescription])
  const dateTime = exifText(zeroth[piexif.ImageIFD.DateTime])
  const dateTimeOriginal = exifText(details[piexif.ExifIFD.DateTimeOriginal])
  if (make) metadata.make = make
  if (model) metadata.model = model
  if (artist) metadata.artist = artist
  if (copyright) metadata.copyright = copyright
  if (description) metadata.description = description
  if (dateTime) metadata.dateTime = dateTime
  if (dateTimeOriginal) metadata.dateTimeOriginal = dateTimeOriginal
  const exposure = exifNumber(details[piexif.ExifIFD.ExposureTime])
  const fNumber = exifNumber(details[piexif.ExifIFD.FNumber])
  const iso = exifNumber(details[piexif.ExifIFD.ISOSpeedRatings])
    ?? exifNumber(details[piexif.ExifIFD.ISOSpeed])
    ?? exifNumber(details[piexif.ExifIFD.StandardOutputSensitivity])
  const focalLength = exifNumber(details[piexif.ExifIFD.FocalLength])
  const focalLength35 = exifNumber(details[piexif.ExifIFD.FocalLengthIn35mmFilm])
  const whiteBalance = exifNumber(details[piexif.ExifIFD.WhiteBalance])
  const lensModel = exifText(details[piexif.ExifIFD.LensModel])
  if (exposure !== null && exposure > 0) metadata.exposureSeconds = exposure
  if (fNumber !== null && fNumber > 0) metadata.fNumber = fNumber
  if (iso !== null) metadata.iso = iso
  if (focalLength !== null && focalLength > 0) metadata.focalLength = focalLength
  if (focalLength35 !== null && focalLength35 > 0) metadata.focalLength35 = focalLength35
  if (whiteBalance !== null) metadata.whiteBalance = whiteBalance
  if (lensModel) metadata.lensModel = lensModel
  if (lensValues.length === 4 && lensValues.every(value => value !== null)) {
    metadata.lensSpecification = lensValues as [number, number, number, number]
  }
  if (preserveLocation && latitude !== null && longitude !== null
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    metadata.gps = {
      latitude,
      longitude,
      ...(altitude !== null
        ? { altitude: altitudeRef === 1 ? -altitude : altitude }
        : {}),
    }
  }
  return metadata
}

async function withExif(
  blob: Blob,
  originalFile: File,
  preserveLocation = true,
  rights: ExportRights = {},
): Promise<Blob> {
  const exif = await exifString(originalFile, preserveLocation, rights)
  if (blob.type === 'image/png' || blob.type === 'image/webp') {
    const bytes = Uint8Array.from(exif, char => char.charCodeAt(0))
    return blob.type === 'image/png'
      ? injectPngExif(blob, bytes)
      : injectWebpExif(blob, bytes)
  }
  const newDataUrl = await blobToDataUrl(blob)
  return dataUrlToBlob(piexif.insert(exif, newDataUrl))
}

/**
 * Blob → data URL —— 定义搬到 `image/blob.ts` 了（那段 `FileReader` 原来
 * 在这儿和 `prepare.ts` 各写了一份，2026-10-09 收成一份）。这里 import 完
 * 再转出去，免得调用方为了一个函数多认一个模块。
 */
import { blobToDataUrl } from '../image/blob'
export { blobToDataUrl }

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',')
  const mime = head.match(/:(.*?);/)?.[1] ?? 'image/jpeg'
  const bin = atob(body)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}
