import { makeCanvas } from '../core/canvas'
import { blobToDataUrl } from './blob'
import { findEmbeddedJpegPreview } from './rawPreview'
import { detectSourceColorProfile, type SourceColorProfile } from './sourceProfile'
import { isRawFileName, isRawMime, RAW_FILE_ACCEPT } from '../../shared/imageFormats.ts'

/**
 * 尺寸数学（MAX_DIMENSION / SIZE_MIN / SIZE_MAX / align32 / fitWithin / Size）
 * 已经搬到 `shared/size.ts`——后端也要用它，而 shared/ 是前后端共同的地盘。
 * 这里原样转发，计划一的调用方和测试都不用改。
 */
export {
  MAX_DIMENSION, SIZE_MIN, SIZE_MAX,
  align32, fitWithin, type Size,
} from '../../shared/size.ts'

export type DecodedImage = {
  /** 调用方负责在不再使用时调用 bitmap.close()——它占用的是 GPU 内存 */
  bitmap: ImageBitmap
  width: number
  height: number
  /** RAW 走的是相机内嵌 JPEG 预览（不是完整 RAW 解档）。 */
  rawPreview?: { width: number; height: number }
  /** 源文件声明的色彩空间；编辑链仍统一转到 sRGB。 */
  sourceColorProfile?: SourceColorProfile
}

type DecodedBitmap = {
  bitmap: ImageBitmap
  rawPreview?: { width: number; height: number }
}

export function isHeicFile(file: Pick<File, 'name' | 'type'>): boolean {
  return /\.(?:heic|heif)$/i.test(file.name)
    || /^image\/hei[cf](?:-sequence)?$/i.test(file.type)
}

export function isRawFile(file: Pick<File, 'name' | 'type'>): boolean {
  return isRawFileName(file.name) || isRawMime(file.type)
}

export function isTiffFile(file: Pick<File, 'name' | 'type'>): boolean {
  return /\.(?:tif|tiff)$/i.test(file.name) || /^image\/tiff$/i.test(file.type)
}

/** 这些格式不能可靠地直接交给 `<img>` 当缩略图，要先走本机统一解码。 */
export function needsDecodedImagePreview(file: Pick<File, 'name' | 'type'>): boolean {
  return isHeicFile(file) || isRawFile(file) || isTiffFile(file)
}

/** 主上传 / 批量文件框共用；RAW 的 MIME 常为空，必须靠扩展名放行。 */
export const PHOTO_FILE_ACCEPT =
  `image/*,.heic,.heif,.tif,.tiff,${RAW_FILE_ACCEPT}`

export function imageDecodeFailureText(file: Pick<File, 'name' | 'type'>): string {
  if (isHeicFile(file)) {
    return '这张 HEIC 打不开。Mac / iPhone 上用 Safari 通常能直接打开；也可以先用「照片」导出成 JPG，再传一次。'
  }
  if (isRawFile(file)) {
    return '这张 RAW 打不开，里面也没找到可用的相机预览。' +
      '先用相机厂商软件导出 JPG / TIFF，或在 Mac 上用 Safari 再试。'
  }
  if (isTiffFile(file)) {
    return '这张 TIFF 浏览器支持不一致。先导出 JPG / PNG 再传。'
  }
  return '这张图打不开，换一张试试'
}

/**
 * 解码用户选的文件。
 *
 * 关键：iPhone 拍的照片是 Display P3 色域，直接当 sRGB 用会让红色发暗、
 * 绿色发艳。这里用 createImageBitmap 的 colorSpaceConversion 让浏览器
 * 完成 P3 -> sRGB 转换（spec §5.3）。
 */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  const profilePromise = detectSourceColorProfile(file)
  const raw = await decodeToBitmap(file)
  try {
    const bitmap = await toSrgbBitmap(raw.bitmap)
    const sourceColorProfile = await profilePromise
    return {
      bitmap, width: bitmap.width, height: bitmap.height,
      ...(raw.rawPreview ? { rawPreview: raw.rawPreview } : {}),
      ...(sourceColorProfile ? { sourceColorProfile } : {}),
    }
  } finally {
    // 必须是 finally：toSrgbBitmap 抛错时也得释放。
    // ImageBitmap 占的是 GPU 内存，泄漏几次就能把标签页拖垮。
    raw.bitmap.close()
  }
}

/**
 * 给工作区选片列表生成可显示的预览。RAW / HEIC / TIFF 先走与编辑器相同的
 * 本机解码链，再压成 JPEG object URL；最终导出仍使用原文件，不拿预览冒充成片。
 */
export async function createDecodedImagePreview(
  file: File,
): Promise<{ url: string; width: number; height: number }> {
  const decoded = await decodeImageFile(file)
  try {
    const { canvas, ctx } = makeCanvas(decoded.width, decoded.height, '这张照片做不出预览')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, decoded.width, decoded.height)
    ctx.drawImage(decoded.bitmap, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        made => made ? resolve(made) : reject(new Error('这张照片做不出预览')),
        'image/jpeg',
        0.9,
      )
    })
    return {
      url: URL.createObjectURL(blob),
      width: decoded.width,
      height: decoded.height,
    }
  } finally {
    decoded.bitmap.close()
  }
}

/**
 * 先走 `createImageBitmap`，失败时再用 `<img>` 解一次。
 *
 * `createImageBitmap` 在 Safari 上对某些系统图片格式的支持和 `<img>` 不是
 * 同一套：浏览器能显示、却不一定能直接交成 ImageBitmap。HEIC 尤其容易落在
 * 这个缝里。这个兜底不假装所有浏览器都能解 HEIC；它只走浏览器**真的会**
 * 的那条解码路，解不开仍然会抛，由调用方给用户明确提示。
 */
async function decodeToBitmap(file: File): Promise<DecodedBitmap> {
  try {
    return { bitmap: await createImageBitmap(file, {
      colorSpaceConversion: 'default',   // 让浏览器做色彩空间转换
      premultiplyAlpha: 'none',
    }) }
  } catch (bitmapError) {
    try {
      return { bitmap: await decodeWithImageElement(file) }
    } catch (elementError) {
      try {
        if (isHeicFile(file) || isRawFile(file) || isTiffFile(file)) {
          return { bitmap: await decodeWithServerConverter(file) }
        }
      } catch (serverError) {
        if (isRawFile(file)) {
          try {
            return await decodeWithEmbeddedRawPreview(file)
          } catch (previewError) {
            const error = new Error('这张图片的解码器打不开它')
            ;(error as Error & { cause?: unknown }).cause = {
              bitmapError, elementError, serverError, previewError,
            }
            throw error
          }
        }
        const error = new Error('这张图片的解码器打不开它')
        ;(error as Error & { cause?: unknown }).cause = {
          bitmapError, elementError, serverError,
        }
        throw error
      }
      const error = new Error('这张图片的解码器打不开它')
      ;(error as Error & { cause?: unknown }).cause = { bitmapError, elementError }
      throw error
    }
  }
}

async function decodeWithEmbeddedRawPreview(file: File): Promise<DecodedBitmap> {
  const buffer = await readRawBytes(file)
  const preview = findEmbeddedJpegPreview(buffer)
  if (!preview) throw new Error('这个 RAW 里没有可用的 JPEG 预览')
  const blob = new Blob(
    [buffer.buffer.slice(preview.offset, preview.offset + preview.length) as ArrayBuffer],
    { type: 'image/jpeg' },
  )
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'default',
    premultiplyAlpha: 'none',
  })
  return {
    bitmap,
    rawPreview: { width: preview.width, height: preview.height },
  }
}

async function readRawBytes(file: File): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer())
  }
  // 老 WebKit / 测试环境不一定有 File.arrayBuffer；FileReader 是同一条数据，
  // 只是多一次 base64 编解码。只在真正需要读 RAW 预览时走到这里。
  const data = await blobToDataUrl(file)
  const body = data.slice(data.indexOf(',') + 1)
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function decodeWithServerConverter(file: File): Promise<ImageBitmap> {
  if (isRawFile(file)) {
    const capability = await fetch('/api/import/capability', {
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then(async res => res.ok
        ? await res.json() as { raw?: boolean }
        : null)
      .catch(() => null)
    // 老服务端没有这个接口时继续尝试转换，保持兼容。
    if (capability && capability.raw === false) {
      throw new Error('这台电脑没有完整的 RAW 转换器')
    }
  }
  const res = await fetch(`/api/import/convert?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as {
      error?: { message?: string }
      message?: string
    } | null
    throw new Error(detail?.error?.message ?? detail?.message ?? '本机没有打开这张图。')
  }
  const jpeg = await res.blob()
  return createImageBitmap(jpeg, {
    colorSpaceConversion: 'default',
    premultiplyAlpha: 'none',
  })
}

async function decodeWithImageElement(file: File): Promise<ImageBitmap> {
  const url = URL.createObjectURL(file)
  const img = new Image()
  try {
    img.decoding = 'async'
    img.src = url
    await img.decode()
    if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
      throw new Error('图片没有有效尺寸')
    }
    const { canvas, ctx } = makeCanvas(
      img.naturalWidth, img.naturalHeight, '打不开这张照片',
    )
    ctx.drawImage(img, 0, 0)
    return await createImageBitmap(canvas)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * 把任意色域的位图重绘到 sRGB 画布上，再取回位图。
 *
 * 转换发生在 drawImage 那一行：2D 画布会按画布自身的色彩空间
 * （这里显式指定 srgb）解释源图并写入。若源图本来已是 sRGB，
 * 这一步就是恒等转换——所以**不会转换两次**。
 *
 * 早期版本在这里还调过一次 getImageData + putImageData，是多余的：
 * 它只是把同一批字节读出来再原样写回，却要多分配一个全分辨率的
 * 缓冲区（1200 万像素的照片约 49 MB）并强制一次 GPU 回读。
 */
async function toSrgbBitmap(src: ImageBitmap): Promise<ImageBitmap> {
  const { canvas, ctx } = makeCanvas(src.width, src.height, '没法做色彩空间转换')
  ctx.drawImage(src, 0, 0)   // ← 色彩空间转换就发生在这一行
  return createImageBitmap(canvas)
}

/**
 * 说明：`align32` 与 `fitWithin` 在计划一里没有调用方，现在定义搬到了
 * `shared/size.ts`——它们服务的是生成式编辑那条路（spec §4.4），调用方出现在
 * 计划二的生成链路里，而那一路前后端都要用同一套约束，所以放在 shared/。
 * 之所以一直用测试钉着它们，是因为它们是 spec §4.3 / §4.4 那几条硬约束的
 * 可执行形式（32 的倍数、[512,4096]、长边 2048），用测试钉死比写在注释里可靠
 * ——那几条约束是真金白银试出来的。
 */
